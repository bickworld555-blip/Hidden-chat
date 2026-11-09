package io.github.bickworld555.hiddenchat;

import java.util.Locale;
import org.json.JSONObject;

/**
 * Notification text for a message, the same as the web app's (src/store.js notificationPreview): what it is, so a
 * voice note, video, audio file, document, GIF or emoji reads right on the lock screen.
 */
final class MessagePreview {
    private MessagePreview() {}

    static String of(String content) {
        if (content == null) return "";
        if (content.startsWith("voice-opened:")) return "① Opened";
        if (content.startsWith("voice:")) return content.endsWith(":once") ? "① Voice message" : voice(content);
        if (content.startsWith("media:")) return media(content);
        if (content.startsWith("file:")) return "📎 Attachment";
        if (content.startsWith("location:")) return "📍 Location";
        if (content.startsWith("live:")) return "📍 Live location";
        if (content.startsWith("contact:")) return "👤 Contact";
        if (content.startsWith("poll:")) return "📊 Poll: " + jsonField(content.substring(5), "question", "");
        if (content.startsWith("event:")) return "📅 " + jsonField(content.substring(6), "title", "Event");
        if (content.startsWith("call-schedule:")) return "📅 Scheduled call";
        if (content.startsWith("call:")) return "video".equals(jsonField(content.substring(5), "mode", "")) ? "📹 Video call" : "📞 Voice call";
        return content;
    }

    /** voice:<id>:<seconds> → "🎤 Voice message (0:12)". */
    private static String voice(String content) {
        String[] parts = content.split(":");
        double seconds;
        try {
            seconds = parts.length > 2 ? Double.parseDouble(parts[2]) : 0;
        } catch (NumberFormatException malformed) {
            seconds = 0;
        }
        if (!(seconds > 0) || Double.isInfinite(seconds)) return "🎤 Voice message";
        long whole = Math.round(seconds);
        return String.format(Locale.ROOT, "🎤 Voice message (%d:%02d)", whole / 60, whole % 60);
    }

    /** media:<id>:<filename>, by extension as in src/media.js. */
    private static String media(String content) {
        int second = content.indexOf(':', 6);
        String filename = second < 0 ? "" : content.substring(second + 1);
        if (filename.isEmpty()) return "📎 Attachment";
        int dot = filename.lastIndexOf('.');
        String extension = dot < 0 ? "" : filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "gif": return "🎞️ GIF";
            case "jpg": case "jpeg": case "png": case "webp": case "bmp": case "avif": case "heic": case "heif": case "svg": case "tif": case "tiff":
                return "📷 Photo";
            case "mp4": case "m4v": case "mov": case "webm": case "mkv": case "avi": case "3gp":
                return "🎥 Video";
            case "mp3": case "m4a": case "aac": case "wav": case "ogg": case "oga": case "opus": case "flac": case "weba":
                return "🎵 Audio";
            default:
                return "📄 " + filename;
        }
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
