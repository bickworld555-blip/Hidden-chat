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
    fun persist(context: Context, event: Map<String, Any?>, delivery: NativeFetchHandler.Delivery): Boolean {
        val store = NativeStore.get(context)
        if (store == null) { android.util.Log.w("NativeDelivery", "persist: store null"); return false }
        return try {
            val entry = Json.obj("event" to event, "inner" to delivery.plaintext)
            NativeBackgroundInbox(store).add(SecureStore.seal(Json.stringify(entry)))
            true
        } catch (failed: Throwable) {
            android.util.Log.w("NativeDelivery", "persist failed", failed)
            false
        }
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
