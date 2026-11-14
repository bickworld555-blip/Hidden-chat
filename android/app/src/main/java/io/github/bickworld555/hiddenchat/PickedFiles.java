package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * The files the user picked in the web view's file chooser, remembered by name and size with the content:// URI
 * Android handed back. A picked video is then compressed straight from that URI (HiddenNativePlugin.compressPickedVideo)
 * instead of the web app copying it across the bridge as base64, which cost seconds before compression could start.
 * Only URIs this app was granted by the chooser are kept; nothing is persisted.
 */
final class PickedFiles {
    private static final int LIMIT = 64;
    private static final ArrayDeque<Entry> recent = new ArrayDeque<>();

    private static final class Entry {
        final String name;
        final long size;
        final Uri uri;

        Entry(String name, long size, Uri uri) {
            this.name = name;
            this.size = size;
            this.uri = uri;
        }
    }

    private PickedFiles() {}

    static synchronized void remember(Context context, Uri[] uris) {
        if (uris == null) return;
        for (Uri uri : uris) {
            if (uri == null) continue;
            String name = null;
            long size = -1;
            try (Cursor cursor = context.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    name = cursor.getString(0);
                    if (!cursor.isNull(1)) size = cursor.getLong(1);
                }
            } catch (RuntimeException unreadable) {
                continue;
            }
            if (name == null || size < 0) continue;
            recent.addFirst(new Entry(name, size, uri));
            while (recent.size() > LIMIT) recent.removeLast();
        }
    }

    /** The picked file with this name and size, or null. */
    static synchronized Uri find(String name, long size) {
        for (Iterator<Entry> it = recent.iterator(); it.hasNext(); ) {
            Entry entry = it.next();
            if (entry.size == size && entry.name.equals(name)) return entry.uri;
        }
        return null;
    }


    /** Capacitor's chooser, with every picked URI remembered before the web view receives it. */
    static void install(Bridge bridge) {
        WebView webView = bridge.getWebView();
        Context context = bridge.getContext().getApplicationContext();
        webView.setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
                return super.onShowFileChooser(view, uris -> {
                    try { remember(context, uris); } catch (RuntimeException ignored) { /* the pick still goes through */ }
                    callback.onReceiveValue(uris);
                }, params);
            }
        });
    }
}
