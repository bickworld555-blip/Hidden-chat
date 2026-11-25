package io.github.bickworld555.hiddenchat.ui

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** One message bubble the native conversation screen shows (Step 5). `status` drives the read-receipt ticks on our own
 * sent messages ('' | sent | delivered | read | waiting); it is unused for incoming messages. `replyText` (item 4
 * replies) is the quoted snippet of the message this one replies to, shown above the bubble ("" when not a reply). */
data class MessageRowData(val id: String, val mine: Boolean, val text: String, val time: String, val status: String = "", val replyText: String = "", val reactions: List<String> = emptyList(), val myReaction: String = "", val edited: Boolean = false, val deleted: Boolean = false, val forwarded: Boolean = false, val expiresAt: Long = 0, val linkPreview: LinkPreviewData? = null, val media: MediaData? = null, val caption: String = "", val albumId: String = "", val albumIndex: Int = 0, val albumCount: Int = 0)

/** Item 5 media: the carried preview of a photo/video bubble. `preview` is the small JPEG data URL that travelled inside
 * the message (a photo's thumb or a video's poster); `kind` is "photo"/"video"; `duration` is a video length in seconds;
 * `source` is the raw attachment ref (emedia/media), used to decrypt and open the full-resolution file on tap. */
data class MediaData(val kind: String, val preview: String, val duration: Int, val source: String = "")

/** Item 6 albums: a conversation row is either one message or a grouped album run (collapsed in the list). */
private sealed interface DisplayItem {
    data class Single(val message: MessageRowData) : DisplayItem
    data class Album(val items: List<MessageRowData>) : DisplayItem
}

/** Collapses a run of consecutive same-album, same-sender media messages (the inner `al`, src/components/ChatWindow.jsx)
 *  into one [DisplayItem.Album]; everything else stays a [DisplayItem.Single]. */
private fun buildDisplayItems(messages: List<MessageRowData>): List<DisplayItem> {
    val out = ArrayList<DisplayItem>()
    var i = 0
    while (i < messages.size) {
        val m = messages[i]
        if (m.albumId.isNotEmpty() && m.media != null && !m.deleted) {
            val run = ArrayList<MessageRowData>().apply { add(m) }
            var j = i + 1
            while (j < messages.size) {
                val n = messages[j]
                if (n.albumId == m.albumId && n.mine == m.mine && n.media != null && !n.deleted) { run.add(n); j++ } else break
            }
            if (run.size >= 2) { out.add(DisplayItem.Album(run)); i = j; continue }
        }
        out.add(DisplayItem.Single(m)); i++
    }
    return out
}

/** Item 5 full-res media: the result of decrypting an attachment for the full-screen viewer. */
private sealed interface MediaOpened {
    object Loading : MediaOpened
    class Photo(val bitmap: android.graphics.Bitmap) : MediaOpened
    class Video(val file: java.io.File) : MediaOpened
    object Failed : MediaOpened
}

/** The sender-made link-preview card shown above a bubble (item 4 link previews). `thumbnail` is a small JPEG data URL
 * that travelled inside the encrypted message (recipients fetch nothing); "" when the preview has no image. */
data class LinkPreviewData(val url: String, val title: String, val description: String, val siteName: String, val host: String, val video: Boolean, val thumbnail: String)

