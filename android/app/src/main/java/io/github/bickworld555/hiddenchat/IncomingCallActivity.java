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
    static final String EXTRA_AVATAR = "hm_avatar";
    static final String EXTRA_CAMERA_OFF = "hm_camera_off";
    // WhatsApp's quick replies under "Message": the call is declined and the text sent, without unlocking.
    static final String[] QUICK_REPLIES = {
        "Can't talk now. What's up?",
        "I'll call you right back.",
        "I'll call you later.",
        "Can't talk now. Call me later?",
    };
    private boolean cameraOff;
    private static IncomingCallActivity current;

    static Intent intent(Context context, String callId, String caller, boolean video, String avatar) {
        return new Intent(context, IncomingCallActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId)
            .putExtra(EXTRA_CALLER, caller)
            .putExtra(EXTRA_VIDEO, video)
            .putExtra(EXTRA_AVATAR, avatar);
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
        getWindow().setStatusBarColor(Color.parseColor("#0b1628"));
        getWindow().setNavigationBarColor(Color.parseColor("#0b1628"));
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
        root.setBackgroundColor(Color.parseColor("#0b1628"));
        root.setPadding(dp(24), dp(56), dp(24), dp(48));

        TextView encrypted = text("🔒 End-to-end encrypted", 13, "#8696a0", false);
        root.addView(encrypted);

        // Photo, name and call type sit in the middle of the screen: when Android also shows its call banner at the
        // top (it does when the app opens this screen itself), it cannot cover who is calling.
        root.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));

        TextView avatar = text(initials(name), 44, "#ffffff", true);
        avatar.setGravity(Gravity.CENTER);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor("#1a73e8"));
        avatar.setBackground(circle);
        android.widget.FrameLayout photoFrame = new android.widget.FrameLayout(this);
        photoFrame.addView(avatar, new android.widget.FrameLayout.LayoutParams(dp(132), dp(132)));
        ImageView photo = new ImageView(this);
        photo.setScaleType(ImageView.ScaleType.FIT_XY);
        photo.setVisibility(View.GONE);
        photoFrame.addView(photo, new android.widget.FrameLayout.LayoutParams(dp(132), dp(132)));
        root.addView(photoFrame, new LinearLayout.LayoutParams(dp(132), dp(132)));
        loadPhoto(intent.getStringExtra(EXTRA_AVATAR), photo);

        TextView title = text(name, 30, "#e9edef", false);
        title.setPadding(0, dp(24), 0, dp(6));
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        root.addView(title);
        root.addView(text(video ? "Incoming video call" : "Incoming voice call", 16, "#aebac1", false));

        root.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1.2f));

        if (video) {
            // "Turn off your video": answer the video call with the camera off (tap again to keep it on).
            TextView camera = text("", 15, "#ffffff", false);
            camera.setPadding(dp(20), dp(10), dp(20), dp(10));
            GradientDrawable pill = new GradientDrawable();
            pill.setCornerRadius(dp(24));
            pill.setColor(Color.parseColor("#2c3e57"));
            camera.setBackground(pill);
            camera.setClickable(true);
            Runnable label = () -> {
                camera.setText(cameraOff ? "📷  Turn on your video" : "🚫  Turn off your video");
                camera.setContentDescription(cameraOff ? "Answer with camera on" : "Answer with camera off");
            };
            label.run();
            camera.setOnClickListener((v) -> { cameraOff = !cameraOff; label.run(); });
            LinearLayout.LayoutParams cameraSize = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            cameraSize.bottomMargin = dp(28);
            root.addView(camera, cameraSize);
        }

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        buttons.addView(action("Decline", "#ea0038", android.R.drawable.ic_menu_call, 135f, "Decline call", (v) -> decline(callId)), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout acceptColumn = action("Swipe up to accept", "#1fa855", android.R.drawable.ic_menu_call, 0f, video ? "Accept video call" : "Accept call", (v) -> accept(callId));
        swipeUpToAccept(acceptColumn.getChildAt(0), () -> accept(callId));
        buttons.addView(acceptColumn, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.4f));
        buttons.addView(action("Message", "#22324a", android.R.drawable.sym_action_chat, 0f, "Decline with a message", (v) -> chooseReply(callId)), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    /**
     * The caller's profile photo, fetched with the signed-in session the background service keeps; the initials stay
     * if there is none or it cannot be loaded.
     */
    private void loadPhoto(String path, ImageView target) {
        RelaySession session = RelaySession.read(this);
        if (path == null || path.isEmpty() || !path.startsWith("/") || session == null) return;
        String url = session.origin + path;
        String token = session.token;
        new Thread(() -> {
            java.net.HttpURLConnection connection = null;
            try {
                connection = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                if (connection.getResponseCode() != 200) return;
                android.graphics.Bitmap bitmap;
                try (java.io.InputStream input = connection.getInputStream()) {
                    bitmap = android.graphics.BitmapFactory.decodeStream(input);
                }
                if (bitmap == null) return;
                int side = Math.min(bitmap.getWidth(), bitmap.getHeight());
                bitmap = android.graphics.Bitmap.createBitmap(bitmap, (bitmap.getWidth() - side) / 2, (bitmap.getHeight() - side) / 2, side, side);
                androidx.core.graphics.drawable.RoundedBitmapDrawable round =
                    androidx.core.graphics.drawable.RoundedBitmapDrawableFactory.create(getResources(), bitmap);
                round.setCircular(true);
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    target.setImageDrawable(round);
                    target.setVisibility(View.VISIBLE);
                });
            } catch (Exception unavailable) {
                // Offline or no photo: the initials stay.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    /** Opens the app straight into the call, still over the lock screen (it shows there while a call is on). */
    private void accept(String callId) {
        Intent accept = new Intent(this, MainActivity.class)
            .setAction(Alerts.ACTION_ACCEPT)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(Alerts.EXTRA_CALL, true)
            .putExtra(EXTRA_CAMERA_OFF, cameraOff)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId);
        startActivity(accept);
        finish();
    }

    /** Dragging the green button upwards answers, like WhatsApp's "Swipe up to accept"; a tap answers too. */
    private void swipeUpToAccept(View button, Runnable onAccept) {
        final float[] start = new float[1];
        final int threshold = dp(90);
        button.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    start[0] = event.getRawY();
                    return false;
                case android.view.MotionEvent.ACTION_MOVE:
                    float lift = Math.max(0, start[0] - event.getRawY());
                    view.setTranslationY(-Math.min(lift, threshold * 1.4f));
                    if (lift >= threshold) {
                        view.setTranslationY(0);
                        onAccept.run();
                        return true;
                    }
                    return lift > dp(8);
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    boolean dragged = view.getTranslationY() < -dp(8);
                    view.animate().translationY(0).setDuration(150).start();
                    return dragged;
                default:
                    return false;
            }
        });
    }

    /** "Message": pick a quick reply; the call is declined and the reply sent to the caller, still locked. */
    private void chooseReply(String callId) {
        new android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Reply with a message")
            .setItems(QUICK_REPLIES, (dialog, which) -> {
                sendBroadcast(new Intent(this, CallActionReceiver.class)
                    .setAction(CallActionReceiver.ACTION_REPLY)
                    .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId)
                    .putExtra(CallActionReceiver.EXTRA_TEXT, QUICK_REPLIES[which]));
                finish();
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /** Rejects without opening the app or unlocking, through the same path as the notification's Decline. */
    private void decline(String callId) {
        sendBroadcast(new Intent(this, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_REJECT)
            .putExtra(Alerts.EXTRA_CALL_ID, callId == null ? "" : callId));
        finish();
    }

    private LinearLayout action(String label, String color, int icon, float rotation, String description, View.OnClickListener onClick) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageView button = new ImageView(this);
        button.setImageResource(icon);
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
