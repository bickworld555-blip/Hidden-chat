package io.github.bickworld555.hiddenchat;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * What another app shared to Hidden Messenger from the Android share sheet: a link or text, and/or files. The web
 * app shows a chat picker and reads each file in chunks (readChunk) to upload it. The read permission for the shared
 * files lasts while the app's screen exists, which covers picking chats and uploading.
 */
final class SharedContent {
    static final int CHUNK_BYTES = 512 * 1024;
    private static final List<Uri> files = new ArrayList<>();
    private static InputStream stream;
    private static int streamIndex = -1;
    private static long streamPosition;

    private SharedContent() {}

    static boolean isShare(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /** Remembers the shared files and describes the share for the web app. */
    static synchronized JSObject read(Context context, Intent intent) {
        closeStream();
        files.clear();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) for (Uri uri : list) if (uri != null) files.add(uri);
        } else {
            Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (uri != null) files.add(uri);
        }
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        JSObject share = new JSObject();
        share.put("text", text == null ? "" : text.toString());
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        share.put("subject", subject == null ? "" : subject);
        JSArray described = new JSArray();
        ContentResolver resolver = context.getContentResolver();
        for (int index = 0; index < files.size(); index++) {
            Uri uri = files.get(index);
            JSObject file = new JSObject();
            file.put("index", index);
            String name = null;
            long size = -1;
            try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameColumn >= 0) name = cursor.getString(nameColumn);
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
                }
            } catch (RuntimeException unreadable) {
                // Some apps share URIs without metadata; the name falls back to the last path segment.
            }
            String type = resolver.getType(uri);
            if (type == null) type = intent.getType();
            file.put("name", name != null ? name : (uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "shared-file"));
            file.put("mimeType", type == null ? "application/octet-stream" : type);
            file.put("size", size);
            described.put(file);
        }
        share.put("files", described);
        // Shared to one of our share-sheet shortcuts ("chat:<id>" / "group:<id>"): that chat is chosen already.
        String shortcut = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        share.put("target", shortcut == null ? "" : shortcut);
        return share;
    }

    /** The next CHUNK_BYTES of shared file `index` from `offset`, base64; `done` once the file has been read. */
    static synchronized JSObject readChunk(Context context, int index, long offset) throws IOException {
        if (index < 0 || index >= files.size()) throw new IOException("This shared file is no longer available.");
        if (stream == null || streamIndex != index || streamPosition != offset) {
            closeStream();
            stream = context.getContentResolver().openInputStream(files.get(index));
            if (stream == null) throw new IOException("This shared file could not be opened.");
            streamIndex = index;
            streamPosition = 0;
            while (streamPosition < offset) {
                long skipped = stream.skip(offset - streamPosition);
                if (skipped <= 0) break;
                streamPosition += skipped;
            }
        }
        byte[] buffer = new byte[CHUNK_BYTES];
        int filled = 0;
        while (filled < buffer.length) {
            int read = stream.read(buffer, filled, buffer.length - filled);
            if (read < 0) break;
            filled += read;
        }
        streamPosition += filled;
        boolean done = filled < buffer.length;
        if (done) closeStream();
        JSObject chunk = new JSObject();
        chunk.put("data", Base64.encodeToString(buffer, 0, filled, Base64.NO_WRAP));
        chunk.put("done", done);
        return chunk;
    }

    static synchronized void clear() {
        closeStream();
        files.clear();
    }

    private static void closeStream() {
        if (stream != null) {
            try { stream.close(); } catch (IOException ignored) { }
        }
        stream = null;
        streamIndex = -1;
        streamPosition = 0;
    }
}
