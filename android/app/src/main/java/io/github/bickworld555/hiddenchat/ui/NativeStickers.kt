package io.github.bickworld555.hiddenchat.ui

/**
 * The sticker set that ships with Hidden Messenger (Phase 5), a faithful port of src/stickers.js STICKER_PACKS. A
 * sticker message is "sticker:<pack>/<id>"; each sticker renders as its emoji with a caption (the web draws a die-cut
 * SVG; the native UI shows the emoji large on a tinted bubble). Keep this in step with src/stickers.js.
 */
data class StickerItem(val key: String, val emoji: String, val caption: String)
data class StickerPack(val id: String, val name: String, val items: List<StickerItem>)

object NativeStickers {
    const val PREFIX = "sticker:"

    val packs: List<StickerPack> = listOf(
        StickerPack(
            "moods", "Moods", listOf(
                StickerItem("moods/yay", "😄", "Yay!"), StickerItem("moods/love", "😍", "Love it"), StickerItem("moods/lol", "😂", "LOL"),
                StickerItem("moods/aww", "🥺", "Aww"), StickerItem("moods/grr", "😤", "Grr"), StickerItem("moods/cool", "😎", "Cool"),
                StickerItem("moods/hmm", "🤔", "Hmm…"), StickerItem("moods/zzz", "😴", "Zzz"), StickerItem("moods/party", "🥳", "Party!"),
                StickerItem("moods/omg", "😱", "OMG"), StickerItem("moods/wink", "😉", "Wink"), StickerItem("moods/cry", "😭", "Sob"),
            ),
        ),
        StickerPack(
            "replies", "Quick replies", listOf(
                StickerItem("replies/ok", "👍", "OK!"), StickerItem("replies/thanks", "🙏", "Thank you"), StickerItem("replies/hi", "👋", "Hi!"),
                StickerItem("replies/omw", "🏃", "On my way"), StickerItem("replies/late", "⏰", "Running late"), StickerItem("replies/done", "✅", "Done"),
                StickerItem("replies/miss", "🤗", "Miss you"), StickerItem("replies/congrats", "🎉", "Congrats!"), StickerItem("replies/coffee", "☕", "Coffee?"),
                StickerItem("replies/night", "🌙", "Good night"), StickerItem("replies/morning", "☀️", "Good morning"), StickerItem("replies/call", "📞", "Call me"),
            ),
        ),
        StickerPack(
            "hearts", "Hearts", listOf(
                StickerItem("hearts/red", "❤️", ""), StickerItem("hearts/sparkle", "💖", ""), StickerItem("hearts/fire", "❤️‍🔥", ""),
                StickerItem("hearts/two", "💕", ""), StickerItem("hearts/gift", "💝", ""), StickerItem("hearts/mend", "❤️‍🩹", ""),
                StickerItem("hearts/green", "💚", ""), StickerItem("hearts/blue", "💙", ""), StickerItem("hearts/purple", "💜", ""),
                StickerItem("hearts/yellow", "💛", ""), StickerItem("hearts/hands", "🫶", ""), StickerItem("hearts/kiss", "😘", ""),
            ),
        ),
    )

    private val byKey: Map<String, StickerItem> = packs.flatMap { it.items }.associateBy { it.key }

    /** The sticker for a "sticker:<pack>/<id>" message content, or null if not a (known) sticker. */
    fun parse(content: String?): StickerItem? {
        if (content == null || !content.startsWith(PREFIX)) return null
        return byKey[content.substring(PREFIX.length)]
    }

    fun contentFor(key: String): String = PREFIX + key
}
