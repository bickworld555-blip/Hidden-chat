package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.TrafficStats;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Phase 1 proof of concept (debug builds only, "HM Lab"): on-device voice translation, measured stage by stage.
 *
 *   decrypted audio → decode (MediaExtractor + MediaCodec) → on-device SpeechRecognizer (VoiceTranscriber, never the
 *   cloud) → ML Kit on-device translation → Android TextToSpeech with an installed, offline voice (synthesizeToFile).
 *
 * Every run reports per-stage milliseconds, this process's CPU time and peak heap, whether the phone had any network
 * at the time, and this app's network bytes during the run (should be 0). Speech recognition and speech synthesis run
 * in the system's speech services, so their memory and CPU are not in these numbers (they are in the battery report).
 * Reports go to logcat (tag HMTranslateLab) and to files/lab/reports.jsonl for `adb pull`.
 *
 * Models are never downloaded during a run unless the caller passes download=true (the one-time setup, online).
 */
final class TranslationLab {
    static final String TAG = "HMTranslateLab";

    private TranslationLab() {}

    /** Called by HiddenNativePlugin.translateVoice and TranslationLabActivity. */
    static void run(Context context, byte[] audio, String from, String to, boolean download, boolean speak, HiddenNativePlugin.LabReport report) {
        new Run(context.getApplicationContext(), audio, from, to, download, speak, report).start();
    }

    private static final class Run {
        final Context app;
        final byte[] audio;
        final String from;
        final String to;
        final boolean download;
        final boolean speak;
        final HiddenNativePlugin.LabReport report;
        final JSObject result = new JSObject();
        final JSObject stages = new JSObject();
        final Handler main = new Handler(Looper.getMainLooper());
        final AtomicLong peakJava = new AtomicLong();
        final AtomicLong peakNative = new AtomicLong();
        volatile boolean sampling = true;
        final long started = SystemClock.elapsedRealtime();
        final long cpuStarted = Process.getElapsedCpuTime();
        final long rxStarted = TrafficStats.getUidRxBytes(Process.myUid());
        final long txStarted = TrafficStats.getUidTxBytes(Process.myUid());

        Run(Context app, byte[] audio, String from, String to, boolean download, boolean speak, HiddenNativePlugin.LabReport report) {
            this.app = app;
            this.audio = audio;
            this.from = from;
            this.to = to;
            this.download = download;
            this.speak = speak;
            this.report = report;
        }

        void start() {
            ConnectivityManager connectivity = app.getSystemService(ConnectivityManager.class);
            result.put("offline", connectivity == null || connectivity.getActiveNetwork() == null);
            result.put("from", from);
            result.put("to", to);
            result.put("device", android.os.Build.MODEL + " · Android " + android.os.Build.VERSION.RELEASE);
            // Memory sampler: this process's Java and native heap every 50 ms while the run lasts.
            Thread sampler = new Thread(() -> {
                Runtime runtime = Runtime.getRuntime();
                while (sampling) {
                    peakJava.accumulateAndGet(runtime.totalMemory() - runtime.freeMemory(), Math::max);
                    peakNative.accumulateAndGet(Debug.getNativeHeapAllocatedSize(), Math::max);
                    SystemClock.sleep(50);
                }
            }, "lab-memory");
            sampler.setDaemon(true);
            sampler.start();
            new Thread(this::decode, "lab-decode").start();
        }

        void decode() {
            long at = SystemClock.elapsedRealtime();
            VoiceTranscriber.Pcm pcm;
            try {
                pcm = VoiceTranscriber.decodeBytes(app, audio);
            } catch (IOException | RuntimeException failed) {
                fail("decode_failed", "The audio could not be decoded: " + failed.getMessage());
                return;
            }
            stages.put("decodeMs", SystemClock.elapsedRealtime() - at);
            result.put("audioSeconds", Math.round(pcm.data.length / 2.0 / pcm.sampleRate * 10) / 10.0);
            long sttAt = SystemClock.elapsedRealtime();
            try {
                VoiceTranscriber.recognise(app, pcm, from, (text, error, code) -> {
                    stages.put("sttMs", SystemClock.elapsedRealtime() - sttAt);
                    if (text == null) { fail(code, error); return; }
                    result.put("transcript", text);
                    main.post(() -> translate(text));
                });
            } catch (IOException failed) {
                fail("stt_failed", failed.getMessage());
            }
        }

