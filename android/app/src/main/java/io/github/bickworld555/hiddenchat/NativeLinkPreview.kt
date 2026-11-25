package io.github.bickworld555.hiddenchat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import io.github.bickworld555.hiddenchat.core.Json
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Link previews made on the SENDER's phone for the native composer (checklist item 4), a faithful Kotlin port of the
 * web phone path (src/linkPreviewSender.js + linkPreviewParse.js). Like WhatsApp, the preview travels INSIDE the
 * end-to-end encrypted message (the inner `lp`): the phone fetches the page and its thumbnail itself (via the existing
 * privacy-preserving [LinkFetcher] — public https only, no IP literals, size/time capped), so the Hidden Messenger
 * server never learns which links people share, and recipients fetch nothing.
 *
 * Mirrors the web's "prepare while typing, never block Send": [prefetchFromText] starts building as the draft changes;
 * [takeForSend] returns the prepared card if it is ready within a short wait, else null (the message goes without one).
 */
object NativeLinkPreview {
    private const val MAX_HTML_BYTES = 768 * 1024
    private const val THUMBNAIL_PX = 160
    private const val THUMBNAIL_MAX_CHARS = 24_000
    private const val PREPARED_MS = 10 * 60 * 1000L
    private const val PREPARED_MAX = 20

    // The first web link inside message text (src/links.js LINK / TRAILING / linkHref).
    private val LINK = Regex("\\b(?:https?://|www\\.)[^\\s<>\"']+", RegexOption.IGNORE_CASE)
    private val TRAILING = Regex("[.,;:!?)\\]}'\"]+$")
    private val BARE = Regex("^(?:https?://|www\\.)$", RegexOption.IGNORE_CASE)
    private val HAS_SCHEME = Regex("^https?://", RegexOption.IGNORE_CASE)

    /** The first link in [text] as an absolute https(…)/http(…) URL (src/links.js firstLink), or null when none. */
    fun firstLink(text: String?): String? {
        if (text.isNullOrEmpty()) return null
        val match = LINK.find(text) ?: return null
        var link = match.value
        val trailing = TRAILING.find(link)?.value ?: ""
        val keepParen = trailing.startsWith(")") && link.dropLast(trailing.length).contains("(")
        if (trailing.isNotEmpty() && !keepParen) link = link.dropLast(trailing.length)
        if (link.isEmpty() || BARE.matches(link)) return null
        return if (HAS_SCHEME.containsMatchIn(link)) link else "https://$link"
    }

    // --- prepare-while-typing cache (mirrors linkPreviewSender.js prepared/prefetch/previewForSend) ------------------
    private class Prepared(val at: Long) {
        val latch = CountDownLatch(1)
        @Volatile var lp: Map<String, Any?>? = null
    }

    private val prepared = ConcurrentHashMap<String, Prepared>()

    /** Starts making the preview for the link being typed in [text] (once per link for PREPARED_MS). */
    fun prefetchFromText(text: String?) { prefetch(firstLink(text)) }

    private fun prefetch(href: String?) {
        val link = href ?: return
        val now = System.currentTimeMillis()
        prepared[link]?.let { if (now - it.at < PREPARED_MS) return }
        val slot = Prepared(now)
        prepared[link] = slot
        try {
            build(link) { lp -> slot.lp = lp; slot.latch.countDown() }
        } catch (failed: Throwable) {
            slot.latch.countDown()
        }
        while (prepared.size > PREPARED_MAX) {
            val oldest = prepared.entries.minByOrNull { it.value.at } ?: break
            prepared.remove(oldest.key)
        }
    }

    /**
     * The preview to send with a message whose text is [text]: ready now (or within [waitMs]), else null. Never holds
     * the send any longer than [waitMs] (the web waits PREVIEW_SEND_WAIT_MS = 300 ms, relying on the typing-time prefetch).
     */
    fun takeForSend(text: String?, waitMs: Long = 300): Map<String, Any?>? {
        val href = firstLink(text) ?: return null
        var slot = prepared[href]
        if (slot == null) { prefetch(href); slot = prepared[href] }
        if (slot == null) return null
        try { slot.latch.await(waitMs, TimeUnit.MILLISECONDS) } catch (interrupted: InterruptedException) { /* fall through */ }
        return slot.lp
    }

    // --- building one preview (linkPreviewSender.js onPhone) --------------------------------------------------------
    private fun build(href: String, done: (Map<String, Any?>?) -> Unit) {
        LinkFetcher.fetchPage(href, LinkFetcher.Done { text, finalUrl, contentType ->
            if (text == null || contentType == null || !contentType.contains("html", ignoreCase = true)) { done(null); return@Done }
            val meta = previewFromHtml(href, finalUrl ?: href, text)
            if (meta == null) { done(null); return@Done }
            if (meta.image.isEmpty()) { done(lpOf(href, meta, "")); return@Done }
            LinkFetcher.fetchImage(meta.image, LinkFetcher.Done { base64, _, imageType ->
                done(lpOf(href, meta, thumbnailFrom(base64, imageType)))
            }, LinkFetcher.Failed { done(lpOf(href, meta, "")) })
        }, LinkFetcher.Failed { done(null) })
    }

    private class Meta(
        val title: String,
        val description: String,
        val image: String,
        val siteName: String,
        val video: Boolean,
        val duration: Int?,
    )

