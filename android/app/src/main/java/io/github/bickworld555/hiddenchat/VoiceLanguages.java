package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * What each voice-message language needs on this phone (Settings › Chats › Voice message translation), and the one
 * place that chains the steps for a voice message: decode → on-device speech-to-text → on-device translation.
 *
 * Per language: "speech" = system (Android's on-device pack installed), system-pending (downloading), system-download
 * (Android offers the pack), whisper (the offline model is here), whisper-download (the model would cover it) or none;
 * "translation" = its ML Kit model is downloaded; "voice" = the name of an installed offline voice, or "".
 */
final class VoiceLanguages {
    interface Report {
        void done(JSObject report);
    }

    private VoiceLanguages() {}

    static void status(Context context, String[] tags, Report report) {
        Context app = context.getApplicationContext();
        JSObject result = new JSObject();
        JSObject whisper = new JSObject();
        whisper.put("supported", WhisperEngine.supported());
        whisper.put("installed", WhisperModels.installed(app));
        whisper.put("downloading", WhisperModels.downloading());
        whisper.put("sizeBytes", WhisperModels.SIZE);
        result.put("whisper", whisper);
        systemSpeech(app, tags, speech -> VoiceTranslator.downloaded(models -> VoiceSpeaker.offlineVoices(app, tags, voices -> {
            JSObject languages = new JSObject();
            for (String tag : tags) {
                JSObject language = new JSObject();
                String system = speech.getString(tag, "none");
                boolean whisperHere = WhisperEngine.ready(app);
                String state = "system".equals(system) ? "system"
                    : whisperHere ? "whisper"
                    : !"none".equals(system) ? system
                    : WhisperEngine.supported() ? "whisper-download" : "none";
                language.put("speech", state);
                String code = VoiceTranslator.code(tag);
                language.put("translation", code != null && models.contains(code));
                language.put("translatable", code != null);
                language.put("voice", voices.get(tag));
                languages.put(tag, language);
            }
            result.put("languages", languages);
            report.done(result);
        })));
    }

    /** For each tag: system, system-pending, system-download or none, from the on-device recogniser's own list. */
    private static void systemSpeech(Context app, String[] tags, Report done) {
        JSObject out = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) {
            for (String tag : tags) out.put(tag, "none");
            done.done(out);
            return;
        }
        Handler main = new Handler(Looper.getMainLooper());
        Executor onMain = main::post;
        main.post(() -> {
            SpeechRecognizer recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(app);
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tags.length > 0 ? tags[0] : "en-US");
            recognizer.checkRecognitionSupport(intent, onMain, new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport support) {
                    for (String tag : tags) out.put(tag, stateOf(support, tag));
                    recognizer.destroy();
                    done.done(out);
                }

                @Override
                public void onError(int error) {
                    for (String tag : tags) out.put(tag, "none");
                    recognizer.destroy();
                    done.done(out);
                }
            });
        });
    }

    private static String stateOf(RecognitionSupport support, String tag) {
        if (VoiceTranscriber.match(support.getInstalledOnDeviceLanguages(), tag) != null) return "system";
        if (VoiceTranscriber.match(support.getPendingOnDeviceLanguages(), tag) != null) return "system-pending";
        List<String> supported = support.getSupportedOnDeviceLanguages();
        return VoiceTranscriber.match(supported, tag) != null ? "system-download" : "none";
    }

    interface Translated {
        /** transcript and translation on success; otherwise error and code (what is missing). engine: system or whisper. */
        void done(String transcript, String translation, String engine, String error, String code);
    }

    /** Decrypted voice note → transcript in `from` → translation in `to`, all on the phone. */
    static void translate(Context context, byte[] audio, String from, String to, Translated done) {
        VoiceTranscriber.transcribe(context, audio, from, (text, error, code) -> {
            if (text == null) { done.done(null, null, null, error, code); return; }
            // whisper writes English: translate from English (and nothing to do when English is wanted).
            String source = VoiceTranscriber.ENGINE_WHISPER.equals(code) ? WhisperEngine.OUTPUT_LANGUAGE : from;
            VoiceTranslator.translate(text, source, to, (translated, failure, failureCode) -> {
                if (translated == null) done.done(text, null, code, failure, failureCode);
                else done.done(text, translated, code, null, null);
            });
        });
    }
}
