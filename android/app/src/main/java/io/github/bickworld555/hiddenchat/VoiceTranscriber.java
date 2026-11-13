package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Voice message transcripts on the phone, like WhatsApp's: the recording is decoded to 16-bit PCM (MediaExtractor +
 * MediaCodec) and fed to Android's speech recogniser as its audio source (Android 13+, EXTRA_AUDIO_SOURCE).
 *
 * <p>Only the ON-DEVICE recogniser is ever used (No Email. No Number. Only Privacy.): the audio never leaves the
 * phone. There is no fallback to {@code SpeechRecognizer.createSpeechRecognizer}, whose default service may send audio
 * to a server. When the phone has no on-device recogniser, or no installed pack for the language the sender spoke,
 * the result says so with a code (on_device_unavailable, language_pack_missing, language_pack_downloading,
 * language_unsupported) and the app offers {@link #downloadLanguage} instead of transcribing elsewhere.
 */
final class VoiceTranscriber {
    interface Result {
        /** text on success; otherwise error (shown to the person) and code (what the app can do about it). */
        void done(String text, String error, String code);
    }

    static final String UNAVAILABLE = "on_device_unavailable";
    static final String PACK_MISSING = "language_pack_missing";
    static final String PACK_DOWNLOADING = "language_pack_downloading";
    static final String UNSUPPORTED = "language_unsupported";
    static final String NO_SPEECH = "no_speech";
    static final String FAILED = "failed";

    private static final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private static final long TIMEOUT_US = 10_000;

    private VoiceTranscriber() {}

    /** Whether this phone can transcribe at all without sending audio anywhere. */
    static boolean available(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        return SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
    }

    static void transcribe(Context context, byte[] audio, String language, Result result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.done(null, "Transcripts need Android 13 or newer.", UNAVAILABLE);
            return;
        }
        Context app = context.getApplicationContext();
        decoder.execute(() -> {
            try {
                recognise(app, decodeBytes(app, audio), language, result);
            } catch (Exception error) {
                result.done(null, "This voice message can’t be transcribed on this phone.", FAILED);
            }
        });
    }

    /** Writes the (already decrypted) recording to a private cache file only long enough to decode it. */
    static Pcm decodeBytes(Context app, byte[] audio) throws IOException {
        File input = File.createTempFile("voice", ".audio", app.getCacheDir());
        try {
            try (OutputStream out = new FileOutputStream(input)) {
                out.write(audio);
            }
            return decode(input);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            input.delete();
        }
    }

    static final class Pcm {
        final byte[] data;
        final int sampleRate;

        Pcm(byte[] data, int sampleRate) {
            this.data = data;
            this.sampleRate = sampleRate;
        }
    }

    /** Decodes the first audio track to mono 16-bit little-endian PCM at its own sample rate. */
    static Pcm decode(File file) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try {
            extractor.setDataSource(file.getAbsolutePath());
            int track = -1;
            MediaFormat format = null;
            for (int index = 0; index < extractor.getTrackCount(); index++) {
                MediaFormat candidate = extractor.getTrackFormat(index);
                String mime = candidate.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = index;
                    format = candidate;
                    break;
                }
            }
            if (track < 0) throw new IOException("No audio track");
            extractor.selectTrack(track);
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();
            int sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            java.io.ByteArrayOutputStream pcm = new java.io.ByteArrayOutputStream();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            while (!outputDone) {
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(TIMEOUT_US);
                    if (inIndex >= 0) {
                        ByteBuffer buffer = codec.getInputBuffer(inIndex);
                        int size = extractor.readSampleData(buffer, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat output = codec.getOutputFormat();
                    sampleRate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                } else if (outIndex >= 0) {
                    ByteBuffer buffer = codec.getOutputBuffer(outIndex);
                    if (buffer != null && info.size > 0) {
                        buffer.position(info.offset).limit(info.offset + info.size);
                        ByteBuffer samples = buffer.slice().order(ByteOrder.LITTLE_ENDIAN);
                        int frames = info.size / 2 / Math.max(1, channels);
                        byte[] mono = new byte[frames * 2];
                        for (int frame = 0; frame < frames; frame++) {
                            int sum = 0;
                            for (int channel = 0; channel < channels; channel++) sum += samples.getShort((frame * channels + channel) * 2);
                            short value = (short) (sum / Math.max(1, channels));
                            mono[frame * 2] = (byte) (value & 0xff);
                            mono[frame * 2 + 1] = (byte) ((value >> 8) & 0xff);
                        }
                        pcm.write(mono);
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
            return new Pcm(pcm.toByteArray(), sampleRate);
        } finally {
            if (codec != null) {
                try { codec.stop(); } catch (Exception ignored) { }
                codec.release();
            }
            extractor.release();
        }
    }

    static String tagOrDefault(String language) {
        return language == null || language.isEmpty() ? Locale.getDefault().toLanguageTag() : language;
    }

    static String displayName(String tag) {
        String name = Locale.forLanguageTag(tag).getDisplayLanguage(Locale.ENGLISH);
        return name == null || name.isEmpty() ? tag : name;
    }

    /** The installed (or listed) tag for `tag`: the same tag, else one with the same language ("bn" for "bn-BD"). */
    static String match(List<String> languages, String tag) {
        if (languages == null) return null;
        for (String candidate : languages) if (candidate.equalsIgnoreCase(tag)) return candidate;
        String base = Locale.forLanguageTag(tag).getLanguage();
        for (String candidate : languages) if (Locale.forLanguageTag(candidate).getLanguage().equalsIgnoreCase(base)) return candidate;
        return null;
    }

    private static Intent intentFor(String tag) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        return intent;
    }

    /**
     * Recognises PCM with the on-device recogniser only, in `language` (the sender's, from the encrypted message).
     * The installed packs are checked first, so a missing pack is reported instead of guessed at.
     */
    static void recognise(Context context, Pcm pcm, String language, Result result) throws IOException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.done(null, "Transcripts need Android 13 or newer.", UNAVAILABLE);
            return;
        }
        if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            result.done(null, "This phone has no on-device speech recognition, so voice messages can’t be transcribed privately here.", UNAVAILABLE);
            return;
        }
        String wanted = tagOrDefault(language);
        Handler main = new Handler(Looper.getMainLooper());
        Executor onMain = main::post;
        main.post(() -> {
            SpeechRecognizer recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
            recognizer.checkRecognitionSupport(intentFor(wanted), onMain, new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport support) {
                    String installed = match(support.getInstalledOnDeviceLanguages(), wanted);
                    if (installed != null) {
                        listen(context, recognizer, pcm, installed, result);
                    } else if (match(support.getPendingOnDeviceLanguages(), wanted) != null) {
                        recognizer.destroy();
                        result.done(null, "The " + displayName(wanted) + " speech pack is still downloading. Try again in a few minutes.", PACK_DOWNLOADING);
                    } else if (match(support.getSupportedOnDeviceLanguages(), wanted) != null) {
                        recognizer.destroy();
                        result.done(null, "Download the " + displayName(wanted) + " speech pack to transcribe this on your phone.", PACK_MISSING);
                    } else {
                        recognizer.destroy();
                        result.done(null, displayName(wanted) + " voice messages can’t be transcribed on this phone.", UNSUPPORTED);
                    }
                }

                @Override
                public void onError(int error) {
                    // Some recognisers can't list their languages; try the language itself (still on-device only).
                    listen(context, recognizer, pcm, wanted, result);
                }
            });
        });
    }

    /** Runs on the main thread: feeds the PCM to an on-device recogniser through a pipe. */
    private static void listen(Context context, SpeechRecognizer recognizer, Pcm pcm, String tag, Result result) {
        ParcelFileDescriptor[] pipe;
        try {
            pipe = ParcelFileDescriptor.createPipe();
        } catch (IOException broken) {
            recognizer.destroy();
            result.done(null, "This voice message can’t be transcribed on this phone.", FAILED);
            return;
        }
        StringBuilder transcript = new StringBuilder();
        boolean[] finished = { false };
        Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            recognizer.destroy();
            closeQuietly(pipe[0]);
            String text = transcript.toString().trim();
            if (text.isEmpty()) result.done(null, "No speech was recognised in this voice message.", NO_SPEECH);
            else result.done(text, null, null);
        };
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onPartialResults(Bundle partialResults) { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onSegmentResults(Bundle segment) {
                append(transcript, segment);
            }

            @Override
            public void onEndOfSegmentedSession() {
                finish.run();
            }

            @Override
            public void onResults(Bundle results) {
                append(transcript, results);
                finish.run();
            }

            @Override
            public void onError(int error) {
                // A segmented session can end with "no match" after earlier segments were recognised.
                if (transcript.length() > 0) {
                    finish.run();
                    return;
                }
                if (finished[0]) return;
                finished[0] = true;
                recognizer.destroy();
                closeQuietly(pipe[0]);
                if (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
                    result.done(null, "Download the " + displayName(tag) + " speech pack to transcribe this on your phone.", PACK_MISSING);
                } else if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
                    result.done(null, displayName(tag) + " voice messages can’t be transcribed on this phone.", UNSUPPORTED);
                } else {
                    result.done(null, "No speech was recognised in this voice message.", NO_SPEECH);
                }
            }
        });
        Intent intent = intentFor(tag);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, pcm.sampleRate);
        intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
        recognizer.startListening(intent);
        // The audio is written on a worker thread; closing the write end tells the recogniser the audio ended.
        decoder.execute(() -> {
            try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                out.write(pcm.data);
            } catch (IOException ignored) {
                // The recogniser stopped reading (error or cancel); its listener reports the outcome.
            }
        });
    }

    /**
     * Asks the phone's on-device speech service to download the pack for `language` (Android 13+). The service shows
     * its own progress; nothing about the voice message is involved, only the language.
     */
    static void downloadLanguage(Context context, String language, Result result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
            result.done(null, "This phone has no on-device speech recognition.", UNAVAILABLE);
            return;
        }
        Context app = context.getApplicationContext();
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            SpeechRecognizer recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(app);
            try {
                recognizer.triggerModelDownload(intentFor(tagOrDefault(language)));
                result.done("started", null, null);
            } catch (Exception failed) {
                result.done(null, "The speech pack could not be downloaded on this phone.", FAILED);
            }
            // Let the service take the request before letting go of the connection.
            main.postDelayed(recognizer::destroy, 10_000);
        });
    }

    private static void append(StringBuilder transcript, Bundle bundle) {
        ArrayList<String> matches = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty() || matches.get(0) == null || matches.get(0).trim().isEmpty()) return;
        if (transcript.length() > 0) transcript.append(' ');
        transcript.append(matches.get(0).trim());
    }

    private static void closeQuietly(ParcelFileDescriptor descriptor) {
        try { descriptor.close(); } catch (IOException ignored) { }
    }
}
