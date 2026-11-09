package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.util.Base64;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The people and groups you chat with most recently, published as sharing shortcuts: they appear in the top row of
 * Android's share sheet with Hidden Messenger's badge (like WhatsApp's), and as long-press shortcuts on the app
 * icon. Sharing to one opens the app's "Send to…" picker with that chat already chosen.
 */
final class ShareShortcuts {
    static final String CATEGORY = "io.github.bickworld555.hiddenchat.category.SHARE_TARGET";
    private static final int ICON_SIZE = 192;

    private ShareShortcuts() {}

    /** `targets`: [{ kind: "chat" | "group", id, name, initials, color, textColor, avatar (base64 JPEG, optional) }]. */
    static int publish(Context context, JSONArray targets) {
        int max = Math.max(1, Math.min(ShortcutManagerCompat.getMaxShortcutCountPerActivity(context), 8));
        List<ShortcutInfoCompat> shortcuts = new ArrayList<>();
        Set<String> categories = Collections.singleton(CATEGORY);
        for (int index = 0; index < targets.length() && shortcuts.size() < max; index++) {
            JSONObject target = targets.optJSONObject(index);
            if (target == null) continue;
            String kind = "group".equals(target.optString("kind")) ? "group" : "chat";
            String id = target.optString("id", "");
            String name = target.optString("name", "").trim();
            if (id.isEmpty() || name.isEmpty()) continue;
            String open = kind + ":" + id;
            IconCompat icon = IconCompat.createWithAdaptiveBitmap(iconFor(target, name));
            Intent intent = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .putExtra(Alerts.EXTRA_OPEN, open)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            ShortcutInfoCompat.Builder builder = new ShortcutInfoCompat.Builder(context, open)
                .setShortLabel(name)
                .setLongLabel(name)
                .setIcon(icon)
                .setIntent(intent)
                .setCategories(categories)
                .setLongLived(true)
                .setRank(index);
            if ("chat".equals(kind)) builder.setPerson(new Person.Builder().setName(name).setKey(open).setIcon(icon).build());
            shortcuts.add(builder.build());
        }
        try {
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts);
        } catch (IllegalStateException | IllegalArgumentException rateLimitedOrInvalid) {
            return 0;
        }
        return shortcuts.size();
    }

    static void clear(Context context) {
        ShortcutManagerCompat.removeAllDynamicShortcuts(context);
    }

    /** The profile photo when the app sent one, else the coloured initials circle the chat list shows. */
    private static Bitmap iconFor(JSONObject target, String name) {
        String avatar = target.optString("avatar", "");
        if (!avatar.isEmpty()) {
            try {
                byte[] bytes = Base64.decode(avatar, Base64.DEFAULT);
                Bitmap photo = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (photo != null) return square(photo);
            } catch (IllegalArgumentException ignored) {
                // Not valid base64: fall back to initials.
            }
        }
        // Adaptive icons are cropped to the inner ~2/3, so the letters stay within that.
        Bitmap bitmap = Bitmap.createBitmap(ICON_SIZE, ICON_SIZE, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        int background;
        try {
            background = Color.parseColor(target.optString("color", "#dfe5e7"));
        } catch (IllegalArgumentException invalid) {
            background = Color.parseColor("#dfe5e7");
        }
        canvas.drawColor(background);
        String initials = target.optString("initials", "");
        if (initials.isEmpty()) initials = name.substring(0, Math.min(2, name.length())).toUpperCase(java.util.Locale.ROOT);
        Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
        int letters = luminance(background) > 0.6 ? Color.parseColor("#54656f") : Color.WHITE;
        try {
            if (!target.optString("textColor", "").isEmpty()) letters = Color.parseColor(target.optString("textColor"));
        } catch (IllegalArgumentException invalid) {
            // Keep the contrast-based colour.
        }
        text.setColor(letters);
        text.setTextSize(ICON_SIZE * 0.26f);
        text.setFakeBoldText(true);
        text.setTextAlign(Paint.Align.CENTER);
        Rect bounds = new Rect();
        text.getTextBounds(initials, 0, initials.length(), bounds);
        canvas.drawText(initials, ICON_SIZE / 2f, ICON_SIZE / 2f + bounds.height() / 2f, text);
        return bitmap;
    }

    private static Bitmap square(Bitmap photo) {
        int side = Math.min(photo.getWidth(), photo.getHeight());
        Bitmap cropped = Bitmap.createBitmap(photo, (photo.getWidth() - side) / 2, (photo.getHeight() - side) / 2, side, side);
        return Bitmap.createScaledBitmap(cropped, ICON_SIZE, ICON_SIZE, true);
    }

    private static double luminance(int color) {
        return (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255;
    }
}