/**
 * The native conversation screen (Step 5). A back-navigable top bar, a scrollable list of message bubbles (mine on the
 * right, the other person's on the left), and a composer. The messages come from the native store (mirrored from the
 * web app for the chat that was open there). SENDING IS NOT WIRED YET — the composer is present but the send button is
 * a stub until the native send/encrypt path is built; the WebView path still owns sending.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    title: String,
    messages: List<MessageRowData>,
    onBack: () -> Unit,
    // Item 4 replies: the second argument is the id of the message being replied to, or null for a normal send.
    onSend: (String, String?) -> Unit = { _, _ -> },
    loading: Boolean = false,
    // Checklist item 4: the peer's live activity ("typing…"/"recording audio…") shown under the name, and a callback on
    // every edit of the message box so the native-owned socket can announce our own "typing…". Both default off/no-op.
    typingLabel: String = "",
    onDraft: (String) -> Unit = {},
    // Item 4 reactions: (messageId, emoji) — long-press a bubble to react. Default no-op.
    onReact: (String, String) -> Unit = { _, _ -> },
    // Item 4 edit/delete: (messageId, newText) to save an edit; (messageId) to delete for everyone. Default no-op.
    onEdit: (String, String) -> Unit = { _, _ -> },
    onDelete: (String) -> Unit = {},
    // Item 4 forwarding: open the chat picker to forward this message. Default no-op.
    onForward: (MessageRowData) -> Unit = {},
    // Item 4 multi-select: forward every selected message, or delete-for-everyone the selected ids. Default no-op.
    onForwardMany: (List<MessageRowData>) -> Unit = {},
    onDeleteMany: (List<String>) -> Unit = {},
    // Item 4 disappearing: the chat's current timer in seconds (0 = off), and a callback to change it (Off/24h/7d/90d).
    disappearSeconds: Long = 0,
    onSetDisappear: (Long) -> Unit = {},
) {
    var draft by remember { mutableStateOf("") }
    // Item 4 multi-select: the ids of the messages currently selected (empty = not in selection mode). Kept as ids and
    // resolved against the live list in chat order, so a message deleted/expired meanwhile simply drops out.
    var selectedIds by remember { mutableStateOf(setOf<String>()) }
    val selectionActive = selectedIds.isNotEmpty()
    val clearSelection = { selectedIds = emptySet() }
    val selectedMessages = messages.filter { it.id in selectedIds }
    // Back clears the selection first (like the web useBackHandler), rather than leaving the chat.
    androidx.activity.compose.BackHandler(enabled = selectionActive) { clearSelection() }
    // Item 4 replies: the message currently being replied to (long-press a bubble to set it), shown as a quote bar above
    // the composer and carried in the next send.
    var replyingTo by remember { mutableStateOf<MessageRowData?>(null) }
    // Item 4 edit: the message currently being edited (its text is loaded into the composer); send saves the edit.
    var editingMessage by remember { mutableStateOf<MessageRowData?>(null) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            // Item 4 multi-select: while messages are selected, the top bar becomes a selection bar (count + bulk
            // Forward / Delete-for-everyone), like WhatsApp; otherwise the normal chat header.
            if (selectionActive) {
                val allMineLive = selectedMessages.isNotEmpty() && selectedMessages.all { it.mine && !it.deleted }
                TopAppBar(
                    title = { Text("${selectedIds.size} selected", fontWeight = FontWeight.SemiBold, maxLines = 1) },
                    navigationIcon = {
                        IconButton(onClick = clearSelection) {
                            Text("✕", color = MaterialTheme.colorScheme.onSurface, fontSize = 20.sp)
                        }
                    },
                    actions = {
                        IconButton(onClick = { onForwardMany(selectedMessages); clearSelection() }) {
                            Text("↪", color = MaterialTheme.colorScheme.onSurface, fontSize = 20.sp)
                        }
                        // Delete-for-everyone only when every selected message is my own, non-deleted one (the server
                        // still enforces the 24h window; a too-old one is simply ignored).
                        if (allMineLive) {
                            IconButton(onClick = { onDeleteMany(selectedMessages.map { it.id }); clearSelection() }) {
                                Text("🗑", color = MaterialTheme.colorScheme.onSurface, fontSize = 18.sp)
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                )
            } else {
                TopAppBar(
                    title = {
                        Column {
                            Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            // The typing line wins; otherwise, if a disappearing timer is on, show it under the name.
                            when {
                                typingLabel.isNotEmpty() -> Text(typingLabel, color = MaterialTheme.colorScheme.primary, fontSize = 12.sp, maxLines = 1)
                                disappearSeconds > 0 -> Text("⏱ Disappearing: ${disappearLabel(disappearSeconds)}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, maxLines = 1)
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Text("←", color = MaterialTheme.colorScheme.onSurface, fontSize = 22.sp)
                        }
                    },
                    actions = {
                        // Item 4 disappearing: the ⏱ menu to set this chat's timer.
                        var timerMenu by remember { mutableStateOf(false) }
                        IconButton(onClick = { timerMenu = true }) {
                            Text("⏱", color = if (disappearSeconds > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontSize = 18.sp)
                        }
                        DropdownMenu(expanded = timerMenu, onDismissRequest = { timerMenu = false }) {
                            for ((seconds, label) in DISAPPEAR_CHOICES) {
                                DropdownMenuItem(
                                    text = { Text(if (seconds == disappearSeconds) "✓ $label" else label) },
                                    onClick = { onSetDisappear(seconds); timerMenu = false },
                                )
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                )
            }
        },
        bottomBar = {
            Column(modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
                // Item 4 edit: the "Editing" banner while editing a message, with a cancel.
                val editing = editingMessage
                if (editing != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Editing message", color = MaterialTheme.colorScheme.primary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(editing.text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, maxLines = 1)
                        }
                        IconButton(onClick = { editingMessage = null; draft = "" }) {
                            Text("✕", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
                        }
                    }
                }
                // Item 4 replies: the quote bar above the composer while replying (not while editing), with a cancel.
                val replying = if (editing == null) replyingTo else null
                if (replying != null) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(if (replying.mine) "You" else title, color = MaterialTheme.colorScheme.primary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(replying.text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, maxLines = 1)
                        }
                        IconButton(onClick = { replyingTo = null }) {
                            Text("✕", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
                        }
                    }
                }
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = draft,
                        // Each edit announces "typing…" to the peer (onDraft → the native-owned socket), item 4.
                        onValueChange = { draft = it; onDraft(it) },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Message") },
                        maxLines = 4,
                        keyboardActions = KeyboardActions(onSend = {}),
                    )
                    IconButton(
                        // Editing a message saves the edit; otherwise the native E2E path seals + relays a new message.
                        onClick = {
                            val text = draft.trim()
                            if (text.isNotEmpty()) {
                                val editing = editingMessage
                                if (editing != null) { onEdit(editing.id, text); editingMessage = null } else { onSend(text, replyingTo?.id); replyingTo = null }
                                draft = ""; onDraft("")
                            }
                        },
                        enabled = draft.isNotBlank(),
                    ) {
                        Text(
                            "➤",
                            color = if (draft.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 20.sp,
                        )
                    }
                }
            }
        },
    ) { padding ->
        if (messages.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    if (loading) "Loading…" else "No messages",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 15.sp,
                )
            }
        } else {
            // Open at (and follow) the newest message, like any chat app, rather than the oldest at the top.
            // Item 6 albums: a run of same-album media from one sender collapses into one grouped display row.
            val displayItems = remember(messages) { buildDisplayItems(messages) }
            val listState = androidx.compose.foundation.lazy.rememberLazyListState()
            androidx.compose.runtime.LaunchedEffect(displayItems.size) {
                if (displayItems.isNotEmpty()) listState.scrollToItem(displayItems.size - 1)
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(displayItems) { _, item ->
                    when (item) {
                        is DisplayItem.Album -> AlbumMessageBubble(item.items)
                        is DisplayItem.Single -> {
                            val message = item.message
                            MessageBubble(
                                message,
                                onReply = { replyingTo = message },
                                onReact = { emoji -> onReact(message.id, emoji) },
                                onEditStart = { editingMessage = message; draft = message.text; replyingTo = null },
                                onDelete = { onDelete(message.id) },
                                onForward = { onForward(message) },
                                // Item 4 multi-select: tap toggles while selecting; "Select" in the menu starts it.
                                selectionActive = selectionActive,
                                selected = message.id in selectedIds,
                                onToggleSelect = {
                                    selectedIds = if (message.id in selectedIds) selectedIds - message.id else selectedIds + message.id
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Item 5 media: the photo/video preview that travelled inside the message (a photo's 48px thumb or a video's 320px
 * poster — a small JPEG, never the ciphertext file). Rendered in the bubble instead of a "📷 Photo" text label; a video
 * shows a ▶ badge and its length. Tapping enlarges the preview full-screen. (Full-resolution open needs native media
 * decryption, a separate step; this shows the carried preview the sender included.)
 */
