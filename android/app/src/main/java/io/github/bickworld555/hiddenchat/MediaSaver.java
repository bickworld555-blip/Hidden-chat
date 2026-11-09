package io.github.bickworld555.hiddenchat;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Saves received files to the phone, visible in the gallery and the file manager:
 *   Download/Hidden Messenger/Images | Video | Audio | Documents
 * Android 10+ does not let apps create a top-level folder without the "all files" permission, so the folder lives
 * under Download (no permission needed). Files stream from the server straight to storage, never into memory.
 */
final class MediaSaver {
    interface Progress { void onProgress(long received, long total); }

    static final class Result {
        final String path;
        Result(String path) { this.path = path; }
    }

    static final String ROOT = "Hidden Messenger";
    private static final ExecutorService pool = Executors.newFixedThreadPool(2);
    private static final OkHttpClient client = new OkHttpClient();

    private MediaSaver() {}

    static String folderFor(String mimeType, String filename) {
        String type = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT);
        String name = filename == null ? "" : filename.toLowerCase(Locale.ROOT);
        if (type.startsWith("image/") || name.matches(".*\\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$")) return "Images";
        if (type.startsWith("video/") || name.matches(".*\\.(mp4|mov|webm|mkv|3gp|m4v)$")) return "Video";
        if (type.startsWith("audio/") || name.matches(".*\\.(mp3|m4a|ogg|opus|wav|aac|flac|amr)$")) return "Audio";
        return "Documents";
    }

    static void save(Context context, String url, String filename, String mimeType, Progress progress, java.util.function.Consumer<Result> done, java.util.function.Consumer<String> failed) {
        Context app = context.getApplicationContext();
        pool.execute(() -> {
            try {
                done.accept(download(app, url, safeName(filename), mimeType, progress));
            } catch (Exception error) {
                failed.accept(error.getMessage() == null ? "Could not save the file." : error.getMessage());
            }
        });
    }

    /**
     * Downloads a received file into the app's cache (replacing an earlier copy) for "Open with": the file is then
     * shared read-only with the app the user picks through the FileProvider, never written to shared storage.
     */
    static void downloadForOpening(Context context, String url, String filename, java.util.function.Consumer<File> done, java.util.function.Consumer<String> failed) {
        Context app = context.getApplicationContext();
        pool.execute(() -> {
            try (Response response = client.newCall(new Request.Builder().url(url).build()).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    throw new IOException(response.code() == 404 ? "This file is no longer available." : "Could not download the file.");
                }
                File directory = new File(app.getCacheDir(), "opened");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not prepare the file.");
                File target = new File(directory, safeName(filename));
                try (InputStream input = response.body().byteStream(); OutputStream output = new FileOutputStream(target)) {
                    copy(input, output, response.body().contentLength(), null);
                }
                done.accept(target);
            } catch (Exception error) {
                failed.accept(error.getMessage() == null ? "Could not open the file." : error.getMessage());
            }
        });
    }

    private static String safeName(String filename) {
        String name = filename == null || filename.trim().isEmpty() ? "file" : filename.trim();
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static Result download(Context context, String url, String filename, String mimeType, Progress progress) throws IOException {
        try (Response response = client.newCall(new Request.Builder().url(url).build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IOException(response.code() == 404 ? "This file is no longer available." : "Could not download the file.");
            }
            String type = mimeType != null && !mimeType.isEmpty() ? mimeType : String.valueOf(response.body().contentType());
            String folder = folderFor(type, filename);
            long total = response.body().contentLength();
            try (InputStream input = response.body().byteStream()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return saveScoped(context, input, filename, type, folder, total, progress);
                return saveLegacy(context, input, filename, folder, total, progress);
            }
        }
    }

    private static Result saveScoped(Context context, InputStream input, String filename, String type, String folder, long total, Progress progress) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String relative = Environment.DIRECTORY_DOWNLOADS + "/" + ROOT + "/" + folder;
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relative);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) throw new IOException("Could not create the file.");
        try (OutputStream output = resolver.openOutputStream(item)) {
            if (output == null) throw new IOException("Could not write the file.");
            copy(input, output, total, progress);
        } catch (IOException error) {
            resolver.delete(item, null, null);
            throw error;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(item, values, null, null);
        return new Result(relative + "/" + filename);
    }

    @SuppressWarnings("deprecation")
    private static Result saveLegacy(Context context, InputStream input, String filename, String folder, long total, Progress progress) throws IOException {
        File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), ROOT + File.separator + folder);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create the Hidden Messenger folder.");
        File target = new File(directory, filename);
        int dot = filename.lastIndexOf('.');
        for (int copy = 1; target.exists(); copy += 1) {
            target = new File(directory, dot > 0 ? filename.substring(0, dot) + " (" + copy + ")" + filename.substring(dot) : filename + " (" + copy + ")");
        }
        try (OutputStream output = new FileOutputStream(target)) {
            copy(input, output, total, progress);
        }
        MediaScannerConnection.scanFile(context, new String[] { target.getAbsolutePath() }, null, null);
        return new Result(Environment.DIRECTORY_DOWNLOADS + "/" + ROOT + "/" + folder + "/" + target.getName());
    }

    private static void copy(InputStream input, OutputStream output, long total, Progress progress) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long received = 0;
        long reported = 0;
        for (int read; (read = input.read(buffer)) != -1; ) {
            output.write(buffer, 0, read);
            received += read;
            if (progress != null && received - reported >= 256 * 1024) {
                reported = received;
                progress.onProgress(received, total);
            }
        }
        if (progress != null) progress.onProgress(received, total);
    }
}
