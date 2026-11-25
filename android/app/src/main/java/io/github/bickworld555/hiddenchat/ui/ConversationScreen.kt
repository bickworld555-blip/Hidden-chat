package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One message bubble the native conversation screen shows (Step 5). `status` drives the read-receipt ticks on our own
 * sent messages ('' | sent | delivered | read | waiting); it is unused for incoming messages. `replyText` (item 4
 * replies) is the quoted snippet of the message this one replies to, shown above the bubble ("" when not a reply). */
data class MessageRowData(val id: String, val mine: Boolean, val text: String, val time: String, val status: String = "", val replyText: String = "")

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
) {
    var draft by remember { mutableStateOf("") }
    // Item 4 replies: the message currently being replied to (long-press a bubble to set it), shown as a quote bar above
    // the composer and carried in the next send.
    var replyingTo by remember { mutableStateOf<MessageRowData?>(null) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1)
                        if (typingLabel.isNotEmpty()) {
                            Text(typingLabel, color = MaterialTheme.colorScheme.primary, fontSize = 12.sp, maxLines = 1)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Text("←", color = MaterialTheme.colorScheme.onSurface, fontSize = 22.sp)
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
                // Item 4 replies: the quote bar above the composer while replying, with a cancel.
                val replying = replyingTo
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
                        // The native E2E path seals + relays; sending passes the reply target and stops our "typing…".
                        onClick = {
                            val text = draft.trim()
                            if (text.isNotEmpty()) { onSend(text, replyingTo?.id); draft = ""; onDraft(""); replyingTo = null }
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
                itemsIndexed(messages) { _, message -> MessageBubble(message, onReply = { replyingTo = message }) }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(message: MessageRowData, onReply: () -> Unit = {}) {
    val mine = message.mine
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                // Long-press a bubble to reply to it (item 4 replies).
                .combinedClickable(onClick = {}, onLongClick = onReply)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
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
            Text(
                message.text,
                color = if (mine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                fontSize = 15.sp,
            )
            if (message.time.isNotEmpty() || (mine && message.status.isNotEmpty())) {
                Row(
                    modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
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
