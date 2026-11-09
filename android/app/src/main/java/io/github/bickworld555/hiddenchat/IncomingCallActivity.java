package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The ringing call over the lock screen, like WhatsApp's: drawn natively so it appears the moment the phone lights
 * up, without waiting for the app's web screen to load (which left the screen black while the ringtone played).
 * Accept opens the app straight into the call; Decline rejects it without unlocking. It closes by itself when the
 * call stops ringing (the caller hung up, or it was answered or declined elsewhere).
 */
public class IncomingCallActivity extends Activity {
    static final String EXTRA_CALLER = "hm_caller";
    static final String EXTRA_VIDEO = "hm_video";
    private static IncomingCallActivity current;

    static Intent intent(Context context, String callId, String caller, boolean video) {
        return new Intent(context, IncomingCallActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId)
            .putExtra(EXTRA_CALLER, caller)
            .putExtra(EXTRA_VIDEO, video);
    }

    /** The call stopped ringing: take the screen down. */
    static void dismiss() {
        IncomingCallActivity activity = current;
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;
        // Over the lock screen, screen on, and kept on while it rings.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0b141a"));
        getWindow().setNavigationBarColor(Color.parseColor("#0b141a"));
        if (!Alerts.isRinging()) {
            // Opened late (the call already ended or was answered): nothing to show.
            finish();
            return;
        }
        render(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        render(intent);
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // Back does not dismiss a ringing call (it keeps ringing in the notification); just step aside.
        moveTaskToBack(true);
    }

    private void render(Intent intent) {
        String callId = intent.getStringExtra(Alerts.EXTRA_CALL_ID);
        String caller = intent.getStringExtra(EXTRA_CALLER);
        boolean video = intent.getBooleanExtra(EXTRA_VIDEO, false);
        String name = caller == null || caller.isEmpty() ? "Hidden Messenger" : caller;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0b141a"));
        root.setPadding(dp(24), dp(56), dp(24), dp(48));

        TextView encrypted = text("🔒 End-to-end encrypted", 13, "#8696a0", false);
        root.addView(encrypted);

        TextView title = text(name, 30, "#e9edef", false);
        title.setPadding(0, dp(20), 0, dp(6));
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        root.addView(title);
        root.addView(text(video ? "Incoming video call" : "Incoming voice call", 16, "#aebac1", false));

        TextView avatar = text(initials(name), 44, "#ffffff", true);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor("#00a884"));
        avatar.setBackground(circle);
        LinearLayout.LayoutParams avatarSize = new LinearLayout.LayoutParams(dp(132), dp(132));
        avatarSize.topMargin = dp(56);
        root.addView(avatar, avatarSize);

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(action("Decline", "#ea0038", 135f, "Decline call", (v) -> decline(callId)), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        buttons.addView(action(video ? "Video" : "Accept", "#1fa855", 0f, video ? "Accept video call" : "Accept call", (v) -> accept(callId)), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    /** Opens the app straight into the call, still over the lock screen (it shows there while a call is on). */
    private void accept(String callId) {
        Intent accept = new Intent(this, MainActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId);
        startActivity(accept);
        finish();
    }

    /** Rejects without opening the app or unlocking, through the same path as the notification's Decline. */
    private void decline(String callId) {
        sendBroadcast(new Intent(this, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_REJECT)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId));
        finish();
    }

    private LinearLayout action(String label, String color, float rotation, String description, View.OnClickListener onClick) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageView button = new ImageView(this);
        button.setImageResource(android.R.drawable.ic_menu_call);
        button.setColorFilter(Color.WHITE);
        button.setRotation(rotation);
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        button.setPadding(dp(18), dp(18), dp(18), dp(18));
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor(color));
        button.setBackground(circle);
        button.setContentDescription(description);
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(onClick);
        column.addView(button, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView caption = text(label, 14, "#e9edef", false);
        caption.setPadding(0, dp(10), 0, 0);
        column.addView(caption);
        return column;
    }

    private TextView text(String value, int sp, String color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(Color.parseColor(color));
        view.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private static String initials(String name) {
        StringBuilder out = new StringBuilder();
        for (String part : name.replace("@", "").trim().split("\\s+")) {
            if (part.isEmpty()) continue;
            out.appendCodePoint(part.codePointAt(0));
            if (out.length() >= 2) break;
        }
        return out.length() == 0 ? "?" : out.toString().toUpperCase();
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
