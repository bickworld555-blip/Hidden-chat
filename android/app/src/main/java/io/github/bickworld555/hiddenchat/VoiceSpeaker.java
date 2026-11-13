package io.github.bickworld555.hiddenchat;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Speaks a translation with Android's text-to-speech, using ONLY an installed voice that needs no network
 * (Voice.isNetworkConnectionRequired() false, not marked "not installed"), so the text never leaves the phone. When
 * the language has no such voice (Hindi and Arabic are often missing), it says so and the app opens Android's
 * voice-data installer instead of using a network voice.
 */
final class VoiceSpeaker {
    interface Done {
        void done(boolean ok, String error, String code);
    }

    interface Voices {
        void done(Map<String, String> voiceByTag);
    }

    static final String VOICE_MISSING = "tts_voice_missing";
    static final String UNAVAILABLE = "tts_unavailable";

    private static TextToSpeech speaking;

    private VoiceSpeaker() {}

    /** An installed voice for the language that needs no network (never a cloud voice); the country is preferred. */
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

    private static int score(Voice voice, Locale locale) {
        boolean sameCountry = !locale.getCountry().isEmpty() && voice.getLocale().getCountry().equals(locale.getCountry());
        return (sameCountry ? 1000 : 0) + voice.getQuality();
    }

    /** For each tag, the name of its offline voice, or "" when there is none. */
    static void offlineVoices(Context context, String[] tags, Voices done) {
        TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(context.getApplicationContext(), status -> {
            Map<String, String> found = new HashMap<>();
            for (String tag : tags) {
                Voice voice = status == TextToSpeech.SUCCESS ? offlineVoice(holder[0], Locale.forLanguageTag(tag)) : null;
                found.put(tag, voice == null ? "" : voice.getName());
            }
            holder[0].shutdown();
            done.done(found);
        });
    }

    /** Speaks `text` in `tag` with an offline voice; done() when it finishes, fails or is stopped. */
    static synchronized void speak(Context context, String text, String tag, Done reply) {
        stop();
        java.util.concurrent.atomic.AtomicBoolean answered = new java.util.concurrent.atomic.AtomicBoolean();
        Done done = (ok, error, code) -> { if (answered.compareAndSet(false, true)) reply.done(ok, error, code); };
        TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(context.getApplicationContext(), status -> {
            TextToSpeech tts = holder[0];
            if (status != TextToSpeech.SUCCESS) { tts.shutdown(); done.done(false, "This phone has no text-to-speech engine.", UNAVAILABLE); return; }
            Voice voice = offlineVoice(tts, Locale.forLanguageTag(tag));
            if (voice == null) {
                tts.shutdown();
                done.done(false, "Install an offline " + VoiceTranscriber.displayName(tag) + " voice to hear translations.", VOICE_MISSING);
                return;
            }
            tts.setVoice(voice);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { finish(tts); done.done(true, null, null); }
                @Override public void onError(String id) { finish(tts); done.done(false, "The translation could not be spoken.", UNAVAILABLE); }
                @Override public void onStop(String id, boolean interrupted) { finish(tts); done.done(true, null, null); }
            });
            synchronized (VoiceSpeaker.class) { speaking = tts; }
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), "translation");
        });
    }

    private static synchronized void finish(TextToSpeech tts) {
        if (speaking != tts) return; // already stopped and shut down
        speaking = null;
        tts.shutdown();
    }

    static synchronized void stop() {
        TextToSpeech current = speaking;
        speaking = null;
        if (current != null) {
            current.stop();
            current.shutdown();
        }
    }

    /** Opens Android's installer for offline voice data (the person picks Hindi, Arabic… there). */
    static boolean openInstaller(Context context) {
        Intent install = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(install);
            return true;
        } catch (ActivityNotFoundException missing) {
            try {
                context.startActivity(new Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            } catch (ActivityNotFoundException none) {
                return false;
            }
        }
    }
}
