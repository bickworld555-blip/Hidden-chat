package io.github.bickworld555.hiddenchat.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.github.bickworld555.hiddenchat.NativeForegroundSocket
import io.github.bickworld555.hiddenchat.NativeSend
import io.github.bickworld555.hiddenchat.NativeSendSocket
import io.github.bickworld555.hiddenchat.NativeTyping
import io.github.bickworld555.hiddenchat.NativeLinkPreview
import io.github.bickworld555.hiddenchat.NativeTypingSender
import io.github.bickworld555.hiddenchat.NativeUiBridge
import io.github.bickworld555.hiddenchat.core.store.NativeStore
import io.github.bickworld555.hiddenchat.ui.theme.HiddenTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext

/**
 * The entry point for the native (Compose) UI — Step 5. Hosts the chat list and the conversation screen, read from the
 * native store (the projections the web app mirrors there) and kept in step through the store's change Flow, with every
 * database read done off the main thread. Registered in the manifest exported=false with no launcher intent, so the app
 * still launches straight into the WebView; reachable only for a device test or behind the native-UI flag.
 */
class NativeUiActivity : ComponentActivity() {
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    // Starting the native-owned socket is deferred ~600ms after the UI becomes visible, so the WebView (which suspends
    // its own socket on the same visibility change) closes first and the two never both decrypt the same message.
    private val startSocket = Runnable { NativeForegroundSocket.start(applicationContext) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            HiddenTheme {
                val store = remember { NativeStore.get(applicationContext) }
                // Re-read whenever the store changes (the web app mirrors new chats/messages in); never on the main thread.
                val version by (store?.changes ?: remember { MutableStateFlow(0L) }).collectAsState()

                var chats by remember { mutableStateOf(emptyList<ChatRowData>()) }
                var contacts by remember { mutableStateOf(emptyList<ContactRowData>()) }
                var openChat by remember { mutableStateOf<ChatRowData?>(null) }
                var showNewChat by remember { mutableStateOf(false) }
                var messages by remember { mutableStateOf(emptyList<MessageRowData>()) }
                var loadingMessages by remember { mutableStateOf(false) }
                // Item 4 forwarding: the message being forwarded; while set, the chat picker (NewChatScreen) is shown to
                // choose the target, then it is sent there with the forwarded flag.
                var forwardingMessage by remember { mutableStateOf<MessageRowData?>(null) }
                // Item 4 disappearing: the open chat's timer in seconds (0 = off), read in the effect below.
                var disappear by remember { mutableStateOf(0L) }

                LaunchedEffect(version) {
                    chats = withContext(Dispatchers.IO) { readChats(store) }
                    contacts = withContext(Dispatchers.IO) { readContacts(store) }
                }
                // Opening a chat asks the web app to load + mirror its message window (the start-up window may not have
                // reached it), so the conversation shows messages rather than "No messages". The spinner clears when
                // messages arrive or after a grace period (a genuinely empty chat).
                LaunchedEffect(openChat) {
                    val current = openChat
                    if (current == null) {
                        loadingMessages = false
                    } else {
                        loadingMessages = true
                        NativeUiBridge.requestMessages(current.id)
                        // Checklist item 4: opening a chat sends read receipts for its new incoming messages (so the peer
                        // sees "read") and clears the unread badge — only when native owns the online socket (otherwise
                        // the WebView owns receipts). Off the main thread (DB + socket write).
                        if (NativeForegroundSocket.isOnline()) {
                            withContext(Dispatchers.IO) {
                                val ids = try { store?.markChatRead(current.id) ?: emptyList() } catch (ignored: Throwable) { emptyList() }
                                for (id in ids) NativeForegroundSocket.sendRawFrame(org.json.JSONObject().put("type", "message:read").put("messageId", id).toString())
                            }
                        }
                        kotlinx.coroutines.delay(4000)
                        loadingMessages = false
                    }
                }
                LaunchedEffect(openChat, version) {
                    val current = openChat
                    val loaded = if (current == null) emptyList() else withContext(Dispatchers.IO) { readMessages(store, current.id) }
                    messages = loaded
                    if (loaded.isNotEmpty()) loadingMessages = false
                }
                // Item 4 disappearing: the open chat's current timer (re-read on change), and a 30s expiry sweep while open.
                LaunchedEffect(openChat, version) {
                    val c = openChat
                    disappear = if (c == null) 0L else withContext(Dispatchers.IO) { runCatching { store?.disappearSeconds(c.id) }.getOrNull() ?: 0L }
                }
                LaunchedEffect(openChat) {
                    while (openChat != null) {
                        withContext(Dispatchers.IO) { runCatching { store?.sweepExpired() } }
                        kotlinx.coroutines.delay(30_000)
                    }
                }

                // Android back from a sub-screen returns to the list rather than leaving the app.
                BackHandler(enabled = openChat != null) { openChat = null }
                BackHandler(enabled = showNewChat) { showNewChat = false }
                BackHandler(enabled = forwardingMessage != null) { forwardingMessage = null }

                val current = openChat
                when {
                    // Item 4 forwarding: pick a target chat for the message, then send it there with the forwarded flag.
                    forwardingMessage != null -> NewChatScreen(
                        contacts,
                        onPick = { contact ->
                            val msg = forwardingMessage
                            forwardingMessage = null
                            if (msg != null && msg.text.isNotEmpty()) Thread({
                                try { NativeSend.sendText(applicationContext, contact.id, msg.text, null, true) } catch (ignored: Throwable) { /* best-effort */ }
                            }, "native-forward").start()
                        },
                        onBack = { forwardingMessage = null },
                    )
                    showNewChat -> NewChatScreen(
                        contacts,
                        onPick = { contact ->
                            showNewChat = false
                            openChat = ChatRowData(contact.id, contact.name, "", "", 0, contact.avatar)
                        },
                        onBack = { showNewChat = false },
                    )
                    current == null -> ChatListScreen(
                        chats,
                        onOpenChat = { openChat = it },
                        onNewChat = { showNewChat = true },
                    )
                    else -> {
                        // Checklist item 4 typing indicators: the peer's live "typing…" (receive) and announcing our own
                        // (send). Direct chats only — groups (chat id "group:…") carry a groupId the native path does not
                        // own yet. Both flow over the native-owned socket, so they are inert unless native owns it.
                        val typing by NativeTyping.activity.collectAsState()
                        val isGroup = current.id.startsWith("group:")
                        val typingSender = remember(current.id) {
                            NativeTypingSender(current.id) { frame -> NativeForegroundSocket.sendRawFrame(frame.toString()) }
                        }
                        androidx.compose.runtime.DisposableEffect(current.id) { onDispose { typingSender.stop() } }
                        ConversationScreen(
                            current.name,
                            messages,
                            loading = loadingMessages && messages.isEmpty(),
                            onBack = { openChat = null },
                            // Fully-native send (native device-list trust + sealing + native socket) when possible; falls
                            // back to the web app's E2E relay when the native socket is closed (foreground) or the native
                            // core is unavailable. Off the main thread (it fetches device lists + encrypts).
                            onSend = { text, replyToId ->
                                val chatId = current.id
                                Thread({
                                    // Item 4 replies: replyToId (or null) rides in the inner `r` field via NativeSend.
                                    val sent = try { NativeSend.sendText(applicationContext, chatId, text, replyToId) } catch (ignored: Throwable) { false }
                                    if (!sent) NativeUiBridge.requestSend(chatId, text) // WebView fallback (no reply target)
                                }, "native-send").start()
                            },
                            typingLabel = if (isGroup) "" else NativeTyping.labelFor(typing[current.id]),
                            onDraft = { text ->
                                if (!isGroup) { if (text.isBlank()) typingSender.stop() else typingSender.typed() }
                                // Item 4 link previews: start fetching the preview for a link as it is typed, so Send
                                // can attach it without waiting (NativeLinkPreview.takeForSend).
                                NativeLinkPreview.prefetchFromText(text)
                            },
                            // Item 4 reactions: seal + send over the native socket, off the main thread (direct chats only).
                            onReact = { messageId, emoji ->
                                // "" means toggle-off / remove (sendReaction takes null); anything else adds/updates.
                                if (!isGroup) Thread({
                                    try { NativeSend.sendReaction(applicationContext, current.id, messageId, emoji.ifEmpty { null }) } catch (ignored: Throwable) { /* best-effort */ }
                                }, "native-react").start()
                            },
                            // Item 4 edit/delete: seal+PUT the edit, or send the delete-for-everyone, off the main thread.
                            onEdit = { messageId, newText ->
                                if (!isGroup) Thread({
                                    try { NativeSend.editMessage(applicationContext, current.id, messageId, newText) } catch (ignored: Throwable) { /* best-effort */ }
                                }, "native-edit").start()
                            },
                            onDelete = { messageId ->
                                if (!isGroup) Thread({
                                    try { NativeSend.deleteForEveryone(applicationContext, messageId) } catch (ignored: Throwable) { /* best-effort */ }
                                }, "native-delete").start()
                            },
                            // Item 4 forwarding: open the chat picker for this message.
                            onForward = { message -> forwardingMessage = message },
                            // Item 4 disappearing: set this chat's timer — record it and tell the peer (chat:disappearing).
                            disappearSeconds = disappear,
                            onSetDisappear = { seconds ->
                                if (!isGroup) {
                                    disappear = seconds
                                    Thread({
                                        try {
                                            store?.setDisappearSeconds(current.id, seconds)
                                            NativeForegroundSocket.sendRawFrame(org.json.JSONObject().put("type", "chat:disappearing").put("peerId", current.id).put("seconds", seconds).toString())
                                        } catch (ignored: Throwable) { /* best-effort */ }
                                    }, "native-disappear").start()
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    // The native UI's own relay connection, open only while this screen is visible. When this device owns the one
    // foreground socket (socket_owner sub-flag), ask the WebView to release its socket first (it then calls back
    // webViewSocketReleased, which starts NativeForegroundSocket) so there is never a second online connection; the
    // WebView takes the socket back when the native UI is hidden. Otherwise the legacy write-only NativeSendSocket.
    override fun onStart() {
        super.onStart()
        val owns = NativeForegroundSocket.owns(applicationContext)
        android.util.Log.i("NFS", "NativeUiActivity.onStart owns=$owns")
        if (owns) {
            // Ask the WebView to release its socket (a backup — it also self-suspends on its own visibility-hidden),
            // then start the native socket ourselves after a short delay, so we do not depend on the (possibly frozen)
            // WebView calling back, and the WebView's socket closes first.
            NativeUiBridge.requestSocketHandover(true)
            mainHandler.removeCallbacks(startSocket)
            mainHandler.postDelayed(startSocket, 600)
        } else {
            NativeSendSocket.start(applicationContext)
        }
    }

    override fun onStop() {
        super.onStop()
        mainHandler.removeCallbacks(startSocket)
        if (NativeForegroundSocket.owns(applicationContext)) {
            NativeForegroundSocket.stop()
            NativeUiBridge.requestSocketHandover(false)
        } else {
            NativeSendSocket.stop()
        }
    }

    private fun readChats(store: NativeStore?): List<ChatRowData> = try {
        store?.chats()?.map { ChatRowData(it.id, it.name, it.preview, it.time, it.unread, it.avatar) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }

    private fun readMessages(store: NativeStore?, chatId: String): List<MessageRowData> = try {
        store?.messages(chatId)?.let { rows ->
            val me = store.owner() ?: ""
            rows.map {
                MessageRowData(
                    it.id, it.mine, it.text, it.time, it.status, it.replyText,
                    it.reactions.map { pair -> pair.second },
                    it.reactions.firstOrNull { pair -> pair.first == me }?.second ?: "",
                    it.edited, it.deleted, it.forwarded, it.expiresAt,
                    parseLinkPreview(it.linkPreview),
                )
            }
        } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }

    /** Parses a stored link-preview card (item 4) from its JSON into the UI row, or null when absent/malformed. */
    private fun parseLinkPreview(json: String): LinkPreviewData? {
        if (json.isBlank()) return null
        val lp = runCatching { io.github.bickworld555.hiddenchat.core.Json.map(io.github.bickworld555.hiddenchat.core.Json.parse(json)) }.getOrNull() ?: return null
        val url = io.github.bickworld555.hiddenchat.core.Json.string(lp["url"]) ?: return null
        val host = runCatching { java.net.URI(url).host?.replace(Regex("^(?:www\\.|m\\.|web\\.)"), "") ?: "" }.getOrDefault("")
        return LinkPreviewData(
            url = url,
            title = io.github.bickworld555.hiddenchat.core.Json.string(lp["title"]) ?: "",
            description = io.github.bickworld555.hiddenchat.core.Json.string(lp["description"]) ?: "",
            siteName = io.github.bickworld555.hiddenchat.core.Json.string(lp["siteName"]) ?: "",
            host = host,
            video = lp["video"] == true,
            thumbnail = io.github.bickworld555.hiddenchat.core.Json.string(lp["thumbnail"]) ?: "",
        )
    }

    private fun readContacts(store: NativeStore?): List<ContactRowData> = try {
        store?.contacts()?.map { ContactRowData(it.id, it.name, it.avatar) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }
}
