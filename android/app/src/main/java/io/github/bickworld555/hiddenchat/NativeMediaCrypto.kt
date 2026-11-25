package io.github.bickworld555.hiddenchat

import android.content.Context
import android.util.Base64
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives
import java.io.ByteArrayOutputStream
import java.io.File
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Item 5 (full-resolution media): decrypts an attachment's ciphertext for the native viewer — a faithful Kotlin port of
 * the web media pipeline (src/mediaCrypto.js, format v1). The file is AES-256-GCM in 1 MiB chunks; the per-file key and
 * a 12-byte base nonce come from HKDF-SHA256(mediaKey) (zero salt, info "Hidden Messenger media v1"); each chunk's nonce
 * XORs the chunk index into the base nonce's last 4 bytes, and the last chunk is flagged in the GCM AAD so a truncated
 * or reordered file fails. This is the media key (per file, in the message), NOT the E2E CryptoCore ratchet — decrypting
 * here never touches the ratchet, so there is no desync.
 *
 * The ciphertext lives in the app's private files at `media/<mediaId>.bin` (what the WebView's mediaVault stored — the
 * exact bytes the server served); if it is not on disk yet it is downloaded once from `/api/v1/media/<mediaId>`.
 */
object NativeMediaCrypto {
    private const val TAG_BYTES = 16
    private const val VERSION = 1
    private val INFO = "Hidden Messenger media v1".toByteArray(Charsets.UTF_8)
    private val EMEDIA = Regex("^emedia:([^:]+):([A-Za-z0-9_-]+):(.*)$", setOf(RegexOption.DOT_MATCHES_ALL))
    private val MEDIA = Regex("^media:([^:]+):(.*)$", setOf(RegexOption.DOT_MATCHES_ALL))

    /** The media reference parsed from a message's content, or null when it is not an attachment. */
    class Ref(val mediaId: String, val descriptor: Map<String, Any?>?, val encrypted: Boolean)

    fun parseRef(content: String?): Ref? {
        if (content == null) return null
        EMEDIA.find(content)?.let { m ->
            val descriptor = unpackDescriptor(m.groupValues[2]) ?: return null
            return Ref(m.groupValues[1], descriptor, true)
        }
        MEDIA.find(content)?.let { m -> return Ref(m.groupValues[1], null, false) }
        return null
    }

    private fun unpackDescriptor(packed: String): Map<String, Any?>? = runCatching {
        val json = String(Base64.decode(packed, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
        val map = Json.map(Json.parse(json)) ?: return null
        if (Json.safeInteger(map["v"]) == VERSION.toLong() && Json.string(map["key"]) != null) map else null
    }.getOrNull()

    /**
     * The full-resolution bytes of the attachment [content] names, or null when it cannot be produced (no key, the file
     * is missing and cannot be downloaded, or it fails its integrity check). Runs off the main thread (blocking I/O +
     * decryption). For an unencrypted `media:` ref the stored bytes are returned as-is.
     */
    fun decryptedBytes(context: Context, content: String?): ByteArray? {
        val ref = parseRef(content) ?: return null
        val cipher = ensureCipherFile(context, ref.mediaId) ?: return null
        return try {
            if (!ref.encrypted) cipher.readBytes() else decrypt(cipher.readBytes(), ref.descriptor!!)
        } catch (failed: Throwable) {
            android.util.Log.w("NativeMediaCrypto", "decrypt failed for ${ref.mediaId}", failed)
            null
        }
    }

    /** Like [decryptedBytes] but writes the plaintext to a temporary file (for a video the player streams from disk),
     *  returning it or null. The caller deletes it when done. */
    fun decryptedToTempFile(context: Context, content: String?, suffix: String): File? {
        val bytes = decryptedBytes(context, content) ?: return null
        return try {
            File.createTempFile("hm-media-", suffix, context.cacheDir).apply { writeBytes(bytes) }
        } catch (failed: Throwable) {
            android.util.Log.w("NativeMediaCrypto", "temp write failed", failed); null
        }
    }

    /** The on-disk ciphertext file, downloading it once if absent. Null when it cannot be obtained. */
    private fun ensureCipherFile(context: Context, mediaId: String): File? {
        val file = File(File(context.filesDir, "media"), "$mediaId.bin")
        if (file.exists() && file.length() > 0) return file
        val bytes = NativeServer.from(context)?.getBytes("/api/v1/media/${java.net.URLEncoder.encode(mediaId, "UTF-8")}") ?: return null
        return try {
            file.parentFile?.mkdirs()
            file.writeBytes(bytes)
            file
        } catch (failed: Throwable) {
            android.util.Log.w("NativeMediaCrypto", "cache write failed", failed); null
        }
    }

    /** AES-256-GCM chunked decrypt (mediaCrypto.js decryptMedia). Throws on a bad key, tag, or descriptor. */
    private fun decrypt(sealed: ByteArray, descriptor: Map<String, Any?>): ByteArray {
        require(Json.safeInteger(descriptor["v"]) == VERSION.toLong()) { "unsupported media version" }
        val mediaKey = Base64.decode(Json.string(descriptor["key"]), Base64.DEFAULT)
        val size = Json.safeInteger(descriptor["size"]) ?: throw IllegalArgumentException("no size")
        val chunk = (Json.safeInteger(descriptor["chunk"]) ?: (1024L * 1024L)).toInt()
        val derived = Primitives.hkdfRaw(mediaKey, ByteArray(32), INFO, 44)
        val aesKey = SecretKeySpec(derived.copyOfRange(0, 32), "AES")
        val baseNonce = derived.copyOfRange(32, 44)
        val chunks = maxOf(1, ((size + chunk - 1) / chunk).toInt())
        val out = ByteArrayOutputStream(size.toInt().coerceAtLeast(0))
        val sealedChunk = chunk + TAG_BYTES
        for (index in 0 until chunks) {
            val start = index * sealedChunk
            val end = minOf(start + sealedChunk, sealed.size)
            if (start >= sealed.size) break
            val part = sealed.copyOfRange(start, end)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(TAG_BYTES * 8, chunkNonce(baseNonce, index)))
            cipher.updateAAD(byteArrayOf(if (index == chunks - 1) 1 else 0))
            out.write(cipher.doFinal(part))
        }
        val plain = out.toByteArray()
        require(plain.size.toLong() == size) { "decrypted size mismatch" }
        return plain
    }

    // base nonce with the chunk index XORed into its last 4 bytes (big-endian), matching mediaCrypto.js chunkNonce.
    private fun chunkNonce(base: ByteArray, index: Int): ByteArray {
        val nonce = base.copyOf()
        val existing = ((nonce[8].toInt() and 0xFF) shl 24) or ((nonce[9].toInt() and 0xFF) shl 16) or
            ((nonce[10].toInt() and 0xFF) shl 8) or (nonce[11].toInt() and 0xFF)
        val mixed = existing xor index
        nonce[8] = (mixed ushr 24).toByte()
        nonce[9] = (mixed ushr 16).toByte()
        nonce[10] = (mixed ushr 8).toByte()
        nonce[11] = mixed.toByte()
        return nonce
    }
}
