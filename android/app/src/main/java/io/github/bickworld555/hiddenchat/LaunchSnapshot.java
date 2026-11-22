package io.github.bickworld555.hiddenchat;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.ImageView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The chat list's picture for the next cold start. Android needs about 0.7 s to start the web view engine before any
 * of the app's own code runs; the page itself then draws in about 0.2 s. To fill that time the app keeps a picture of
 * the chat list as the user last left it and shows it from the first frame, until the live list is drawn.
 *
 * Privacy: the picture shows names and last messages, so it is
 *  - taken only while the plain chat list is on show (the web app says so: not a chat, the locked folder, a call, a
 *    menu or a lock screen), and only on a launcher start is it shown;
 *  - never kept while app lock or screen security is on (deleted when either is turned on) and deleted on sign-out;
 *  - encrypted on disk: AES-256-GCM with a random key that is itself sealed by the Android Keystore (SecureStore), in
 *    the app's private files. Nothing is written when the Keystore is unusable.
 *
 * The picture is not tappable; touches on it are dropped for the fraction of a second it shows.
 */
final class LaunchSnapshot {
    private static final String TAG = "LaunchSnapshot";
    private static final String FILE = "launch-snapshot.bin";
    private static final String PREFS = "hm-launch-snapshot";
    private static final String KEY = "key";
    private static final int VERSION = 1;
    private static final int HEADER_BYTES = 16; // version, width, height, night mode
    private static final int IV_BYTES = 12;
    private static final int JPEG_QUALITY = 90;
    // How long onCreate waits for the picture (read, decrypt and decode run beside the bridge's own start-up).
    private static final long ATTACH_WAIT_MS = 150;
    // The live list normally replaces the picture within a second; a page that never reports must not stay covered.
    private static final long SHOW_MAX_MS = 4000;
    private static final long FADE_MS = 120;

    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final Handler main = new Handler(Looper.getMainLooper());
    // From the web app (HiddenNativePlugin.setLaunchSnapshot): false until this process's page has said otherwise.
    private static volatile boolean listOnShow;
    private static volatile boolean allowed;
    private static Future<Bitmap> loading;
    private static View overlay;
    private static long shownAt;
    // The live screen of this start has drawn: a picture that is read late is not shown over it.
    private static boolean live;
    private static final Runnable timeLimit = LaunchSnapshot::ready;

    private LaunchSnapshot() {}

    /** The web app's word: is the plain chat list on show, and may a picture be kept at all (no app lock)? */
    static void setState(Context context, boolean onShow, boolean mayKeep) {
        listOnShow = onShow && mayKeep;
        allowed = mayKeep;
        if (!mayKeep) delete(context);
    }

    /** Signed out, or app lock / screen security turned on: no picture stays behind. */
    static void delete(Context context) {
        listOnShow = false;
        Context app = context.getApplicationContext();
        worker.execute(() -> {
            File file = file(app);
            if (file.exists() && !file.delete()) Log.w(TAG, "picture not deleted");
        });
    }

    /** onPause: the last frame of the plain chat list, saved for the next cold start. */
    static void capture(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (!listOnShow || !allowed || overlay != null || AppSecurity.secureScreen(activity)) {
            Log.i(TAG, "picture not taken: plain list " + listOnShow + ", allowed " + allowed);
            return;
        }
        if (activity.isInPictureInPictureMode() || activity.isInMultiWindowMode() || activity.isChangingConfigurations()) return;
        View decor = activity.getWindow().getDecorView();
        int width = decor.getWidth();
        int height = decor.getHeight();
        if (width <= 0 || height <= 0) return;
        int night = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        Context app = activity.getApplicationContext();
        try {
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            PixelCopy.request(activity.getWindow(), bitmap, (result) -> {
                // Still the plain list and still allowed once the copy is done (a setting may have changed meanwhile).
                if (result != PixelCopy.SUCCESS) Log.i(TAG, "picture not copied: " + result);
                if (result != PixelCopy.SUCCESS || !listOnShow || !allowed || AppSecurity.secureScreen(app)) { bitmap.recycle(); return; }
                worker.execute(() -> {
                    try {
                        save(app, bitmap, night);
                    } catch (Exception | OutOfMemoryError failed) {
                        Log.w(TAG, "picture not saved: " + failed.getClass().getSimpleName());
                        file(app).delete();
                    } finally {
                        bitmap.recycle();
                    }
                });
            }, main);
        } catch (IllegalArgumentException | OutOfMemoryError noSurface) {
            // The window's surface is already gone, or no memory for the copy: the older picture (if any) stays.
        }
    }

