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
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Voice message transcripts on the phone, like WhatsApp's: the recording is decoded to 16-bit PCM (MediaExtractor +
 * MediaCodec) and fed to Android's speech recogniser as its audio source (Android 13+, EXTRA_AUDIO_SOURCE). The
 * on-device recogniser is used when the phone has one, so the audio does not leave the phone.
 */
final class VoiceTranscriber {
    interface Result {
        void done(String text, String error);
    }

    private static final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private static final long TIMEOUT_US = 10_000;

    private VoiceTranscriber() {}

    static boolean available(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        return SpeechRecognizer.isOnDeviceRecognitionAvailable(context) || SpeechRecognizer.isRecognitionAvailable(context);
    }

    static void transcribe(Context context, byte[] audio, String language, Result result) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.done(null, "Transcripts need Android 13 or newer.");
            return;
        }
        Context app = context.getApplicationContext();
        decoder.execute(() -> {
            File input = null;
            try {
                input = File.createTempFile("voice", ".audio", app.getCacheDir());
                try (OutputStream out = new FileOutputStream(input)) {
                    out.write(audio);
                }
                Pcm pcm = decode(input);
                recognise(app, pcm, language, result);
            } catch (Exception error) {
                result.done(null, "This voice message can’t be transcribed on this phone.");
            } finally {
                if (input != null) input.delete();
            }
        });
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

    private static void recognise(Context context, Pcm pcm, String language, Result result) throws IOException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        new Handler(Looper.getMainLooper()).post(() -> {
            SpeechRecognizer recognizer = SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
                ? SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                : SpeechRecognizer.createSpeechRecognizer(context);
            StringBuilder transcript = new StringBuilder();
            boolean[] finished = { false };
            Runnable finish = () -> {
                if (finished[0]) return;
                finished[0] = true;
                recognizer.destroy();
                closeQuietly(pipe[0]);
                String text = transcript.toString().trim();
                if (text.isEmpty()) result.done(null, "No speech was recognised in this voice message.");
                else result.done(text, null);
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
                    result.done(null, error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                        ? "Transcripts aren’t available for this language on this phone."
                        : "No speech was recognised in this voice message.");
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language == null || language.isEmpty() ? Locale.getDefault().toLanguageTag() : language);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0]);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, pcm.sampleRate);
            intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            recognizer.startListening(intent);
            // The audio is written on a worker thread; closing the write end tells the recogniser the audio ended.
            decoder.execute(() -> {
                try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    out.write(pcm.data);
                } catch (IOException ignored) {
                    // The recogniser stopped reading (error or cancel); its listener reports the outcome.
                }
            });
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
