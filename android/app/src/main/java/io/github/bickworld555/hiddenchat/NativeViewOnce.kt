package io.github.bickworld555.hiddenchat

import android.content.Context
import java.net.URLEncoder

/**
 * Phase 5 view-once media. A view-once photo arrives as "viewonce:emedia:…" content; the recipient opens it exactly
 * once via POST /api/v1/messages/:id/view-once, which returns the ciphertext and then removes it server-side (the
 * message content becomes "media-opened:"). The sender cannot open their own. This mirrors MediaExtras.jsx
 * ViewOnceMediaBubble.
 */
object NativeViewOnce {
    const val PREFIX = "viewonce:"
    const val OPENED = "media-opened:"

    fun isViewOnce(content: String?): Boolean = content != null && content.startsWith(PREFIX)
    fun isOpened(content: String?): Boolean = content == OPENED

    /**
     * Consumes a received view-once message on the server and returns the decrypted media bytes, or null (already
     * opened / expired / network). Blocking — call off the main thread.
     */
    fun open(context: Context, messageId: String, content: String?): ByteArray? {
        if (messageId.isEmpty()) return null
        val server = NativeServer.from(context) ?: return null
        val path = "/api/v1/messages/" + URLEncoder.encode(messageId, "UTF-8") + "/view-once"
        val bytes = server.postForBytes(path) ?: return null
        return NativeMediaCrypto.decryptFetched(content, bytes)
    }
}