    /** First thing in onCreate: starts reading the picture beside the bridge's start-up (only for a launcher start). */
    static void preload(Activity activity) {
        loading = null;
        live = false;
        if (overlay != null || !launcherStart(activity.getIntent()) || AppSecurity.secureScreen(activity)) return;
        Context app = activity.getApplicationContext();
        if (!file(app).exists()) return;
        Rect bounds = windowBounds(activity);
        int night = activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        long started = SystemClock.elapsedRealtime();
        loading = worker.submit(() -> {
            Bitmap bitmap = load(app, bounds.width(), bounds.height(), night);
            if (bitmap != null) {
                Log.i(TAG, "picture read in " + (SystemClock.elapsedRealtime() - started) + " ms");
                // Slower than onCreate was willing to wait: shown as soon as it is here, unless the live screen is.
                main.post(() -> show(activity, bitmap, "late"));
            }
            return bitmap;
        });
    }

    /** After the bridge exists: the picture over the (still empty) web view, until ready() or the time limit. */
    static void attach(Activity activity) {
        Future<Bitmap> pending = loading;
        loading = null;
        if (pending == null) return;
        try {
            Bitmap bitmap = pending.get(ATTACH_WAIT_MS, TimeUnit.MILLISECONDS);
            if (bitmap != null) show(activity, bitmap, "first frame");
        } catch (Exception slowOrBroken) {
            // Still being read: the worker shows it when it is ready (preload).
        }
    }

