package io.github.bickworld555.hiddenchat

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Checklist item 4 (native typing indicators), the RECEIVE side: what each of the native-UI user's direct peers is
 * doing right now — "typing…" or "recording audio…" — delivered as `presence:typing` over the native-owned socket
 * (NativeForegroundSocket, so this is active only while native owns the socket). Ephemeral: never stored, and dropped
 * [EXPIRES_MS] after the last refresh so a lost "stopped" (closed app, dropped connection) can't leave it stuck on.
 * Mirrors store.js setTyping + src/typing.js (ACTIVITY_EXPIRES_MS / the typing|recording kinds).
 */
object NativeTyping {
    private const val EXPIRES_MS = 6000L

    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "native-typing").apply { isDaemon = true }
    }
    private val expiry = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val _activity = MutableStateFlow<Map<String, String>>(emptyMap())

    /** peerId → "typing" | "recording", observed by the native conversation screen (empty string label when absent). */
    val activity: StateFlow<Map<String, String>> = _activity.asStateFlow()

    /** Records (or clears, when [kind] is null) one peer's current activity and (re)arms its expiry. */
    @Synchronized
    fun note(peerId: String, kind: String?) {
        expiry.remove(peerId)?.cancel(false)
        if (kind == null) {
            if (_activity.value.containsKey(peerId)) _activity.value = _activity.value - peerId
            return
        }
        if (_activity.value[peerId] != kind) _activity.value = _activity.value + (peerId to kind)
        expiry[peerId] = scheduler.schedule({ note(peerId, null) }, EXPIRES_MS, TimeUnit.MILLISECONDS)
    }

    /** Clears every peer's activity (e.g. when the native socket is handed back to the WebView). */
    @Synchronized
    fun clear() {
        expiry.values.forEach { it.cancel(false) }
        expiry.clear()
        if (_activity.value.isNotEmpty()) _activity.value = emptyMap()
    }

    /** The label for one activity kind, or "" — "typing…" / "recording audio…" (src/typing.js activityLabel). */
    fun labelFor(kind: String?): String = when (kind) {
        "recording" -> "recording audio…"
        "typing" -> "typing…"
        else -> ""
    }

    /** Schedules [action] once after [delayMs]; used by [NativeTypingSender] for its refresh/idle timers. */
    internal fun scheduleOnce(delayMs: Long, action: () -> Unit): ScheduledFuture<*> =
        scheduler.schedule(action, delayMs, TimeUnit.MILLISECONDS)
}

/**
 * Checklist item 4 (native typing indicators), the SEND side for one direct conversation: announces the native-UI
 * user's own "typing…" to the peer as `presence:typing` while they edit the composer, throttled to one refresh per
 * [REFRESH_MS] and auto-stopped [IDLE_MS] after the last keystroke (and on send / closing the chat). A faithful port of
 * src/typing.js createActivitySender for the typing kind (the native composer has no voice-note recording yet). Frames
 * go out over [send]; the caller wires that to the native-owned socket, so it is inert unless native owns the socket.
 */
class NativeTypingSender(private val peerId: String, private val send: (org.json.JSONObject) -> Boolean) {
    private val lock = Any()
    private var active = false
    private var sentAt = 0L
    private var idleTask: ScheduledFuture<*>? = null

    /** Call on each edit of the message box. */
    fun typed() {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            if (!active || now - sentAt >= REFRESH_MS) { active = true; sentAt = now; emit(true) }
            idleTask?.cancel(false)
            idleTask = NativeTyping.scheduleOnce(IDLE_MS) { stop() }
        }
    }

    /** Call when the chat closes or a message is sent. Idempotent. */
    fun stop() {
        synchronized(lock) {
            idleTask?.cancel(false)
            idleTask = null
            if (!active) return
            active = false
            emit(false)
        }
    }

    private fun emit(on: Boolean) {
        val frame = org.json.JSONObject().put("type", "presence:typing").put("peerId", peerId).put("active", on)
        if (on) frame.put("kind", "typing")
        try { send(frame) } catch (ignored: Throwable) { /* best-effort presence */ }
    }

    companion object {
        private const val REFRESH_MS = 2500L // src/typing.js ACTIVITY_REFRESH_MS
        private const val IDLE_MS = 3000L    // src/typing.js TYPING_IDLE_MS
    }
}