@Composable
private fun MediaCard(media: MediaData) {
    val bitmap = remember(media.preview) {
        runCatching {
            val base64 = media.preview.substringAfter("base64,", "")
            if (base64.isEmpty()) return@runCatching null
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    } ?: return
    var enlarged by remember { mutableStateOf(false) }
    val isVideo = media.kind == "video"
    Box(
        modifier = Modifier
            .padding(bottom = 2.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable { enlarged = true },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = if (isVideo) "Video" else "Photo",
            contentScale = ContentScale.Crop,
            modifier = Modifier.widthIn(max = 240.dp).heightIn(min = 120.dp, max = 300.dp),
        )
        if (isVideo) {
            Text(
                "▶",
                color = androidx.compose.ui.graphics.Color.White,
                fontSize = 26.sp,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.55f))
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            )
            if (media.duration > 0) {
                Text(
                    mediaDurationLabel(media.duration),
                    color = androidx.compose.ui.graphics.Color.White,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.55f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
    if (enlarged) MediaViewerDialog(media) { enlarged = false }
}

/**
 * Item 5/6 full-resolution viewer (shared by a single photo/video bubble and an album item): decrypts the attachment
 * natively (NativeMediaCrypto — the ciphertext file + its per-file key; never the E2E ratchet) OFF the main thread,
 * showing the carried preview thumbnail + a spinner meanwhile. A photo shows its full-res bitmap; a video plays from a
 * decrypted temp file (deleted when the viewer closes). Tap outside to dismiss.
 */
@Composable
private fun MediaViewerDialog(media: MediaData, onClose: () -> Unit) {
    val placeholder = remember(media.preview) {
        runCatching {
            val base64 = media.preview.substringAfter("base64,", "")
            if (base64.isEmpty()) return@runCatching null
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
    val context = LocalContext.current
    val opened by androidx.compose.runtime.produceState<MediaOpened>(MediaOpened.Loading, media.source, media.kind) {
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            try {
                if (media.kind == "video") {
                    io.github.bickworld555.hiddenchat.NativeMediaCrypto.decryptedToTempFile(context, media.source, ".mp4")
                        ?.let { MediaOpened.Video(it) } ?: MediaOpened.Failed
                } else {
                    val bytes = io.github.bickworld555.hiddenchat.NativeMediaCrypto.decryptedBytes(context, media.source)
                    bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }?.let { MediaOpened.Photo(it) } ?: MediaOpened.Failed
                }
            } catch (failed: Throwable) {
                MediaOpened.Failed
            }
        }
    }
    // Delete a decrypted video temp file once the viewer is gone. Key the effect on the file itself and capture it
    // by value — keying on `opened` and re-reading it in onDispose would read the *new* value during the
    // Loading→Video transition and delete the freshly-decrypted file before the player ever opens it (ENOENT).
    val videoFile = (opened as? MediaOpened.Video)?.file
    androidx.compose.runtime.DisposableEffect(videoFile) {
        onDispose { videoFile?.delete() }
    }
    val aspect = placeholder?.let { it.width.toFloat() / it.height.coerceAtLeast(1) } ?: (16f / 9f)
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.95f))
                .clickable { onClose() },
            contentAlignment = Alignment.Center,
        ) {
            when (val result = opened) {
                is MediaOpened.Photo -> Image(
                    bitmap = result.bitmap.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                )
                is MediaOpened.Video -> VideoPlayer(result.file, aspect)
                MediaOpened.Failed -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    placeholder?.let { Image(bitmap = it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.widthIn(max = 240.dp).padding(8.dp)) }
                    Text("Couldn't open this media.", color = androidx.compose.ui.graphics.Color.White, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
                }
                MediaOpened.Loading -> Box(contentAlignment = Alignment.Center) {
                    placeholder?.let { Image(bitmap = it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.widthIn(max = 240.dp).padding(8.dp)) }
                    androidx.compose.material3.CircularProgressIndicator(color = androidx.compose.ui.graphics.Color.White)
                }
            }
        }
    }
}

