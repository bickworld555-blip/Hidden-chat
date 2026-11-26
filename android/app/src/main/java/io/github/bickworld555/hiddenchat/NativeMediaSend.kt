package io.github.bickworld555.hiddenchat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Phase 5 native photo send. Reads a picked photo, encrypts it ([NativeMediaCrypto.encrypt], the v1 HKDF→AES-GCM
 * scheme), uploads the ciphertext ([NativeServer.uploadMedia] → POST /api/v1/media), and sends the resulting
 * "emedia:" reference with a small preview thumbnail (inner `th`).
 *
 * Sending prefers the fully-native seal path ([NativeSend.sendMedia]); when the native crypto core is off — the
 * default until the two-device verification — it falls back to the audited WebView send ([NativeUiBridge.requestSendMedia]),
 * which seals + relays the same ref with no re-upload. The encryption is the exact inverse of the proven
 * [NativeMediaCrypto.decrypt], so the sender's own full-resolution view round-trips it on a single device; the
 * recipient's decrypt is the two-device check.
 */
object NativeMediaSend {
    private const val THUMB_MAX = 320
    private const val THUMB_QUALITY = 70

    /**
     * Encrypts, uploads and sends the photo at [uri] to [peerId]. Blocking — call off the main thread. Returns true
     * when the ciphertext was uploaded and a send was dispatched (native seal, or the WebView fallback).
     */
    fun sendPhoto(context: Context, peerId: String, uri: Uri, replyToId: String? = null): Boolean {
        val resolver = context.contentResolver
        val bytes = try { resolver.openInputStream(uri)?.use { it.readBytes() } } catch (t: Throwable) { null } ?: return false
        if (bytes.isEmpty()) return false
        val type = resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: "image/jpeg"
        val filename = displayName(context, uri) ?: ("photo." + extensionFor(type))
        val server = NativeServer.from(context) ?: return false
        val sealed = try {
            NativeMediaCrypto.encrypt(bytes, type)
        } catch (t: Throwable) {
            android.util.Log.w("NativeMediaSend", "encrypt failed", t); return false
        }
        val mediaId = server.uploadMedia(peerId, sealed.ciphertext) ?: return false
        val content = NativeMediaCrypto.encodeRef(mediaId, sealed.descriptor, filename)
        val thumb = makeThumb(bytes)
        // Native seal path first (needs the native crypto core); otherwise the audited WebView send seals + relays it.
        if (NativeSend.sendMedia(context, peerId, content, thumb, replyToId)) return true
        NativeUiBridge.requestSendMedia(peerId, content, thumb)
        return true
    }

    private fun extensionFor(type: String): String = when {
        type.contains("png") -> "png"
        type.contains("webp") -> "webp"
        type.contains("gif") -> "gif"
        else -> "jpg"
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    } catch (t: Throwable) {
        null
    }

    /** A small JPEG preview as a data URL (inner `th`), downscaled so it travels inside the message. Null on failure. */
    private fun makeThumb(bytes: ByteArray): String? {
        return try {
            val full = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            val longest = maxOf(full.width, full.height).toFloat()
            val scale = if (longest > THUMB_MAX) THUMB_MAX / longest else 1f
            val thumb = if (scale < 1f) {
                Bitmap.createScaledBitmap(full, maxOf(1, (full.width * scale).toInt()), maxOf(1, (full.height * scale).toInt()), true)
            } else {
                full
            }
            val out = ByteArrayOutputStream()
            thumb.compress(Bitmap.CompressFormat.JPEG, THUMB_QUALITY, out)
            if (thumb !== full) thumb.recycle()
            full.recycle()
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            android.util.Log.w("NativeMediaSend", "thumb failed", t); null
        }
    }
}
