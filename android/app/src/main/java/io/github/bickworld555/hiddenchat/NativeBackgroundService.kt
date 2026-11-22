package io.github.bickworld555.hiddenchat

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.github.bickworld555.hiddenchat.core.NativeBackground
import io.github.bickworld555.hiddenchat.core.NativeRegistration
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.CryptoCores
import io.github.bickworld555.hiddenchat.core.store.NativeStore

/**
 * The native background path's foreground service, the counterpart of BackgroundHost (which hosts the WebView page).
 * On a push with no screen and the flag on, it installs the native core, registers this device's keys once, and runs
 * NativeRelayFetch (decrypt → seal into the inbox → notify → ack), stopping when the server goes quiet. Off by default;
 * PushService starts BackgroundHost (the WebView page) when the flag is off, so the existing path is the fallback.
 */
class NativeBackgroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        NotificationChannels.ensure(this)
        val notice: Notification = NotificationCompat.Builder(this, NotificationChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_hidden)
            .setContentTitle("Checking for new messages")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
        try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                    startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                    startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                else -> startForeground(NOTIFICATION_ID, notice)
            }
        } catch (refused: RuntimeException) {
            Log.w(TAG, "could not go to the foreground", refused)
            stop()
            return START_NOT_STICKY
        }
        Thread({ run() }, "native-bg").start()
        return START_NOT_STICKY
    }

    private fun run() {
        try {
            if (AppActivity.isAlive()) { stop(); return }
            NativeBackground.install(applicationContext)
            val core = CryptoCores.current()
            if (core == null) { stop(); return }
            ensureRegistered(core)
            val started = NativeRelayFetch.start(applicationContext) { reason ->
                Log.i(TAG, "native fetch done: $reason")
                stop()
            }
            if (!started) stop()
        } catch (failed: Exception) {
            Log.w(TAG, "native background failed", failed)
            stop()
        }
    }

    /** Publishes keys + a signed device list the first time (the "security code changed" re-registration). */
    private fun ensureRegistered(core: CryptoCore) {
        val store = NativeStore.get(applicationContext) ?: return
        if (store.get("registered") == "done") return
        val server = NativeServer.from(applicationContext) ?: return
        val session = RelaySession.read(applicationContext) ?: return
        val userId = session.userId ?: return
        val deviceId = RelaySession.deviceId(applicationContext) ?: return
        try {
            NativeRegistration.register(core, store, userId, deviceId, server)
            store.set("registered", "done")
        } catch (failed: Exception) {
            Log.w(TAG, "native registration failed", failed)
        }
    }

    private fun stop() {
        running = false
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (ignored: RuntimeException) { }
        stopSelf()
    }

    override fun onTimeout(startId: Int) { stop() }
    override fun onDestroy() { running = false; super.onDestroy() }

    companion object {
        private const val TAG = "NativeBackground"
        private const val NOTIFICATION_ID = 1004

        @Volatile
        private var running = false

        @JvmStatic
        fun isRunning(): Boolean = running

        /** Starts the native fetch when the flag is on and no screen exists. No-op otherwise. */
        @JvmStatic
        fun start(context: Context) {
            if (!NativeBackground.enabled(context) || AppActivity.isAlive() || running) return
            val app = context.applicationContext
            try {
                ContextCompat.startForegroundService(app, Intent(app, NativeBackgroundService::class.java))
                running = true
            } catch (notAllowed: RuntimeException) {
                Log.w(TAG, "foreground service refused", notAllowed)
            }
        }
    }
}