/**
 * Item 5 full-resolution video playback: plays a decrypted temp file on a [android.view.TextureView] driven by a
 * [android.media.MediaPlayer]. A TextureView (not VideoView's SurfaceView) is used deliberately — a SurfaceView cannot
 * get a valid surface inside a Compose [androidx.compose.ui.window.Dialog] window, so VideoView reports "Can't play
 * this video" even though the decrypt succeeded. `aspect` (width/height, from the carried poster) keeps the frame from
 * stretching. The player is released when the viewer closes; looping playback starts automatically once prepared.
 */
@Composable
private fun VideoPlayer(file: java.io.File, aspect: Float) {
    val player = remember { android.media.MediaPlayer() }
    val ready = remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.DisposableEffect(file) {
        onDispose { runCatching { player.reset() }; runCatching { player.release() } }
    }
    androidx.compose.ui.viewinterop.AndroidView(
        modifier = Modifier
            .fillMaxWidth()
            .padding(8.dp)
            .aspectRatio(if (aspect.isFinite() && aspect > 0f) aspect else 16f / 9f),
        factory = { ctx ->
            android.view.TextureView(ctx).apply {
                surfaceTextureListener = object : android.view.TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(st: android.graphics.SurfaceTexture, width: Int, height: Int) {
                        runCatching {
                            player.setSurface(android.view.Surface(st))
                            player.setDataSource(file.absolutePath)
                            player.isLooping = true
                            player.setOnPreparedListener { it.start(); ready.value = true }
                            player.setOnErrorListener { _, what, extra ->
                                android.util.Log.w("VideoPlayer", "MediaPlayer error what=$what extra=$extra")
                                false
                            }
                            player.prepareAsync()
                        }.onFailure { android.util.Log.w("VideoPlayer", "setup failed", it) }
                    }
                    override fun onSurfaceTextureSizeChanged(st: android.graphics.SurfaceTexture, width: Int, height: Int) {}
                    override fun onSurfaceTextureDestroyed(st: android.graphics.SurfaceTexture): Boolean = true
                    override fun onSurfaceTextureUpdated(st: android.graphics.SurfaceTexture) {}
                }
            }
        },
    )
}

private fun mediaDurationLabel(seconds: Int): String = "%d:%02d".format(seconds / 60, seconds % 60)

// --- Item 6: voice notes, documents, albums (captions are rendered in MessageBubble) ---------------------------------

/** src/voice.js waveformPeaks — a deterministic 40-bar waveform from the voice id (seed), matching the web exactly. */
private fun waveformPeaks(seed: String, count: Int = 40): IntArray {
    var state = 0L
    for (ch in seed) state = (state * 31L + ch.code.toLong()) and 0xFFFFFFFFL
    return IntArray(count) {
        state = (state * 1664525L + 1013904223L) and 0xFFFFFFFFL
        (18 + (state % 82L)).toInt()
    }
}

/** src/media.js formatFileSize (WhatsApp-style): "820 KB", "0.90 MB", "4.2 MB". */
private fun formatFileSize(bytes: Long): String {
    if (bytes < 0) return ""
    if (bytes < 1024) return "$bytes B"
    if (bytes in (100L * 1024L) until (1024L * 1024L)) return String.format(java.util.Locale.US, "%.2f MB", bytes / (1024.0 * 1024.0))
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes / 1024.0
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) { value /= 1024.0; unit++ }
    return if (value >= 100) "${Math.round(value)} ${units[unit]}" else "${Math.round(value * 10) / 10.0} ${units[unit]}"
}

/**
 * One active voice-note player at a time: starting one pauses any other (WhatsApp-style exclusive playback), with audio
 * focus and leak-free cleanup (the decrypted temp file is deleted on stop/replace). State is Compose-observable so each
 * bubble re-renders its play/pause + progress. The audio is decrypted off the main thread by the caller; ExoPlayer runs
 * on the main thread (all calls here are main-thread). ExoPlayer (not MediaPlayer) is used because it seeks the
 * WebView-recorded webm/opus voice notes (which carry no seek index) and manages audio focus itself.
 */
