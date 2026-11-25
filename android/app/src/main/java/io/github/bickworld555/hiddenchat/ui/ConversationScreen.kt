package io.github.bickworld555.hiddenchat.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
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

/** One message bubble the native conversation screen shows (Step 5). `status` drives the read-receipt ticks on our own
 * sent messages ('' | sent | delivered | read | waiting); it is unused for incoming messages. `replyText` (item 4
 * replies) is the quoted snippet of the message this one replies to, shown above the bubble ("" when not a reply). */
data class MessageRowData(val id: String, val mine: Boolean, val text: String, val time: String, val status: String = "", val replyText: String = "", val reactions: List<String> = emptyList(), val myReaction: String = "", val edited: Boolean = false, val deleted: Boolean = false, val forwarded: Boolean = false, val expiresAt: Long = 0, val linkPreview: LinkPreviewData? = null)

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
    // Item 4 disappearing: the chat's current timer in seconds (0 = off), and a callback to change it (Off/24h/7d/90d).
    disappearSeconds: Long = 0,
    onSetDisappear: (Long) -> Unit = {},
) {
    var draft by remember { mutableStateOf("") }
    // Item 4 replies: the message currently being replied to (long-press a bubble to set it), shown as a quote bar above
    // the composer and carried in the next send.
    var replyingTo by remember { mutableStateOf<MessageRowData?>(null) }
    // Item 4 edit: the message currently being edited (its text is loaded into the composer); send saves the edit.
    var editingMessage by remember { mutableStateOf<MessageRowData?>(null) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
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
            val listState = androidx.compose.foundation.lazy.rememberLazyListState()
            androidx.compose.runtime.LaunchedEffect(messages.size) {
                if (messages.isNotEmpty()) listState.scrollToItem(messages.size - 1)
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(messages) { _, message ->
                    MessageBubble(
                        message,
                        onReply = { replyingTo = message },
                        onReact = { emoji -> onReact(message.id, emoji) },
                        onEditStart = { editingMessage = message; draft = message.text; replyingTo = null },
                        onDelete = { onDelete(message.id) },
                        onForward = { onForward(message) },
                    )
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
) {
    val mine = message.mine
    // Item 4 delete-for-everyone: a deleted message shows a plain italic placeholder — no menu, reactions, reply or ticks.
    if (message.deleted) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
            Text(
                "🚫 This message was deleted",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 14.sp,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f) else MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        return
    }
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            Box {
                Column(
                    modifier = Modifier
                        .widthIn(max = 300.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                        // Long-press a bubble for the reaction + reply menu (item 4).
                        .combinedClickable(onClick = {}, onLongClick = { menuOpen = true })
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
                    Text(
                        message.text,
                        color = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                        fontSize = 15.sp,
                    )
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