        void translate(String text) {
            String source = TranslateLanguage.fromLanguageTag(Locale.forLanguageTag(from).getLanguage());
            String target = TranslateLanguage.fromLanguageTag(Locale.forLanguageTag(to).getLanguage());
            if (source == null || target == null) { fail("translation_unsupported", "ML Kit can't translate " + from + " to " + to + "."); return; }
            if (source.equals(target)) { result.put("translation", text); stages.put("translateMs", 0); main.post(() -> synthesize(text)); return; }
            Translator translator = Translation.getClient(new TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build());
            RemoteModelManager models = RemoteModelManager.getInstance();
            models.getDownloadedModels(TranslateRemoteModel.class).addOnSuccessListener(downloaded -> {
                Set<String> have = new HashSet<>();
                for (TranslateRemoteModel model : downloaded) have.add(model.getLanguage());
                boolean ready = (have.contains(source) || source.equals(TranslateLanguage.ENGLISH)) && (have.contains(target) || target.equals(TranslateLanguage.ENGLISH));
                result.put("translationModelsInstalled", ready);
                if (!ready && !download) {
                    translator.close();
                    fail("translation_model_missing", "Download the " + source + "/" + target + " translation models first (run once with download=true, online).");
                    return;
                }
                long downloadAt = SystemClock.elapsedRealtime();
                translator.downloadModelIfNeeded(new DownloadConditions.Builder().build()).addOnSuccessListener(ignored -> {
                    if (!ready) stages.put("modelDownloadMs", SystemClock.elapsedRealtime() - downloadAt);
                    long at = SystemClock.elapsedRealtime();
                    translator.translate(text).addOnSuccessListener(translated -> {
                        stages.put("translateMs", SystemClock.elapsedRealtime() - at);
                        result.put("translation", translated);
                        translator.close();
                        synthesize(translated);
                    }).addOnFailureListener(failed -> { translator.close(); fail("translation_failed", failed.getMessage()); });
                }).addOnFailureListener(failed -> { translator.close(); fail("translation_model_missing", failed.getMessage()); });
            }).addOnFailureListener(failed -> { translator.close(); fail("translation_failed", failed.getMessage()); });
        }

        void synthesize(String text) {
            long initAt = SystemClock.elapsedRealtime();
            TextToSpeech[] holder = new TextToSpeech[1];
            holder[0] = new TextToSpeech(app, status -> {
                TextToSpeech tts = holder[0];
                stages.put("ttsInitMs", SystemClock.elapsedRealtime() - initAt);
                if (status != TextToSpeech.SUCCESS) { tts.shutdown(); fail("tts_unavailable", "This phone has no text-to-speech engine."); return; }
                Voice voice = offlineVoice(tts, Locale.forLanguageTag(to));
                if (voice == null) { tts.shutdown(); fail("tts_voice_missing", "No installed offline " + Locale.forLanguageTag(to).getDisplayLanguage(Locale.ENGLISH) + " voice. Install one in Android's text-to-speech settings."); return; }
                tts.setVoice(voice);
                result.put("ttsVoice", voice.getName());
                result.put("ttsEngine", tts.getDefaultEngine());
                File out = new File(labDirectory(app), "translated.wav");
                long at = SystemClock.elapsedRealtime();
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) { }
                    @Override public void onDone(String utteranceId) {
                        stages.put("ttsMs", SystemClock.elapsedRealtime() - at);
                        result.put("ttsBytes", out.length());
                        tts.shutdown();
                        if (speak) play(out);
                        finish(null, null);
                    }
                    @Override public void onError(String utteranceId) { tts.shutdown(); fail("tts_failed", "Speech synthesis failed."); }
                });
                Bundle params = new Bundle();
                tts.synthesizeToFile(text, params, out, "lab");
            });
        }

        void play(File file) {
            try {
                android.media.MediaPlayer player = new android.media.MediaPlayer();
                player.setDataSource(file.getAbsolutePath());
                player.setOnCompletionListener(android.media.MediaPlayer::release);
                player.prepare();
                player.start();
            } catch (IOException | RuntimeException ignored) {
                // Playing is only for listening during the lab; the measurement is already done.
            }
        }

        void fail(String code, String message) {
            finish(code == null ? "failed" : code, message);
        }

        synchronized void finish(String code, String message) {
            if (!sampling) return;
            sampling = false;
            long total = SystemClock.elapsedRealtime() - started;
            stages.put("totalMs", total);
            result.put("stages", stages);
            result.put("ok", code == null);
            if (code != null) { result.put("code", code); result.put("error", message); }
            result.put("cpuMs", Process.getElapsedCpuTime() - cpuStarted);
            result.put("peakJavaMb", Math.round(peakJava.get() / 1048576.0 * 10) / 10.0);
            result.put("peakNativeMb", Math.round(peakNative.get() / 1048576.0 * 10) / 10.0);
            long rx = TrafficStats.getUidRxBytes(Process.myUid()) - rxStarted;
            long tx = TrafficStats.getUidTxBytes(Process.myUid()) - txStarted;
            result.put("appNetworkBytes", rx + tx);
            Log.i(TAG, result.toString());
            try (FileWriter writer = new FileWriter(new File(labDirectory(app), "reports.jsonl"), true)) {
                writer.write(result.toString());
                writer.write('\n');
            } catch (IOException ignored) {
                // logcat still has the report.
            }
            main.post(() -> report.done(result));
        }
    }

    /** An installed voice for the language that needs no network (never a cloud voice). */
    static Voice offlineVoice(TextToSpeech tts, Locale locale) {
        Voice best = null;
        Set<Voice> voices = tts.getVoices();
        if (voices == null) return null;
        for (Voice voice : voices) {
            if (!voice.getLocale().getLanguage().equals(locale.getLanguage())) continue;
            if (voice.isNetworkConnectionRequired()) continue;
            if (voice.getFeatures() != null && voice.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            if (best == null || score(voice, locale) > score(best, locale)) best = voice;
        }
        return best;
    }

    /** The requested country first (bn-BD over bn-IN), then the engine's own quality rating. */
    private static int score(Voice voice, Locale locale) {
        boolean sameCountry = !locale.getCountry().isEmpty() && voice.getLocale().getCountry().equals(locale.getCountry());
        return (sameCountry ? 1000 : 0) + voice.getQuality();
    }

    static File labDirectory(Context context) {
        File directory = new File(context.getExternalFilesDir(null), "lab");
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        return directory;
    }
}