    private static void show(Activity activity, Bitmap bitmap, String when) {
        if (overlay != null || live || activity.isFinishing() || activity.isDestroyed()) return;
        ImageView picture = new ImageView(activity);
        picture.setImageBitmap(bitmap);
        picture.setScaleType(ImageView.ScaleType.FIT_XY);
        picture.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        // Not the live list: touches end here instead of landing on a page that has not drawn yet.
        picture.setClickable(true);
        ((ViewGroup) activity.getWindow().getDecorView()).addView(picture,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay = picture;
        shownAt = SystemClock.elapsedRealtime();
        Log.i(TAG, "picture shown (" + when + ")");
        main.postDelayed(timeLimit, SHOW_MAX_MS);
    }

    /** The live screen is drawn (or the time limit passed): the picture fades out, and none is shown after this. */
    static void ready() {
        main.removeCallbacks(timeLimit);
        main.post(() -> {
            live = true;
            View picture = overlay;
            if (picture == null) return;
            overlay = null;
            Log.i(TAG, "live screen after " + (SystemClock.elapsedRealtime() - shownAt) + " ms");
            picture.animate().alpha(0f).setDuration(FADE_MS).withEndAction(() -> remove(picture)).start();
        });
    }

    /** The activity is destroyed: its picture goes with it (an older screen finishing late leaves a newer one's alone). */
    static void detach(Activity activity) {
        View picture = overlay;
        if (picture == null || picture.getContext() != activity) return;
        main.removeCallbacks(timeLimit);
        overlay = null;
        remove(picture);
    }

    private static void remove(View picture) {
        ViewParent parent = picture.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(picture);
        if (picture instanceof ImageView) ((ImageView) picture).setImageDrawable(null);
    }

    /** Started from the app icon with nothing to open: not a notification, a call, a share or a shortcut. */
    private static boolean launcherStart(Intent intent) {
        if (intent == null || !Intent.ACTION_MAIN.equals(intent.getAction()) || !intent.hasCategory(Intent.CATEGORY_LAUNCHER)) return false;
        if (intent.getData() != null) return false;
        android.os.Bundle extras = intent.getExtras();
        return extras == null || extras.isEmpty();
    }

    private static Rect windowBounds(Activity activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return activity.getWindowManager().getCurrentWindowMetrics().getBounds();
        android.graphics.Point size = new android.graphics.Point();
        activity.getWindowManager().getDefaultDisplay().getRealSize(size);
        return new Rect(0, 0, size.x, size.y);
    }

    private static File file(Context context) {
        return new File(context.getNoBackupFilesDir(), FILE);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The picture's AES key, sealed by the Keystore; made on first use when `create`. Null when there is none. */
    private static byte[] key(Context context, boolean create) throws Exception {
        String sealed = prefs(context).getString(KEY, null);
        if (sealed != null && SecureStore.isSealed(sealed)) return Base64.decode(SecureStore.open(sealed), Base64.NO_WRAP);
        if (!create) return null;
        byte[] fresh = new byte[32];
        new SecureRandom().nextBytes(fresh);
        // seal() throws when the Keystore is unusable: then no key is stored and no picture is written.
        prefs(context).edit().putString(KEY, SecureStore.seal(Base64.encodeToString(fresh, Base64.NO_WRAP))).apply();
        return fresh;
    }

    // File: header (version, width, height, night mode; authenticated) | iv | AES-256-GCM(JPEG).
    private static void save(Context context, Bitmap bitmap, int night) throws Exception {
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream(256 * 1024);
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)) throw new IllegalStateException("not encoded");
        byte[] header = ByteBuffer.allocate(HEADER_BYTES).putInt(VERSION).putInt(bitmap.getWidth()).putInt(bitmap.getHeight()).putInt(night).array();
        byte[] iv = new byte[IV_BYTES];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key(context, true), "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(header);
        byte[] sealed = cipher.doFinal(jpeg.toByteArray());
        File target = file(context);
        File temp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(header);
            out.write(iv);
            out.write(sealed);
        }
        // A setting changed while this was being written: nothing is left behind.
        if (!allowed || AppSecurity.secureScreen(context) || !temp.renameTo(target)) temp.delete();
        else Log.i(TAG, "picture saved (" + (sealed.length / 1024) + " kB)");
    }

    /** The saved picture, if it fits this screen and theme; an unreadable or mismatched one is deleted. */
    private static Bitmap load(Context context, int width, int height, int night) {
        File file = file(context);
        try {
            byte[] all = new byte[(int) file.length()];
            try (FileInputStream in = new FileInputStream(file)) {
                int read = 0;
                while (read < all.length) {
                    int count = in.read(all, read, all.length - read);
                    if (count < 0) throw new IllegalStateException("truncated");
                    read += count;
                }
            }
            if (all.length <= HEADER_BYTES + IV_BYTES + 16) throw new IllegalStateException("short");
            ByteBuffer header = ByteBuffer.wrap(all, 0, HEADER_BYTES);
            if (header.getInt() != VERSION) throw new IllegalStateException("version");
            // Another screen size (folded, rotated, display size changed) or theme: the picture would not match.
            if (header.getInt() != width || header.getInt() != height || header.getInt() != night) {
                Log.i(TAG, "picture does not fit this screen or theme");
                file.delete();
                return null;
            }
            byte[] key = key(context, false);
            if (key == null) throw new IllegalStateException("no key");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, all, HEADER_BYTES, IV_BYTES));
            cipher.updateAAD(all, 0, HEADER_BYTES);
            byte[] jpeg = cipher.doFinal(all, HEADER_BYTES + IV_BYTES, all.length - HEADER_BYTES - IV_BYTES);
            return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        } catch (Exception | OutOfMemoryError unreadable) {
            Log.w(TAG, "picture not usable: " + unreadable.getClass().getSimpleName());
            file.delete();
            return null;
        }
    }
}
