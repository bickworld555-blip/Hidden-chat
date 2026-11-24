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

    /** Ask the web app to send `text` to `chatId` through its end-to-end send path. */
    fun requestSend(chatId: String, text: String) {
        if (chatId.isEmpty() || text.isEmpty()) return
        emitter?.emit("nativeUiSend", mapOf("chatId" to chatId, "text" to text))
    }
}
