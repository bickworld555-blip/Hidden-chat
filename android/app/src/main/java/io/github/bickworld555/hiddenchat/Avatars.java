package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.os.Looper;
import androidx.core.graphics.drawable.IconCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Profile photos for notifications (the sender of a message, the caller of a missed call), fetched from this
 * account's server with its own session and kept in a small in-memory cache. A missing photo gives null and the
 * notification shows without one. Never called on the main thread (the fetch is blocking, with short timeouts).
 */
final class Avatars {
    private static final int SIZE = 192;
    private static final long MISS_RETRY_MS = 10 * 60 * 1000L;
    private static final Map<String, Bitmap> cache = new LinkedHashMap<String, Bitmap>(32, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Bitmap> eldest) { return size() > 40; }
    };
    private static final Map<String, Long> misses = new LinkedHashMap<>();

    private Avatars() {}

    /** The server path of a user's photo when the event did not carry one. */
    static String pathFor(String userId) {
        return userId == null || userId.isEmpty() ? null : "/api/v1/users/" + android.net.Uri.encode(userId) + "/avatar";
    }

    static IconCompat icon(Context context, String path) {
        Bitmap bitmap = circle(context, path);
        return bitmap == null ? null : IconCompat.createWithBitmap(bitmap);
    }

    static Bitmap circle(Context context, String path) {
        if (path == null || !path.startsWith("/") || Looper.myLooper() == Looper.getMainLooper()) return null;
        synchronized (cache) {
            Bitmap hit = cache.get(path);
            if (hit != null) return hit;
            Long missed = misses.get(path);
            if (missed != null && System.currentTimeMillis() - missed < MISS_RETRY_MS) return null;
        }
        Bitmap bitmap = fetch(context, path);
        synchronized (cache) {
            if (bitmap != null) cache.put(path, bitmap);
            else misses.put(path, System.currentTimeMillis());
        }
        return bitmap;
    }

    private static Bitmap fetch(Context context, String path) {
        RelaySession session = RelaySession.read(context);
        if (session == null) return null;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(session.origin + path).openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setRequestProperty("Authorization", "Bearer " + session.token);
            if (connection.getResponseCode() != 200) return null;
            Bitmap source;
            try (InputStream input = connection.getInputStream()) {
                source = BitmapFactory.decodeStream(input);
            }
            return source == null ? null : round(source);
        } catch (Exception unreachable) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static Bitmap round(Bitmap source) {
        int side = Math.min(source.getWidth(), source.getHeight());
        Rect from = new Rect((source.getWidth() - side) / 2, (source.getHeight() - side) / 2, (source.getWidth() + side) / 2, (source.getHeight() + side) / 2);
        Bitmap out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        canvas.drawCircle(SIZE / 2f, SIZE / 2f, SIZE / 2f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(source, from, new Rect(0, 0, SIZE, SIZE), paint);
        return out;
    }
}
