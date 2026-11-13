package io.github.bickworld555.hiddenchat;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Text translation on the phone with Google ML Kit (about 30 MB per language, through English). Text is translated
 * only when both language models are already downloaded: a translation never downloads anything by itself, so it
 * never touches the network. Models are downloaded only from Settings › Chats › Voice message translation.
 */
final class VoiceTranslator {
    interface Done {
        void done(String text, String error, String code);
    }

    interface Models {
        void done(Set<String> languages);
    }

    static final String MODEL_MISSING = "translation_model_missing";
    static final String UNSUPPORTED = "translation_unsupported";
    static final String FAILED = "translation_failed";

    private VoiceTranslator() {}

    /** ML Kit's code for a BCP 47 tag ("bn-BD" → "bn"), or null when ML Kit can't translate it. */
    static String code(String tag) {
        return TranslateLanguage.fromLanguageTag(Locale.forLanguageTag(tag).getLanguage());
    }

    /** The languages whose model is on the phone (English always counts: it is the pivot every model is built on). */
    static void downloaded(Models done) {
        RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel.class).addOnSuccessListener(models -> {
            Set<String> languages = new HashSet<>();
            languages.add(TranslateLanguage.ENGLISH);
            for (TranslateRemoteModel model : models) languages.add(model.getLanguage());
            done.done(languages);
        }).addOnFailureListener(failed -> {
            Set<String> english = new HashSet<>();
            english.add(TranslateLanguage.ENGLISH);
            done.done(english);
        });
    }

    static void translate(String text, String fromTag, String toTag, Done done) {
        String source = code(fromTag);
        String target = code(toTag);
        if (source == null || target == null) { done.done(null, "These languages can’t be translated on the phone.", UNSUPPORTED); return; }
        if (source.equals(target)) { done.done(text, null, null); return; }
        downloaded(languages -> {
            if (!languages.contains(source) || !languages.contains(target)) {
                String missing = !languages.contains(source) ? fromTag : toTag;
                done.done(null, "Download the " + VoiceTranscriber.displayName(missing) + " translation model first.", MODEL_MISSING);
                return;
            }
            Translator translator = Translation.getClient(new TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build());
            translator.translate(text)
                .addOnSuccessListener(translated -> { translator.close(); done.done(translated, null, null); })
                .addOnFailureListener(failed -> { translator.close(); done.done(null, "The translation failed on this phone.", FAILED); });
        });
    }

    /** Downloads one language's model (Wi-Fi or mobile data, as the person chose to start it). */
    static void download(String tag, Done done) {
        String language = code(tag);
        if (language == null) { done.done(null, "This language can’t be translated on the phone.", UNSUPPORTED); return; }
        if (TranslateLanguage.ENGLISH.equals(language)) { done.done("ok", null, null); return; }
        TranslateRemoteModel model = new TranslateRemoteModel.Builder(language).build();
        RemoteModelManager.getInstance().download(model, new DownloadConditions.Builder().build())
            .addOnSuccessListener(ignored -> done.done("ok", null, null))
            .addOnFailureListener(failed -> done.done(null, "The translation model could not be downloaded.", FAILED));
    }

    static void delete(String tag, Done done) {
        String language = code(tag);
        if (language == null || TranslateLanguage.ENGLISH.equals(language)) { done.done("ok", null, null); return; }
        RemoteModelManager.getInstance().deleteDownloadedModel(new TranslateRemoteModel.Builder(language).build())
            .addOnSuccessListener(ignored -> done.done("ok", null, null))
            .addOnFailureListener(failed -> done.done(null, "The model could not be removed.", FAILED));
    }
}