private object VoicePlayback {
    data class St(val id: String = "", val playing: Boolean = false, val positionMs: Int = 0, val durationMs: Int = 0, val preparing: Boolean = false, val error: Boolean = false)
    private val _state = mutableStateOf(St())
    val state: androidx.compose.runtime.State<St> get() = _state
    private var player: androidx.media3.exoplayer.ExoPlayer? = null
    private var tempFile: java.io.File? = null
    private var ticker: kotlinx.coroutines.Job? = null
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main.immediate)

    fun isActive(id: String): Boolean = _state.value.id == id && player != null

    fun stop() {
        stopTicker()
        player?.let { runCatching { it.release() } }; player = null
        tempFile?.let { runCatching { it.delete() } }; tempFile = null
        _state.value = St()
    }

    /** Resume or pause the currently active note. */
    fun toggle(context: Context, id: String) {
        val p = player ?: return
        if (_state.value.id != id) return
        if (p.isPlaying) { p.pause(); stopTicker(); _state.value = _state.value.copy(playing = false) }
        else { p.play(); startTicker(); _state.value = _state.value.copy(playing = true) }
    }

    /** Start a fresh note from its already-decrypted file (stops/replaces any other). [fallbackMs] is the length from
     *  the message (src/voice.js seconds) — used when the container reports no duration (webm/opus), so seek still works. */
    fun start(context: Context, id: String, decrypted: java.io.File, fallbackMs: Int) {
        stop()
        tempFile = decrypted
        try {
            val p = androidx.media3.exoplayer.ExoPlayer.Builder(context).build()
            // ExoPlayer requests/abandons audio focus itself (handleAudioFocus = true).
            p.setAudioAttributes(
                androidx.media3.common.AudioAttributes.Builder()
                    .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                    .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                true,
            )
            p.addListener(object : androidx.media3.common.Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == androidx.media3.common.Player.STATE_READY) {
                        val dur = if (p.duration > 0) p.duration.toInt() else fallbackMs
                        _state.value = _state.value.copy(durationMs = dur.coerceAtLeast(0), preparing = false)
                    } else if (playbackState == androidx.media3.common.Player.STATE_ENDED) {
                        runCatching { p.seekTo(0); p.pause() }; stopTicker()
                        _state.value = _state.value.copy(playing = false, positionMs = 0)
                    }
                }
                override fun onIsPlayingChanged(isPlaying: Boolean) { _state.value = _state.value.copy(playing = isPlaying) }
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                    android.util.Log.w("VoicePlayback", "exo error", error); _state.value = St(id = id, error = true)
                }
            })
            p.setMediaItem(androidx.media3.common.MediaItem.fromUri(android.net.Uri.fromFile(decrypted)))
            player = p
            _state.value = St(id = id, preparing = true)
            p.prepare()
            p.playWhenReady = true
            startTicker()
        } catch (e: Throwable) {
            android.util.Log.w("VoicePlayback", "start failed", e); _state.value = St(id = id, error = true)
        }
    }

    fun seekFraction(id: String, fraction: Float) {
        val p = player ?: return
        if (_state.value.id != id) return
        val dur = _state.value.durationMs
        if (dur <= 0) return
        val pos = (fraction.coerceIn(0f, 1f) * dur).toInt()
        runCatching { p.seekTo(pos.toLong()) }
        _state.value = _state.value.copy(positionMs = pos)
    }

    private fun startTicker() {
        stopTicker()
        ticker = scope.launch {
            while (true) {
                val p = player ?: break
                if (p.isPlaying) _state.value = _state.value.copy(positionMs = p.currentPosition.toInt())
                kotlinx.coroutines.delay(100)
            }
        }
    }
    private fun stopTicker() { ticker?.cancel(); ticker = null }
}

/** Item 6 voice note: waveform (ported waveformPeaks) + play/pause/seek + elapsed/total; decrypts off-main to a temp
 *  file played through [VoicePlayback] (single active note, audio focus, temp cleaned up). */
@Composable
private fun VoiceNoteBubble(media: MediaData, mine: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val info = remember(media.source) { io.github.bickworld555.hiddenchat.NativeMediaCrypto.voiceInfo(media.source) }
    val voiceId = info?.first ?: ""
    val totalSeconds = (info?.second ?: media.duration).coerceAtLeast(0)
    val peaks = remember(voiceId) { waveformPeaks(voiceId) }
    val playback by VoicePlayback.state
    val isThis = voiceId.isNotEmpty() && playback.id == voiceId
    val playing = isThis && playback.playing
    val preparing = isThis && playback.preparing
    val durationMs = if (isThis && playback.durationMs > 0) playback.durationMs else totalSeconds * 1000
    val positionMs = if (isThis) playback.positionMs else 0
    val progress = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    val onColor = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    val playedColor = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.primary
    val unplayedColor = onColor.copy(alpha = 0.3f)
    var decrypting by remember { mutableStateOf(false) }

    fun onPlayPause() {
        if (voiceId.isEmpty()) return
        if (VoicePlayback.isActive(voiceId)) { VoicePlayback.toggle(context, voiceId); return }
        decrypting = true
        scope.launch {
            // Decrypt, then decode the webm/opus to a seekable WAV off the main thread (the recorded container has no
            // cue points, so players can't seek it directly). Play the WAV so seek works; same audio.
            val wav = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val enc = io.github.bickworld555.hiddenchat.NativeMediaCrypto.decryptedToTempFile(context, media.source, ".webm") ?: return@withContext null
                val out = java.io.File.createTempFile("hm-voice-", ".wav", context.cacheDir)
                val ok = io.github.bickworld555.hiddenchat.AudioDecode.decodeToWav(enc, out)
                enc.delete()
                if (ok) out else { out.delete(); null }
            }
            decrypting = false
            if (wav != null) VoicePlayback.start(context, voiceId, wav, totalSeconds * 1000)
        }
    }

    Row(
        modifier = Modifier.widthIn(min = 210.dp, max = 260.dp).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(40.dp).clip(CircleShape)
                .background(if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.2f) else MaterialTheme.colorScheme.primary.copy(alpha = 0.15f))
                .clickable { onPlayPause() },
            contentAlignment = Alignment.Center,
        ) {
            if (preparing || decrypting) androidx.compose.material3.CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = playedColor)
            else Text(if (playing) "⏸" else "▶", color = playedColor, fontSize = 18.sp)
        }
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            // The seek pointer input lives on the Box (not the Canvas) and gives it a taller 44dp touch target so a tap
            // anywhere over the waveform reliably seeks; the Canvas inside only draws. seekFraction no-ops unless this
            // note is the active player.
            Box(
                modifier = Modifier.fillMaxWidth().height(44.dp).pointerInput(voiceId) {
                    detectTapGestures { offset -> VoicePlayback.seekFraction(voiceId, offset.x / size.width) }
                },
                contentAlignment = Alignment.Center,
            ) {
                Canvas(modifier = Modifier.fillMaxWidth().height(30.dp)) {
                    val n = peaks.size
                    val gap = 2.dp.toPx()
                    val barW = ((size.width - gap * (n - 1)) / n).coerceAtLeast(1f)
                    for (i in 0 until n) {
                        val h = size.height * (peaks[i] / 100f)
                        val x = i * (barW + gap)
                        val played = i.toFloat() / n < progress
                        drawRect(color = if (played) playedColor else unplayedColor, topLeft = Offset(x, (size.height - h) / 2f), size = Size(barW, h))
                    }
                }
            }
            Spacer(Modifier.height(2.dp))
            Text(
                if (playing || positionMs > 0) "${mediaDurationLabel(positionMs / 1000)} / ${mediaDurationLabel(totalSeconds)}" else mediaDurationLabel(totalSeconds),
                color = onColor.copy(alpha = 0.7f), fontSize = 11.sp,
            )
        }
        if (isThis && playback.error) {
            Spacer(Modifier.width(6.dp))
            Text("!", color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
    }
}

