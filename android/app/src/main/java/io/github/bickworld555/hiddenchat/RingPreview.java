package io.github.bickworld555.hiddenchat;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Surface;
import android.view.TextureView;

import java.util.Collections;

/**
 * The front camera behind a ringing video call (IncomingCallActivity), so the person sees how they will appear before
 * answering, as WhatsApp does (its camera turns on while a video call rings, seen on the S23 2026-11-20). Only shown on
 * this phone: nothing is recorded or sent; the call's own camera starts after Accept, once this one is closed.
 * Shown only when camera access was already granted (never asked for here) and the person has not chosen to answer
 * with the camera off.
 */
final class RingPreview implements TextureView.SurfaceTextureListener {
    private static final String TAG = "RingPreview";
    private final Activity activity;
    private final TextureView view;
    private boolean wanted;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private HandlerThread thread;
    private Handler handler;
    private Size previewSize;

    RingPreview(Activity activity, TextureView view) {
        this.activity = activity;
        this.view = view;
        view.setSurfaceTextureListener(this);
    }

    static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    /** Shows the preview as soon as the view is ready (does nothing without camera access). */
    void start() {
        wanted = true;
        if (view.isAvailable()) open();
    }

    /** Closes the camera now (before Accept, on Decline, when the screen goes away or the camera is turned off). */
    void stop() {
        wanted = false;
        close();
    }

    private void open() {
        if (camera != null || !allowed(activity)) return;
        CameraManager manager = activity.getSystemService(CameraManager.class);
        if (manager == null) return;
        try {
            String id = frontCamera(manager);
            if (id == null) return;
            StreamConfigurationMap map = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            previewSize = map == null ? new Size(1280, 720) : pickSize(map.getOutputSizes(SurfaceTexture.class));
            thread = new HandlerThread("ring-preview");
            thread.start();
            handler = new Handler(thread.getLooper());
            manager.openCamera(id, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice opened) {
                    if (!wanted) { opened.close(); return; }
                    camera = opened;
                    startSession();
                }

                @Override
                public void onDisconnected(CameraDevice gone) {
                    gone.close();
                    if (camera == gone) camera = null;
                }

                @Override
                public void onError(CameraDevice failed, int error) {
                    failed.close();
                    if (camera == failed) camera = null;
                }
            }, handler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException unavailable) {
            Log.i(TAG, "no preview: " + unavailable.getClass().getSimpleName());
            close();
        }
    }

    private void startSession() {
        CameraDevice device = camera;
        SurfaceTexture texture = view.getSurfaceTexture();
        if (device == null || texture == null) return;
        texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
        Surface surface = new Surface(texture);
        activity.runOnUiThread(this::fitToView);
        try {
            CaptureRequest.Builder request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(surface);
            device.createCaptureSession(Collections.singletonList(surface), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession configured) {
                    if (camera != device) { configured.close(); return; }
                    session = configured;
                    try {
                        configured.setRepeatingRequest(request.build(), null, handler);
                    } catch (CameraAccessException | IllegalStateException failed) {
                        Log.i(TAG, "preview stopped: " + failed.getClass().getSimpleName());
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession failed) {
                    Log.i(TAG, "preview could not start");
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException failed) {
            Log.i(TAG, "preview could not start: " + failed.getClass().getSimpleName());
        }
    }

    /** Fills the screen without stretching (cropped at the sides), mirrored like a mirror, as front cameras are shown. */
    private void fitToView() {
        int viewWidth = view.getWidth();
        int viewHeight = view.getHeight();
        if (viewWidth == 0 || viewHeight == 0 || previewSize == null) return;
        // The camera delivers landscape frames; in this portrait screen they show turned upright (height x width).
        float contentAspect = (float) previewSize.getHeight() / previewSize.getWidth();
        float scaleX = 1f;
        float scaleY = 1f;
        float contentWidth = viewHeight * contentAspect;
        if (contentWidth >= viewWidth) scaleX = contentWidth / viewWidth;
        else scaleY = (viewWidth / contentAspect) / viewHeight;
        Matrix matrix = new Matrix();
        matrix.setScale(-scaleX, scaleY, viewWidth / 2f, viewHeight / 2f);
        view.setTransform(matrix);
    }

    private void close() {
        try { if (session != null) session.close(); } catch (RuntimeException ignored) { }
        session = null;
        try { if (camera != null) camera.close(); } catch (RuntimeException ignored) { }
        camera = null;
        if (thread != null) thread.quitSafely();
        thread = null;
        handler = null;
    }

    private static String frontCamera(CameraManager manager) throws CameraAccessException {
        for (String id : manager.getCameraIdList()) {
            Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) return id;
        }
        return null;
    }

    /** The largest 16:9-ish size up to 1920x1080 (a preview needs no more), else the first offered. */
    private static Size pickSize(Size[] sizes) {
        if (sizes == null || sizes.length == 0) return new Size(1280, 720);
        Size best = null;
        for (Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            float aspect = (float) size.getWidth() / size.getHeight();
            if (area > 1920L * 1080 || Math.abs(aspect - 16f / 9f) > 0.1f) continue;
            if (best == null || area > (long) best.getWidth() * best.getHeight()) best = size;
        }
        return best != null ? best : sizes[0];
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        if (wanted) open();
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
        fitToView();
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        close();
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture texture) { }
}
