package io.github.bickworld555.hiddenchat;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * The offline speech model for WhisperEngine: whisper "small", 5-bit quantised (190 MB), multilingual, so it
 * transcribes Bangla, English, Hindi and Arabic on the phone. Downloaded only when the person asks for it (Settings ›
 * Chats › Voice message translation), kept in app-private storage, and accepted only if its size and SHA-256 match
 * the published file; a partial or tampered download is deleted. The download says nothing about any voice message.
 */
final class WhisperModels {
    interface Progress {
        void update(long received, long total);
    }

    interface Done {
        void done(boolean ok, String error);
    }

    static final String NAME = "ggml-small-q5_1.bin";
    static final String URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + NAME;
    static final long SIZE = 190_085_487L;
    static final String SHA256 = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";

    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static volatile boolean downloading = false;

    private WhisperModels() {}

    static File file(Context context) {
        File directory = new File(context.getFilesDir(), "whisper");
        //noinspection ResultOfMethodCallIgnored
        directory.mkdirs();
        return new File(directory, NAME);
    }

    /** Whether the verified model is on the phone (verified once when it was downloaded). */
    static boolean installed(Context context) {
        File model = file(context);
        return model.isFile() && model.length() == SIZE;
    }

    static boolean downloading() {
        return downloading;
    }

    static void delete(Context context) {
        WhisperEngine.release();
        //noinspection ResultOfMethodCallIgnored
        file(context).delete();
    }

    static void download(Context context, Progress progress, Done done) {
        Context app = context.getApplicationContext();
        if (installed(app)) { done.done(true, null); return; }
        if (downloading) { done.done(false, "The speech model is already downloading."); return; }
        downloading = true;
        worker.execute(() -> {
            File target = file(app);
            File part = new File(target.getPath() + ".part");
            try {
                OkHttpClient http = new OkHttpClient.Builder()
                    .proxy(AppProxy.javaProxy(app))
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .build();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (Response response = http.newCall(new Request.Builder().url(URL).build()).execute()) {
                    if (!response.isSuccessful() || response.body() == null) throw new IOException("HTTP " + response.code());
                    long received = 0;
                    long lastReport = 0;
                    byte[] buffer = new byte[256 * 1024];
                    try (InputStream in = response.body().byteStream(); OutputStream out = new FileOutputStream(part)) {
                        for (int read; (read = in.read(buffer)) != -1; ) {
                            out.write(buffer, 0, read);
                            digest.update(buffer, 0, read);
                            received += read;
                            if (received > SIZE) throw new IOException("The download is larger than the model.");
                            if (received - lastReport >= 2 * 1024 * 1024) { lastReport = received; progress.update(received, SIZE); }
                        }
                    }
                    if (received != SIZE) throw new IOException("The download was incomplete.");
                }
                if (!hex(digest.digest()).equals(SHA256)) throw new IOException("The downloaded model did not match its checksum.");
                if (!part.renameTo(target)) throw new IOException("The model could not be saved.");
                progress.update(SIZE, SIZE);
                done.done(true, null);
            } catch (Exception failed) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                done.done(false, failed.getMessage() == null ? "The speech model could not be downloaded." : failed.getMessage());
            } finally {
                downloading = false;
            }
        });
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format("%02x", value));
        return out.toString();
    }
}