/** Item 6 document: a file card (type badge + name + size) that, on tap, decrypts off-main to a FileProvider-backed
 *  cache file and opens it via an ACTION_VIEW Intent (with a clear message when no app can handle it). */
@Composable
private fun DocumentBubble(media: MediaData, mine: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val info = remember(media.source) { io.github.bickworld555.hiddenchat.NativeMediaCrypto.documentInfo(media.source) }
    val filename = info?.first ?: "attachment"
    val sizeBytes = info?.second ?: 0L
    val mime = info?.third ?: ""
    val ext = filename.substringAfterLast('.', "").uppercase(java.util.Locale.US).take(5).ifEmpty { "FILE" }
    var status by remember { mutableStateOf("") } // "" | loading | error | nohandler
    val onColor = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface

    fun open() {
        if (status == "loading") return
        status = "loading"
        scope.launch {
            val file = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                io.github.bickworld555.hiddenchat.NativeMediaCrypto.decryptedDocument(context, media.source, filename)
            }
            if (file == null) { status = "error"; return@launch }
            val uri = try {
                androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            } catch (e: Throwable) { android.util.Log.w("DocumentBubble", "fileprovider", e); status = "error"; return@launch }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime.ifEmpty { "application/octet-stream" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try { context.startActivity(intent); status = "" }
            catch (e: android.content.ActivityNotFoundException) { status = "nohandler" }
        }
    }

    Row(
        modifier = Modifier.widthIn(max = 260.dp).clip(RoundedCornerShape(8.dp))
            .background(if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
            .clickable { open() }.padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(40.dp).clip(RoundedCornerShape(6.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)),
            contentAlignment = Alignment.Center,
        ) { Text("📄", fontSize = 18.sp) }
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(filename, color = onColor, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val meta = listOf(ext, formatFileSize(sizeBytes)).filter { it.isNotEmpty() }.joinToString(" • ") +
                when (status) { "loading" -> " • Opening…"; "error" -> " • Couldn't open"; "nohandler" -> " • No app to open this"; else -> "" }
            Text(meta, color = onColor.copy(alpha = 0.6f), fontSize = 11.sp)
        }
    }
}

/** Item 6 album: a run of same-album photos/videos drawn as one grouped bubble (2–3 in a row, 4+ as a 2×2 grid with a
 *  "+N" overflow on the last tile). Tapping a tile opens it in the shared full-res [MediaViewerDialog]. */
