// JNI bridge for WhisperEngine.java: load a whisper.cpp model file, transcribe 16 kHz mono float PCM in a given
// language, free the model. Nothing here touches the network.
#include <jni.h>
#include <string>
#include <android/log.h>
#include "whisper.h"
#include "ggml-backend.h"

#define LOG_TAG "HMWhisper"

// whisper's and ggml's own messages (CPU variant, model load, timings) go to logcat, tag HMWhisper.
static void toLogcat(ggml_log_level level, const char *text, void *) {
    __android_log_write(level >= GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, LOG_TAG, text);
}

extern "C" {

JNIEXPORT jlong JNICALL
Java_io_github_bickworld555_hiddenchat_WhisperEngine_nativeInit(JNIEnv *env, jclass, jstring modelPath, jstring libraryDir) {
    // Load the CPU backend variant that best fits this phone (libggml-cpu-android_*.so in the app's library folder).
    static bool backendsLoaded = false;
    if (!backendsLoaded) {
        whisper_log_set(toLogcat, nullptr);
        ggml_log_set(toLogcat, nullptr);
        const char *dir = env->GetStringUTFChars(libraryDir, nullptr);
        ggml_backend_load_all_from_path(dir);
        env->ReleaseStringUTFChars(libraryDir, dir);
        backendsLoaded = true;
    }
    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = false;
    params.flash_attn = true; // less memory for attention on the phone
    whisper_context *context = whisper_init_from_file_with_params(path, params);
    env->ReleaseStringUTFChars(modelPath, path);
    if (context == nullptr) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "model could not be loaded");
    return reinterpret_cast<jlong>(context);
}

JNIEXPORT void JNICALL
Java_io_github_bickworld555_hiddenchat_WhisperEngine_nativeFree(JNIEnv *, jclass, jlong handle) {
    if (handle != 0) whisper_free(reinterpret_cast<whisper_context *>(handle));
}

// Returns the transcript as UTF-8 bytes, or null when whisper fails. `language` is a code like "bn" or "hi".
JNIEXPORT jbyteArray JNICALL
Java_io_github_bickworld555_hiddenchat_WhisperEngine_nativeTranscribe(JNIEnv *env, jclass, jlong handle, jfloatArray samples,
                                                                     jstring language, jstring prompt, jint audioContext, jboolean toEnglish, jfloat temperatureStep, jint threads) {
    auto *context = reinterpret_cast<whisper_context *>(handle);
    if (context == nullptr) return nullptr;
    const char *lang = env->GetStringUTFChars(language, nullptr);
    std::string code(lang);
    env->ReleaseStringUTFChars(language, lang);
    if (whisper_lang_id(code.c_str()) < 0) return nullptr;
    const char *promptChars = env->GetStringUTFChars(prompt, nullptr);
    std::string initialPrompt(promptChars);
    env->ReleaseStringUTFChars(prompt, promptChars);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.language = code.c_str();
    params.detect_language = false;
    params.translate = toEnglish == JNI_TRUE; // whisper's own task: speech in any language → English text
    params.n_threads = threads;
    params.no_context = true;
    params.no_timestamps = true;
    params.single_segment = false;
    params.print_realtime = false;
    params.print_progress = false;
    params.print_timestamps = false;
    params.print_special = false;
    params.suppress_nst = true;
    // A sentence in the language's own script keeps the output in that script (whisper otherwise often writes Bangla
    // in Latin letters). audioContext: only as much of the 30-second window as the clip needs (0 = all of it).
    if (!initialPrompt.empty()) params.initial_prompt = initialPrompt.c_str();
    params.audio_ctx = audioContext;
    // Temperature fallback: a pass that loops or looks unsure is decoded again at a higher temperature (0 = never).
    params.temperature_inc = temperatureStep;

    jsize count = env->GetArrayLength(samples);
    jfloat *audio = env->GetFloatArrayElements(samples, nullptr);
    int failed = whisper_full(context, params, audio, count);
    env->ReleaseFloatArrayElements(samples, audio, JNI_ABORT);
    whisper_print_timings(context);
    if (failed != 0) return nullptr;

    std::string text;
    int segments = whisper_full_n_segments(context);
    for (int index = 0; index < segments; index++) {
        const char *segment = whisper_full_get_segment_text(context, index);
        if (segment != nullptr) text += segment;
    }
    // Raw UTF-8 bytes (Java decodes them): NewStringUTF expects modified UTF-8 and mangles 4-byte characters.
    jbyteArray bytes = env->NewByteArray(static_cast<jsize>(text.size()));
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte *>(text.data()));
    return bytes;
}

}
