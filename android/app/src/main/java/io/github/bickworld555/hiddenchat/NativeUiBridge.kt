package io.github.bickworld555.hiddenchat

/**
 * The seam the native (Compose) UI uses to ask the web app to do something that still lives in the WebView — for now,
 * SENDING a message. Sending needs the signed-device-list trust model (seal to the right devices, pin the account key),
 * which is audited in the web E2E engine (src/e2e/client.js sealDirect); rather than port that security-critical logic
 * natively unverified, the native composer hands the plaintext here and the web app seals + relays it over its proven
 * path. The sent message comes back to the native UI through the normal store→NativeStore mirror.
 *
 * Interim: the native UI still depends on the live WebView for WRITES. A fully-native send (porting the device-list
 * trust) is a later, verification-gated step. Reads are already fully native (NativeStore).
 */
object NativeUiBridge {
    /** How the bridge reaches the web app (wired to the plugin's notifyListeners in HiddenNativePlugin.load()). */
    fun interface Emitter {
        fun emit(event: String, data: Map<String, Any?>)
    }

    @Volatile
    var emitter: Emitter? = null

    /**
     * Ask the web app to send `text` to `chatId` through its end-to-end send path, carrying the reply target
     * (`replyToId`, inner `r`) when this is a reply. The native seal path (NativeSend.sendText) already carries the
     * reply; this fallback now carries it too, so a reply is never downgraded to a plain message.
     */
    fun requestSend(chatId: String, text: String, replyToId: String? = null) {
        if (chatId.isEmpty() || text.isEmpty()) return
        val data = HashMap<String, Any?>()
        data["chatId"] = chatId
        data["text"] = text
        if (!replyToId.isNullOrEmpty()) data["replyToId"] = replyToId
        emitter?.emit("nativeUiSend", data)
    }

    /**
     * Phase 5 scheduled messages: ask the web app to seal `text` for `chatId` and store it on the server to be
     * delivered at `sendAt` (epoch ms) — `POST /api/v1/scheduled`, the same path the WebView uses. Sealed now for the
     * contact's current devices. The native UI has no crypto core, so the web app does the seal + the API call.
     */
    fun requestSchedule(chatId: String, text: String, sendAt: Long) {
        if (chatId.isEmpty() || text.isEmpty() || sendAt <= 0L) return
        emitter?.emit("nativeUiSchedule", mapOf("chatId" to chatId, "text" to text, "sendAt" to sendAt))
    }

    /**
     * Phase 5 media: ask the web app to send an already-uploaded, encrypted attachment (its "emedia:" ref) to `chatId`
     * through the same audited end-to-end send path, carrying the preview thumbnail (inner `th`). The native side did
     * the encryption + upload; the web app only seals the ref + relays it (no re-upload). Used when the native seal
     * path (NativeSend.sendMedia) is unavailable because the native crypto core is off (the default today).
     */
    fun requestSendMedia(chatId: String, content: String, thumb: String?) {
        if (chatId.isEmpty() || content.isEmpty()) return
        emitter?.emit("nativeUiSend", mapOf("chatId" to chatId, "content" to content, "thumb" to (thumb ?: "")))
    }

    /** Ask the web app to load `chatId`'s message window (if not loaded) and mirror it, so the native conversation
     *  shows messages even for a chat the start-up window did not reach. */
    fun requestMessages(chatId: String) {
        if (chatId.isEmpty()) return
        emitter?.emit("nativeUiOpenChat", mapOf("chatId" to chatId))
    }

    /**
     * Ask the web app to release (active=true) or take back (active=false) the one foreground relay socket, so native
     * can own it without a second online connection decrypting the same messages (checklist item 1). On active=true the
     * web app suspends its RealtimeClient and calls back `webViewSocketReleased`, which starts [NativeForegroundSocket].
     */
    fun requestSocketHandover(active: Boolean) {
        emitter?.emit("nativeSocketHandover", mapOf("active" to active))
    }
}
