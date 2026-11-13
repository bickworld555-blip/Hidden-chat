package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.text.method.ScrollingMovementMethod;
import android.widget.TextView;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.Map;

/**
 * The translation lab's own screen (debug builds only), driven over adb so no real chat is involved:
 *
 *   adb shell am start -n io.github.bickworld555.hiddenchat.lab/io.github.bickworld555.hiddenchat.TranslationLabActivity \
 *       --es from bn-BD --es to hi-IN [--es file lab/note.ogg] [--ez download true] [--ez speak true] [--ez matrix true]
 *
 * Without "file", the source audio is a sample sentence spoken by the phone's own offline voice (a synthetic
 * self-test: clean speech, so recognition looks better than with real voices). "matrix" runs all 12 directions
 * between Bangla, English, Hindi and Arabic. Results show on screen and in files/lab/reports.jsonl.
 */
public class TranslationLabActivity extends Activity {
    static final Map<String, String> SAMPLES = Map.of(
        "bn-BD", "আমি আজ বিকেলে বাজারে যাব। তুমি কি আমার সাথে আসবে?",
        "en-US", "I am going to the market this afternoon. Will you come with me?",
        "hi-IN", "मैं आज दोपहर बाज़ार जाऊँगा। क्या तुम मेरे साथ चलोगे?",
        "ar-SA", "سأذهب إلى السوق بعد ظهر اليوم. هل ستأتي معي؟");
    static final String[] LANGUAGES = { "bn-BD", "en-US", "hi-IN", "ar-SA" };

    private TextView output;
    private final Deque<String[]> queue = new ArrayDeque<>();
    private boolean download;
    private boolean speak;
    private String file;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        output = new TextView(this);
        output.setPadding(32, 48, 32, 32);
        output.setTextIsSelectable(true);
        output.setMovementMethod(new ScrollingMovementMethod());
        setContentView(output);
        download = getIntent().getBooleanExtra("download", false);
        // whisper experiments: --ei ctx N (encoder frames; 0 = full 30 s), --ez native true (write the language's own
        // script, with a prompt, instead of English), --ef temp 0.0 (no temperature fallback).
        WhisperEngine.labContext = getIntent().getIntExtra("ctx", -1);
        WhisperEngine.labNative = getIntent().getBooleanExtra("native", false);
        WhisperEngine.labTemperatureStep = getIntent().getFloatExtra("temp", 0.2f);
        speak = getIntent().getBooleanExtra("speak", false);
        file = getIntent().getStringExtra("file");
        if (getIntent().getBooleanExtra("matrix", false)) {
            for (String from : LANGUAGES) for (String to : LANGUAGES) if (!from.equals(to)) queue.add(new String[] { from, to });
        } else {
            String from = getIntent().getStringExtra("from");
            String to = getIntent().getStringExtra("to");
            queue.add(new String[] { from == null ? "bn-BD" : from, to == null ? "en-US" : to });
        }
        say("HM Lab: " + queue.size() + " run(s), download=" + download + "\n");
        // --ez whisper true: first download and verify the offline speech model (190 MB), timed.
        if (getIntent().getBooleanExtra("whisper", false) && !WhisperModels.installed(this)) {
            say("Downloading the whisper model (190 MB)…");
            long at = android.os.SystemClock.elapsedRealtime();
            WhisperModels.download(this, (received, total) -> { }, (ok, error) -> runOnUiThread(() -> {
                long ms = android.os.SystemClock.elapsedRealtime() - at;
                say(ok ? "Model ready in " + ms / 1000 + " s" : "Model download failed: " + error);
                android.util.Log.i(TranslationLab.TAG, "{\"whisperDownload\":" + ok + ",\"ms\":" + ms + "}");
                next();
            }));
            return;
        }
        next();
    }

    private void say(String line) {
        output.append(line + "\n");
    }

    private void next() {
        String[] pair = queue.poll();
        if (pair == null) { say("Done. Reports: " + new File(TranslationLab.labDirectory(this), "reports.jsonl")); return; }
        if (file != null) {
            try {
                byte[] audio = Files.readAllBytes(new File(TranslationLab.labDirectory(this), file.replaceFirst("^lab/", "")).toPath());
                run(audio, pair[0], pair[1]);
            } catch (IOException missing) {
                say("Cannot read " + file + ": " + missing.getMessage());
            }
            return;
        }
        sampleAudio(pair[0], audio -> {
            if (audio == null) { say(pair[0] + " → " + pair[1] + ": no offline " + pair[0] + " voice to make the sample"); next(); return; }
            run(audio, pair[0], pair[1]);
        });
    }

    private void run(byte[] audio, String from, String to) {
        say("… " + from + " → " + to);
        TranslationLab.run(this, audio, from, to, download, speak, report -> {
            say(report.toString() + "\n");
            next();
        });
    }

    interface AudioReady { void ready(byte[] audio); }

    /** The sample sentence in `language`, spoken by an installed offline voice into a WAV file. */
    private void sampleAudio(String language, AudioReady done) {
        TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(this, status -> {
            TextToSpeech tts = holder[0];
            Voice voice = status == TextToSpeech.SUCCESS ? VoiceSpeaker.offlineVoice(tts, Locale.forLanguageTag(language)) : null;
            if (voice == null) { tts.shutdown(); runOnUiThread(() -> done.ready(null)); return; }
            tts.setVoice(voice);
            File out = new File(TranslationLab.labDirectory(this), "sample-" + language + ".wav");
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) {
                    tts.shutdown();
                    byte[] audio;
                    try { audio = Files.readAllBytes(out.toPath()); } catch (IOException failed) { audio = null; }
                    byte[] ready = audio;
                    runOnUiThread(() -> done.ready(ready));
                }
                @Override public void onError(String id) { tts.shutdown(); runOnUiThread(() -> done.ready(null)); }
            });
            tts.synthesizeToFile(SAMPLES.get(language), new Bundle(), out, "sample");
        });
    }
}
