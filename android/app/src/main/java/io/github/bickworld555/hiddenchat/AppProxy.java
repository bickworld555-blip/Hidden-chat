package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import java.net.InetSocketAddress;
import java.net.Proxy;

/**
 * Settings › Storage and data › Proxy: an HTTP proxy (host and port) for when Hidden Messenger can't connect
 * directly. It applies to the app's web view (every API call, upload and the realtime connection while the app is
 * open) and to the background message connection (NativeRelay). Saved on this phone only; applied at start-up.
 */
final class AppProxy {
    private static final String PREFS = "hm_proxy";

    private AppProxy() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String host(Context context) {
        return prefs(context).getString("host", "");
    }

    static int port(Context context) {
        return prefs(context).getInt("port", 0);
    }

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
    }

    /** A host name or address and a port (1–65535); anything else is refused before it is saved. */
    static boolean valid(String host, int port) {
        return host != null && host.matches("[A-Za-z0-9.:\\[\\]-]{1,253}") && port >= 1 && port <= 65535;
    }

    static void save(Context context, String host, int port) {
        prefs(context).edit().putString("host", host).putInt("port", port).apply();
        apply(context);
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
        apply(context);
    }

    /** Puts the saved proxy (or none) into effect for the web view. Safe to call before the bridge starts. */
    static void apply(Context context) {
        if (!supported()) return;
        String host = host(context);
        int port = port(context);
        if (valid(host, port)) {
            ProxyConfig config = new ProxyConfig.Builder().addProxyRule(host + ":" + port).addBypassRule("<local>").build();
            ProxyController.getInstance().setProxyOverride(config, Runnable::run, () -> {});
        } else {
            ProxyController.getInstance().clearProxyOverride(Runnable::run, () -> {});
        }
    }

    /** The proxy for OkHttp connections made outside the web view, or null for a direct connection. */
    static Proxy javaProxy(Context context) {
        String host = host(context);
        int port = port(context);
        return valid(host, port) ? new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(host, port)) : null;
    }
}