    /** The card from a page's HTML (linkPreviewParse.js previewFromHtml), or null when the page has nothing to show. */
    private fun previewFromHtml(href: String, finalUrl: String, html: String): Meta? {
        val head = if (html.length > MAX_HTML_BYTES) html.substring(0, MAX_HTML_BYTES) else html
        val meta = metaTags(head)
        val titleTag = Regex("<title[^>]*>([^<]*)</title>", RegexOption.IGNORE_CASE).find(head)?.groupValues?.getOrNull(1)
        val title = firstNonEmpty(meta["og:title"], meta["twitter:title"], decodeEntities(titleTag ?: "").trim())
        val image = firstNonEmpty(meta["og:image:secure_url"], meta["og:image"], meta["twitter:image"], meta["twitter:image:src"])
        if (title.isEmpty() && image.isEmpty()) return null
        val description = firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"])
        val type = meta["og:type"] ?: ""
        val durationRaw = meta["video:duration"] ?: meta["og:video:duration"]
        val duration = durationRaw?.toDoubleOrNull()?.let { if (it > 0) Math.round(it).toInt() else null }
        val path = runCatching { java.net.URI(href).path ?: "" }.getOrDefault("")
        val video = Regex("video", RegexOption.IGNORE_CASE).containsMatchIn(type) ||
            Regex("/(reel|reels|videos?|watch|share/v|share/r)\\b", RegexOption.IGNORE_CASE).containsMatchIn(path) ||
            duration != null
        return Meta(title, description, absoluteUrl(image, finalUrl.ifEmpty { href }), firstNonEmpty(meta["og:site_name"]), video, duration)
    }

    /** The preview as it travels inside the message (linkPreviewParse.js sanitizePreview): bounded, thumbnail only. */
    private fun lpOf(href: String, meta: Meta, thumbnail: String): Map<String, Any?> {
        val lp = linkedMapOf<String, Any?>(
            "url" to href.take(2048),
            "provider" to provider(href),
            "title" to clip(meta.title, 200),
            "description" to clip(meta.description, 300),
            "siteName" to clip(meta.siteName, 80),
            "video" to meta.video,
        )
        if (meta.duration != null) lp["duration"] = meta.duration
        if (thumbnail.isNotEmpty()) lp["thumbnail"] = thumbnail
        return lp
    }

    // --- HTML meta parsing (linkPreviewParse.js parseMetaTags / decodeEntities) -------------------------------------
    private fun metaTags(head: String): Map<String, String> {
        val meta = HashMap<String, String>()
        val keyRe = Regex("\\b(?:property|name|itemprop)\\s*=\\s*[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE)
        val contentRe = Regex("\\bcontent\\s*=\\s*\"([^\"]*)\"|\\bcontent\\s*=\\s*'([^']*)'", RegexOption.IGNORE_CASE)
        for (tag in Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(head)) {
            val key = keyRe.find(tag.value)?.groupValues?.getOrNull(1)?.lowercase() ?: continue
            val content = contentRe.find(tag.value) ?: continue
            val value = content.groupValues[1].ifEmpty { content.groupValues[2] }
            if (!meta.containsKey(key)) meta[key] = decodeEntities(value).trim()
        }
        return meta
    }

    private val ENTITIES = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ")
    private val ENTITY_RE = Regex("&(#x[0-9a-f]+|#\\d+|[a-z]+);", RegexOption.IGNORE_CASE)
    private fun decodeEntities(text: String): String = ENTITY_RE.replace(text) { match ->
        val code = match.groupValues[1]
        if (code.startsWith("#")) {
            val value = if (code[1].lowercaseChar() == 'x') code.substring(2).toIntOrNull(16) else code.substring(1).toIntOrNull()
            if (value != null && value in 1 until 0x110000) String(Character.toChars(value)) else match.value
        } else {
            ENTITIES[code.lowercase()] ?: match.value
        }
    }

    private fun firstNonEmpty(vararg values: String?): String = values.firstOrNull { !it.isNullOrEmpty() } ?: ""

    private fun clip(text: String, limit: Int): String =
        if (text.length > limit) text.substring(0, limit - 1).trimEnd() + "…" else text

    private fun absoluteUrl(value: String, base: String): String {
        if (value.isEmpty()) return ""
        return runCatching {
            val resolved = java.net.URI(base).resolve(value)
            if (resolved.scheme == "http" || resolved.scheme == "https") resolved.toString() else ""
        }.getOrDefault("")
    }

    private fun provider(href: String): String {
        val host = runCatching { java.net.URI(href).host?.lowercase()?.replace(Regex("^(?:www\\.|m\\.|web\\.)"), "") ?: "" }.getOrDefault("")
        return when {
            Regex("(^|\\.)(facebook\\.com|fb\\.watch|fb\\.com)$").containsMatchIn(host) -> "facebook"
            Regex("(^|\\.)(youtube\\.com|youtu\\.be)$").containsMatchIn(host) -> "youtube"
            Regex("(^|\\.)instagram\\.com$").containsMatchIn(host) -> "instagram"
            Regex("(^|\\.)tiktok\\.com$").containsMatchIn(host) -> "tiktok"
            Regex("(^|\\.)(x\\.com|twitter\\.com)$").containsMatchIn(host) -> "x"
            else -> ""
        }
    }

    /** A small JPEG data URL (<= THUMBNAIL_PX long side) from base64 image bytes, or "" (linkPreviewSender.js thumbnailFrom). */
    private fun thumbnailFrom(base64: String, contentType: String?): String {
        return try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return ""
            val scale = minOf(1f, THUMBNAIL_PX.toFloat() / maxOf(bitmap.width, bitmap.height).toFloat())
            val scaled = if (scale < 1f) {
                Bitmap.createScaledBitmap(bitmap, maxOf(1, Math.round(bitmap.width * scale)), maxOf(1, Math.round(bitmap.height * scale)), true)
            } else {
                bitmap
            }
            for (quality in intArrayOf(72, 55, 40)) {
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
                val url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                if (url.length <= THUMBNAIL_MAX_CHARS) return url
            }
            ""
        } catch (failed: Throwable) {
            ""
        }
    }
}
