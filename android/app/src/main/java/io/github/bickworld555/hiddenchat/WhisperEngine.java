package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.os.Build;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Offline speech-to-text with whisper.cpp (src/main/cpp, libhm_whisper.so, 64-bit ARM phones only): the fallback for
 * languages Android's on-device recogniser has no pack for, such as Bangla on many phones. The model stays loaded
 * between voice messages and is released when deleted or when memory runs low. Nothing here uses the network.
 */
final class WhisperEngine {
    private static final int TARGET_RATE = 16_000;
    private static Boolean loaded;
    private static long context;

    private WhisperEngine() {}

    /** Whether this phone can run the engine at all (64-bit ARM and the native library loads). */
    static synchronized boolean supported() {
        if (loaded == null) {
            boolean arm64 = false;
            for (String abi : Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi)) arm64 = true;
            if (!arm64) loaded = false;
            else {
                try {
                    System.loadLibrary("hm_whisper");
                    loaded = true;
                } catch (UnsatisfiedLinkError missing) {
                    loaded = false;
                }
            }
        }
        return loaded;
    }

    /** Whether the engine can transcribe now: supported and the verified model downloaded. */
    static boolean ready(Context context) {
        return supported() && WhisperModels.installed(context);
    }

    /** Transcribes PCM (any sample rate) in `languageTag`; null when it can't. Blocking: call on a worker thread. */
    static synchronized String transcribe(Context app, VoiceTranscriber.Pcm pcm, String languageTag) {
        if (!ready(app)) return null;
        if (context == 0) context = nativeInit(WhisperModels.file(app).getAbsolutePath());
        if (context == 0) return null;
        String language = Locale.forLanguageTag(languageTag).getLanguage();
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
        byte[] text = nativeTranscribe(context, resample(pcm), language, threads);
        if (text == null) return null;
        String result = new String(text, StandardCharsets.UTF_8).trim();
        return result.isEmpty() ? null : result;
    }

    /** Frees the loaded model (deleted, or the app is short of memory). */
    static synchronized void release() {
        if (context != 0) {
            nativeFree(context);
            context = 0;
        }
    }

    /** 16-bit mono PCM at any rate → 16 kHz floats in [-1, 1] (box-filter averaging when downsampling). */
    static float[] resample(VoiceTranscriber.Pcm pcm) {
        int inputFrames = pcm.data.length / 2;
        double step = (double) pcm.sampleRate / TARGET_RATE;
        int outputFrames = (int) Math.floor(inputFrames / step);
        float[] out = new float[outputFrames];
        for (int index = 0; index < outputFrames; index++) {
            int from = (int) Math.floor(index * step);
            int to = Math.max(from + 1, Math.min(inputFrames, (int) Math.floor((index + 1) * step)));
            double sum = 0;
            for (int frame = from; frame < to; frame++) {
                short value = (short) ((pcm.data[frame * 2] & 0xff) | (pcm.data[frame * 2 + 1] << 8));
                sum += value;
            }
            out[index] = (float) (sum / (to - from) / 32768.0);
        }
        return out;
    }

    private static native long nativeInit(String modelPath);

    private static native void nativeFree(long context);

    private static native byte[] nativeTranscribe(long context, float[] samples, String language, int threads);
}