@Composable
private fun AlbumBubble(items: List<MediaData>, mine: Boolean) {
    var opened by remember { mutableStateOf<MediaData?>(null) }
    val shown = items.take(4)
    val overflow = items.size - shown.size
    Column(modifier = Modifier.width(220.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        shown.chunked(2).forEachIndexed { rowIdx, rowItems ->
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.fillMaxWidth()) {
                rowItems.forEachIndexed { colIdx, item ->
                    val globalIdx = rowIdx * 2 + colIdx
                    val isLastShown = globalIdx == shown.size - 1
                    AlbumTile(item, if (isLastShown) overflow else 0, Modifier.weight(1f)) { opened = item }
                }
                if (rowItems.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
    opened?.let { MediaViewerDialog(it) { opened = null } }
}

@Composable
private fun AlbumTile(item: MediaData, overflow: Int, modifier: Modifier, onClick: () -> Unit) {
    val bitmap = remember(item.preview) {
        runCatching {
            val b = item.preview.substringAfter("base64,", "")
            if (b.isEmpty()) return@runCatching null
            val bytes = Base64.decode(b, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
    Box(modifier = modifier.aspectRatio(1f).clip(RoundedCornerShape(6.dp)).clickable { onClick() }, contentAlignment = Alignment.Center) {
        if (bitmap != null) Image(bitmap.asImageBitmap(), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant))
        if (item.kind == "video" && overflow <= 0) {
            Text("▶", color = Color.White, fontSize = 20.sp, modifier = Modifier.clip(CircleShape).background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.5f)).padding(horizontal = 10.dp, vertical = 3.dp))
        }
        if (overflow > 0) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
            Text("+$overflow", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
    }
}

/** Item 6: one album run drawn as a single conversation row (aligned mine/theirs), with the album caption and time of
 *  its last item beneath — mirrors the web album bubble (src/components/MediaRenderer.jsx MediaAlbum). */
@Composable
private fun AlbumMessageBubble(items: List<MessageRowData>) {
    val anchor = items.first()
    val mine = anchor.mine
    val caption = items.firstNotNullOfOrNull { it.caption.ifEmpty { null } } ?: ""
    val time = items.last().time
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                    .padding(4.dp),
            ) {
                Column {
                    AlbumBubble(items.mapNotNull { it.media }, mine)
                    if (caption.isNotEmpty()) {
                        Text(
                            caption,
                            color = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(top = 4.dp, start = 4.dp, end = 4.dp),
                        )
                    }
                    if (time.isNotEmpty()) {
                        Text(
                            time,
                            color = (if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant).copy(alpha = 0.7f),
                            fontSize = 10.sp,
                            modifier = Modifier.align(Alignment.End).padding(top = 2.dp, end = 4.dp, bottom = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Item 4 link previews: WhatsApp's card for a link the sender shared. The card (title/description/site + an optional
 * thumbnail) travelled INSIDE the encrypted message, so nothing is fetched here. Tapping opens the link externally.
 */
@Composable
private fun LinkPreviewCard(preview: LinkPreviewData, mine: Boolean) {
    val context = LocalContext.current
    val bitmap = remember(preview.thumbnail) {
        val data = preview.thumbnail
        if (data.isEmpty()) {
            null
        } else {
            runCatching {
                val base64 = data.substringAfter("base64,", "")
                if (base64.isEmpty()) return@runCatching null
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        }
    }
    val tint = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    Column(
        modifier = Modifier
            .padding(bottom = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
            .clickable {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(preview.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            },
    ) {
        if (bitmap != null) {
            Box {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().height(140.dp),
                )
                if (preview.video) {
                    Text(
                        "▶",
                        color = MaterialTheme.colorScheme.onPrimary,
                        fontSize = 20.sp,
                        modifier = Modifier
                            .align(Alignment.Center)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.5f))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
            }
        }
        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            if (preview.title.isNotEmpty()) {
                Text(preview.title, color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (preview.description.isNotEmpty() && preview.description != preview.title) {
                Text(preview.description, color = tint.copy(alpha = 0.75f), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            val site = preview.siteName.ifEmpty { preview.host }
            if (site.isNotEmpty()) {
                Text("🔗 $site", color = tint.copy(alpha = 0.55f), fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

// The reactions the long-press menu offers (WhatsApp's default set).
private val REACTION_EMOJIS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

// Item 4 disappearing: the timer choices the ⏱ menu offers (seconds → label); the server accepts only these.
private val DISAPPEAR_CHOICES = listOf(0L to "Off", 86400L to "24 hours", 604800L to "7 days", 7776000L to "90 days")
private fun disappearLabel(seconds: Long): String = when (seconds) {
    86400L -> "24h"; 604800L -> "7d"; 7776000L -> "90d"; else -> "Off"
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: MessageRowData,
    onReply: () -> Unit = {},
    onReact: (String) -> Unit = {},
    onEditStart: () -> Unit = {},
    onDelete: () -> Unit = {},
    onForward: () -> Unit = {},
    // Item 4 multi-select: whether the screen is in selection mode, whether THIS message is selected, and a toggle.
    selectionActive: Boolean = false,
    selected: Boolean = false,
    onToggleSelect: () -> Unit = {},
) {
    val mine = message.mine
    // A faint band behind the whole row marks a selected message (and the row the selection menu can act on).
    val rowBackground = if (selected) Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)) else Modifier
    // Item 4 delete-for-everyone: a deleted message shows a plain italic placeholder — no menu, reactions, reply or ticks.
    if (message.deleted) {
        Row(
            modifier = Modifier.fillMaxWidth().then(rowBackground),
            horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        ) {
            Text(
                "🚫 This message was deleted",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 14.sp,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f) else MaterialTheme.colorScheme.surfaceVariant)
                    // While selecting, a deleted placeholder can still be toggled (e.g. to forward the rest).
                    .combinedClickable(onClick = { if (selectionActive) onToggleSelect() }, onLongClick = { onToggleSelect() })
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        return
    }
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().then(rowBackground),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Item 4 multi-select: a leading check while selecting (filled when this message is selected).
        if (selectionActive) {
            Text(
                if (selected) "☑" else "☐",
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 18.sp,
                modifier = Modifier.padding(end = 6.dp),
            )
        }
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            Box {
                Column(
                    modifier = Modifier
                        .widthIn(max = 300.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                        // Tap toggles selection while selecting; otherwise long-press opens the reaction + reply menu (item 4).
                        .combinedClickable(
                            onClick = { if (selectionActive) onToggleSelect() },
                            onLongClick = { if (selectionActive) onToggleSelect() else menuOpen = true },
                        )
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    // Item 4 forwarding: the "Forwarded" label above the content.
                    if (message.forwarded) {
                        Text(
                            "↪ Forwarded",
                            color = (if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface).copy(alpha = 0.6f),
                            fontSize = 11.sp,
                            fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                            modifier = Modifier.padding(bottom = 2.dp),
                        )
                    }
                    // Item 4 replies: the quoted snippet of the message this one replies to, above the text.
                    if (message.replyText.isNotEmpty()) {
                        Column(
                            modifier = Modifier
                                .padding(bottom = 4.dp)
                                .clip(RoundedCornerShape(6.dp))
                                .background(if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.15f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text(
                                message.replyText,
                                color = (if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface).copy(alpha = 0.75f),
                                fontSize = 12.sp,
                                maxLines = 2,
                            )
                        }
                    }
                    // Item 4 link previews: the sender-made card above the text (nothing is fetched — the thumbnail,
                    // if any, came inside the encrypted message). Tapping it opens the link.
                    message.linkPreview?.let { LinkPreviewCard(it, mine) }
                    // Item 5/6 media: render the right native bubble by kind — a photo/video shows its preview (tap →
                    // full-res viewer), a voice note shows a waveform player, a document shows a file card. Anything
                    // else (text, or media without a native bubble) falls back to the text label.
                    val media = message.media
                    val showText = when {
                        media == null -> true
                        media.kind == "voice" -> { VoiceNoteBubble(media, mine); false }
                        media.kind == "doc" -> { DocumentBubble(media, mine); false }
                        media.preview.isNotEmpty() -> { MediaCard(media); false }
                        else -> true
                    }
                    if (showText) {
                        Text(
                            message.text,
                            color = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            fontSize = 15.sp,
                        )
                    }
                    // Item 6 caption (inner cp): the photo/video/document caption, beneath the media.
                    if (media != null && message.caption.isNotEmpty()) {
                        Text(
                            message.caption,
                            color = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(top = 3.dp).widthIn(max = 280.dp),
                        )
                    }
                    if (message.time.isNotEmpty() || message.edited || message.expiresAt > 0 || (mine && message.status.isNotEmpty())) {
                        Row(
                            modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            // Item 4 disappearing: a ⏱ on a message that will disappear.
                            if (message.expiresAt > 0) {
                                Text(
                                    "⏱",
                                    color = (if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant).copy(alpha = 0.7f),
                                    fontSize = 10.sp,
                                    modifier = Modifier.padding(end = 4.dp),
                                )
                            }
                            // Item 4 edit: the "edited" label before the time.
                            if (message.edited) {
                                Text(
                                    "edited",
                                    color = if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.6f) else MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontSize = 10.sp,
                                    fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                                    modifier = Modifier.padding(end = 4.dp),
                                )
                            }
                            if (message.time.isNotEmpty()) {
                                Text(
                                    message.time,
                                    color = if (mine) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f) else MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontSize = 10.sp,
                                )
                            }
                            // Read-receipt ticks, only on our own messages (item 4): ✓ sent, ✓✓ delivered, ✓✓ (blue) read.
                            if (mine) {
                                val ticks = statusTicks(message.status)
                                if (ticks.isNotEmpty()) {
                                    Text(
                                        ticks,
                                        color = if (message.status == "read") ReadTickColor else MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f),
                                        fontSize = 11.sp,
                                        modifier = Modifier.padding(start = 4.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                // Item 4 reactions: long-press menu — a row of emojis to react with, plus Reply.
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    Row(modifier = Modifier.padding(horizontal = 8.dp)) {
                        for (emoji in REACTION_EMOJIS) {
                            val isMine = emoji == message.myReaction
                            Text(
                                emoji,
                                fontSize = 22.sp,
                                modifier = Modifier
                                    .clip(CircleShape)
                                    // Tapping the emoji I already reacted with removes it (toggle off, "" = remove).
                                    .background(if (isMine) MaterialTheme.colorScheme.primary.copy(alpha = 0.25f) else androidx.compose.ui.graphics.Color.Transparent)
                                    .clickable { onReact(if (isMine) "" else emoji); menuOpen = false }
                                    .padding(6.dp),
                            )
                        }
                    }
                    DropdownMenuItem(text = { Text("Reply") }, onClick = { onReply(); menuOpen = false })
                    // Item 4 forwarding: any message can be forwarded to another chat.
                    DropdownMenuItem(text = { Text("Forward") }, onClick = { onForward(); menuOpen = false })
                    // Item 4 multi-select: start selection mode with this message selected.
                    DropdownMenuItem(text = { Text("Select") }, onClick = { onToggleSelect(); menuOpen = false })
                    // Item 4 edit/delete: only on my own messages (the server enforces sender-only + the time windows).
                    if (mine) {
                        DropdownMenuItem(text = { Text("Edit") }, onClick = { onEditStart(); menuOpen = false })
                        DropdownMenuItem(text = { Text("Delete for everyone") }, onClick = { onDelete(); menuOpen = false })
                    }
                }
            }
            // Item 4 reactions: chips under the bubble — each distinct emoji with a count when more than one.
            if (message.reactions.isNotEmpty()) {
                Row(modifier = Modifier.padding(top = 2.dp)) {
                    for ((emoji, count) in message.reactions.groupingBy { it }.eachCount()) {
                        Text(
                            if (count > 1) "$emoji $count" else emoji,
                            fontSize = 13.sp,
                            modifier = Modifier
                                .padding(end = 4.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(horizontal = 6.dp, vertical = 1.dp),
                        )
                    }
                }
            }
        }
    }
}

// A light blue for the "read" double-tick that reads on the primary-coloured bubble (WhatsApp shows blue read ticks).
private val ReadTickColor = androidx.compose.ui.graphics.Color(0xFF4FC3F7)

/** The tick glyph for a sent message's status: ✓ sent, ✓✓ delivered/read, ⧗ waiting, ✕ failed, none when unknown. */
private fun statusTicks(status: String): String = when (status) {
    "read", "delivered" -> "✓✓"
    "sent" -> "✓"
    "waiting" -> "⧗"
    "failed" -> "✕"
    else -> ""
}
