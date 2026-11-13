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
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Locale;
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
                    result.put("sttEngine", code);
                    main.post(() -> translate(text));
                });
            } catch (IOException failed) {
                fail("stt_failed", failed.getMessage());
            }
        }

        void translate(String text) {
            // The app's own translator (VoiceTranslator): it never downloads during a translation. The lab's
            // download=true run fetches the two models first, timed separately.
            if (!download) { runTranslation(text); return; }
            long downloadAt = SystemClock.elapsedRealtime();
            VoiceTranslator.download(from, (ok1, e1, c1) -> VoiceTranslator.download(to, (ok2, e2, c2) -> {
                if (ok1 == null || ok2 == null) { fail(c1 != null ? c1 : c2, e1 != null ? e1 : e2); return; }
                stages.put("modelDownloadMs", SystemClock.elapsedRealtime() - downloadAt);
                runTranslation(text);
            }));
        }

        void runTranslation(String text) {
            long at = SystemClock.elapsedRealtime();
            VoiceTranslator.translate(text, from, to, (translated, error, code) -> {
                stages.put("translateMs", SystemClock.elapsedRealtime() - at);
                if (translated == null) { fail(code, error); return; }
                result.put("translation", translated);
                main.post(() -> synthesize(translated));
            });
        }

        void synthesize(String text) {
            long initAt = SystemClock.elapsedRealtime();
            TextToSpeech[] holder = new TextToSpeech[1];
            holder[0] = new TextToSpeech(app, status -> {
                TextToSpeech tts = holder[0];
                stages.put("ttsInitMs", SystemClock.elapsedRealtime() - initAt);
                if (status != TextToSpeech.SUCCESS) { tts.shutdown(); fail("tts_unavailable", "This phone has no text-to-speech engine."); return; }
                Voice voice = VoiceSpeaker.offlineVoice(tts, Locale.forLanguageTag(to));
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

    static File labDirectory(Context context) {
        File directory = new File(context.getExternalFilesDir(null), "lab");
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        return directory;
    }
}
