package io.github.bickworld555.hiddenchat;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Link previews made on the sender's phone, like WhatsApp: the phone fetches the page (and its thumbnail) itself,
 * so the Hidden Messenger server never learns which links people share. Only public https addresses are fetched
 * (no IP literals, no local names), reads are capped in size and time.
 */
final class LinkFetcher {
    static final int MAX_PAGE_BYTES = 768 * 1024;
    static final int MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    private static final String CRAWLER_AGENT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
    private static final ExecutorService pool = Executors.newFixedThreadPool(2);
    private static final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(false)
        .build();

    interface Done { void accept(String text, String finalUrl, String contentType); }
    interface Failed { void accept(String reason); }

    private LinkFetcher() {}

    /** Only https URLs whose host is a public name (no IP literals, localhost or .local / .lan names). */
    static boolean allowed(String url) {
        if (url == null || !url.startsWith("https://")) return false;
        try {
            String host = android.net.Uri.parse(url).getHost();
            if (host == null || host.isEmpty() || !host.contains(".")) return false;
            String lower = host.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".local") || lower.endsWith(".lan") || lower.endsWith(".internal") || lower.equals("localhost")) return false;
            if (lower.matches("^[0-9.]+$") || lower.contains(":")) return false;
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static boolean publicAddress(String host) {
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress()
                    || address.isAnyLocalAddress() || address.isMulticastAddress()) return false;
            }
            return true;
        } catch (IOException error) {
            return false;
        }
    }

    private static byte[] readCapped(ResponseBody body, int limit) throws IOException {
        try (InputStream input = body.byteStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1 && total < limit) {
                int keep = Math.min(read, limit - total);
                out.write(buffer, 0, keep);
                total += keep;
            }
            return out.toByteArray();
        }
    }

    /** The page's HTML (first MAX_PAGE_BYTES), where redirects ended, and its content type. */
    static void fetchPage(String url, Done done, Failed failed) {
        fetch(url, MAX_PAGE_BYTES, "text/html,application/xhtml+xml,application/json", (bytes, finalUrl, type) ->
            done.accept(new String(bytes, java.nio.charset.StandardCharsets.UTF_8), finalUrl, type), failed);
    }

    /** An image as base64 (at most MAX_IMAGE_BYTES), for the thumbnail the phone puts in the message. */
    static void fetchImage(String url, Done done, Failed failed) {
        fetch(url, MAX_IMAGE_BYTES, "image/*", (bytes, finalUrl, type) -> {
            if (!type.startsWith("image/")) {
                failed.accept("Not an image.");
                return;
            }
            done.accept(Base64.encodeToString(bytes, Base64.NO_WRAP), finalUrl, type);
        }, failed);
    }

    private interface Bytes { void accept(byte[] bytes, String finalUrl, String contentType); }

    private static void fetch(String url, int limit, String accept, Bytes done, Failed failed) {
        if (!allowed(url)) {
            failed.accept("Only public https links get a preview.");
            return;
        }
        pool.execute(() -> {
            try {
                String host = android.net.Uri.parse(url).getHost();
                if (!publicAddress(host)) throw new IOException("Not a public address.");
                Request request = new Request.Builder().url(url).header("User-Agent", CRAWLER_AGENT).header("Accept", accept).header("Accept-Language", "en").build();
                try (Response response = client.newCall(request).execute()) {
                    String finalUrl = response.request().url().toString();
                    if (!allowed(finalUrl) || !publicAddress(response.request().url().host())) throw new IOException("Redirected to a private address.");
                    ResponseBody body = response.body();
                    if (!response.isSuccessful() || body == null) throw new IOException("The page did not answer.");
                    String type = body.contentType() == null ? "" : body.contentType().toString().toLowerCase(Locale.ROOT);
                    done.accept(readCapped(body, limit), finalUrl, type);
                }
            } catch (Exception error) {
                failed.accept(error.getMessage() == null ? "No preview." : error.getMessage());
            }
        });
    }
}
