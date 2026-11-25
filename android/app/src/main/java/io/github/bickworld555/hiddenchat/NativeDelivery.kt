package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeBackgroundInbox
import io.github.bickworld555.hiddenchat.core.NativeFetchHandler
import io.github.bickworld555.hiddenchat.core.store.NativeStore

/**
 * Turning one decrypted [NativeFetchHandler.Delivery] into a durably-stored, notified message — the shared step for
 * every native delivery path (the relay.fetch socket in [NativeRelayFetch] and the REST group-queue drain in
 * [NativeGroupFetch]). Keeping it here gives both one owner, so the seal-before-ack rule and the notification look
 * stay identical: [persist] is the durability gate (never acknowledge what was not kept); [notify] is best-effort
 * presentation and must not decide whether a message is acknowledged.
 */
object NativeDelivery {
    /**
     * Seals the raw event plus the decrypted inner payload into the native inbox the WebView imports on open (it seeds
     * its remembered-plaintext cache from `inner` and applies `event` through its normal handler, so the message is
     * parsed in JS without decrypting again — the ratchet already advanced here). False → do not acknowledge.
     */
    fun persist(context: Context, event: Map<String, Any?>, delivery: NativeFetchHandler.Delivery, updateChatList: Boolean = false): Boolean {
        val store = NativeStore.get(context)
        if (store == null) { android.util.Log.w("NativeDelivery", "persist: store null"); return false }
        return try {
            val entry = Json.obj("event" to event, "inner" to delivery.plaintext)
            NativeBackgroundInbox(store).add(SecureStore.seal(Json.stringify(entry)))
            // Also record the decrypted message for the native (Compose) UI, so it shows incoming messages without the
            // WebView mirror. Best-effort — a failure here must NOT change whether the message is acknowledged.
            // `updateChatList` additionally refreshes the chat-list projection (preview/time/unread) — set only by the
            // foreground-socket path (NativeForegroundSocket), where the WebView mirror is suspended and cannot; the
            // background inbox paths leave the list to the WebView mirror to avoid double-counting unread.
            try { recordForNativeUi(store, event, delivery, updateChatList) } catch (ignored: Throwable) { /* native UI only */ }
            true
        } catch (failed: Throwable) {
            android.util.Log.w("NativeDelivery", "persist failed", failed)
            false
        }
    }

    /** Writes an incoming decrypted message into the native store's chat projection (Step 5 native read). */
    private fun recordForNativeUi(store: NativeStore, event: Map<String, Any?>, delivery: NativeFetchHandler.Delivery, updateChatList: Boolean) {
        val raw = delivery.displayText ?: return
        // A readable label for media/voice/location/… (the same MessagePreview the notifications use), not a raw marker.
        val text = MessagePreview.of(raw)
        val chatId = delivery.groupId ?: delivery.senderId
        val message = Json.map(event["message"])
        val ts = Json.safeInteger(message?.get("createdAt")) ?: Json.safeInteger(message?.get("timestamp")) ?: System.currentTimeMillis()
        val time = java.text.SimpleDateFormat("h:mm a", java.util.Locale.US).format(java.util.Date(ts)).lowercase(java.util.Locale.US)
        store.addMessage(chatId, delivery.messageId, false, text, time, ts)
        // Item 4 replies + forwarding: the inner `r` is the replied-to id; `fw`==1 marks a forwarded message.
        val inner = delivery.plaintext?.let { runCatching { Json.map(Json.parse(it)) }.getOrNull() }
        val replyTo = Json.string(inner?.get("r"))
        if (!replyTo.isNullOrEmpty()) store.setReplyTo(chatId, delivery.messageId, replyTo)
        if (Json.safeInteger(inner?.get("fw")) == 1L) store.setForwarded(delivery.messageId)
        // Item 4 disappearing: `ex` seconds → this message disappears ex seconds after it was sent (expiryOf, web).
        // Only the standard timers (24h/7d/90d) are honored, exactly like the web — an arbitrary `ex` is ignored, so
        // native and the WebView agree about whether this message disappears (a disagreement resurrected swept messages).
        val ex = NativeDisappear.clean(Json.safeInteger(inner?.get("ex")))
        if (ex > 0) store.setExpiry(delivery.messageId, ts + ex * 1000)
        // Item 4 link previews: the sender put a preview card in the inner `lp` (nothing is fetched here); store it as-is.
        val lp = Json.map(inner?.get("lp"))
        if (lp != null) store.setLinkPreview(delivery.messageId, Json.stringify(lp))
        // Item 5 media: a photo/video/voice carries a small preview image inside the message (the inner `th` thumbnail
        // or `pv` poster, already decrypted — the full ciphertext file is never touched here) + a length (`du`). Store
        // it so the native bubble shows the real preview, not a text label.
        val kind = MessagePreview.kindOf(raw)
        if (kind.isNotEmpty()) {
            val preview = Json.string(inner?.get("pv"))?.takeIf { it.isNotEmpty() } ?: Json.string(inner?.get("th")) ?: ""
            val duration = (Json.safeInteger(inner?.get("du")) ?: 0L).toInt()
            store.setMedia(delivery.messageId, kind, preview, duration)
        }
        if (updateChatList) store.bumpChatForIncoming(chatId, text, time)
    }

    /** Posts the conversation notification with the decrypted text, on the account's chosen alert channel. */
    fun notify(context: Context, delivery: NativeFetchHandler.Delivery) {
        val group = delivery.groupId != null
        // The account's chosen tone, exactly like the WebView/PushService paths; never a null sound (which
        // NotificationChannels.messageChannel would dereference).
        val session = RelaySession.read(context)
        val sound = if (group) session?.groupSound ?: "" else session?.messageSound ?: ""
        val channel = NotificationChannels.messageChannel(context, group, sound)
        val tag = if (group) "group:${delivery.groupId}" else "chat:${delivery.senderId}"
        val title = if (group) RelaySession.groupName(context, delivery.groupId, "Group")
        else RelaySession.userName(context, delivery.senderId, "Hidden Messenger")
        // In a group the sender's name heads the line (WhatsApp-style, as PushService does); the message id dedupes a
        // copy delivered another way.
        val sender = if (group) RelaySession.userName(context, delivery.senderId, "") else null
        Alerts.showMessage(context, channel, title, delivery.displayText ?: "", tag, tag, 0, delivery.messageId, sender, null)
    }
}
