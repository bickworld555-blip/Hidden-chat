package io.github.bickworld555.hiddenchat;

import java.util.Locale;
import org.json.JSONObject;

/** Notification text for a stored message, matching the web app's chat-list previews (src/store.js previewFor). */
final class MessagePreview {
    private MessagePreview() {}

    static String of(String content) {
        if (content == null) return "";
        if (content.startsWith("voice-opened:")) return "① Opened";
        if (content.startsWith("voice:")) return content.endsWith(":once") ? "① Voice message" : "🎤 Voice message";
        if (content.startsWith("media:")) return media(content);
        if (content.startsWith("file:")) return "📎 Attachment";
        if (content.startsWith("location:")) return "📍 Location";
        if (content.startsWith("live:")) return "📍 Live location";
        if (content.startsWith("contact:")) return "👤 Contact";
        if (content.startsWith("poll:")) return "📊 Poll: " + jsonField(content.substring(5), "question", "");
        if (content.startsWith("event:")) return "📅 " + jsonField(content.substring(6), "title", "Event");
        if (content.startsWith("call-schedule:")) return "📅 Scheduled call";
        if (content.startsWith("call:")) return "📞 Call";
        return content;
    }

    private static String media(String content) {
        // media:<id>:<filename>
        int second = content.indexOf(':', 6);
        String filename = second < 0 ? "" : content.substring(second + 1);
        String lower = filename.toLowerCase(Locale.ROOT);
        if (lower.matches(".*\\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$")) return "📷 Photo";
        if (lower.matches(".*\\.(mp4|mov|webm|mkv|3gp|m4v)$")) return "🎥 Video";
        if (lower.matches(".*\\.(mp3|m4a|ogg|opus|wav|aac|flac)$")) return "🎵 " + filename;
        return "📄 " + (filename.isEmpty() ? "Attachment" : filename);
    }

    private static String jsonField(String json, String field, String fallback) {
        try {
            String value = new JSONObject(json).optString(field, fallback);
            return value.isEmpty() ? fallback : value;
        } catch (Exception malformed) {
            return fallback;
        }
    }
}
