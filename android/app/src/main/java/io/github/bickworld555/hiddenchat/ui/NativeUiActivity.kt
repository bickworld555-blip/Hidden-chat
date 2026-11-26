package io.github.bickworld555.hiddenchat.ui

import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.github.bickworld555.hiddenchat.NativeForegroundSocket
import io.github.bickworld555.hiddenchat.NativeMediaSend
import io.github.bickworld555.hiddenchat.NativeSecurity
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
class NativeUiActivity : FragmentActivity() {
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
                // Item 4 forwarding + multi-select: the message(s) being forwarded; while non-empty, the chat picker
                // (NewChatScreen) is shown to choose the target, then each is sent there with the forwarded flag (in
                // chat order). A single Forward and a multi-select Forward both populate this list.
                var forwardingMessages by remember { mutableStateOf<List<MessageRowData>>(emptyList()) }
                // Item 4 disappearing: the open chat's timer in seconds (0 = off), read in the effect below.
                var disappear by remember { mutableStateOf(0L) }
                // Phase 1 native shell: the top-level native screen ("chats"/"settings"/"profile"/"contacts"), the
                // native-UI app-lock gate, and the signed-in account id. None of this touches the crypto core,
                // the socket owner, or the launcher — it only adds native screens reachable from the chat list.
                var screen by remember { mutableStateOf("chats") }
                var locked by remember { mutableStateOf(NativeSecurity.appLockOn(applicationContext)) }
                var accountId by remember { mutableStateOf("") }
                var secureScreen by remember { mutableStateOf(NativeSecurity.secureScreenOn(applicationContext)) }
                var appLock by remember { mutableStateOf(NativeSecurity.appLockOn(applicationContext)) }
                // Phase 5: the system photo picker (no runtime permission). The picked photo is encrypted, uploaded and
                // sent to the open chat off the main thread (NativeMediaSend).
                var pendingViewOnce by remember { mutableStateOf(false) }
                val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { picked ->
                    val chatId = openChat?.id
                    val viewOnce = pendingViewOnce
                    if (picked != null && chatId != null) {
                        Thread({ NativeMediaSend.sendPhoto(applicationContext, chatId, picked, viewOnce = viewOnce) }, "native-photo").start()
                    }
                }

                LaunchedEffect(Unit) {
                    accountId = withContext(Dispatchers.IO) { runCatching { store?.owner() }.getOrNull() ?: "" }
                }

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
                BackHandler(enabled = forwardingMessages.isNotEmpty()) { forwardingMessages = emptyList() }
                // Native shell: a sub-screen returns to Settings; Settings returns to the chat list.
                BackHandler(enabled = !locked && (screen == "profile" || screen == "contacts")) { screen = "settings" }
                BackHandler(enabled = !locked && screen == "settings") { screen = "chats" }

                val current = openChat
                when {
                    // Native app-lock gate (Phase 1): nothing shows until the phone's biometrics / device credential
                    // confirm. Prompts AppSecurity through NativeSecurity; a success clears the lock for this session.
                    locked -> UnlockScreen(onPrompt = {
                        NativeSecurity.authenticate(this@NativeUiActivity, "Unlock Hidden Messenger", "") { ok, _ ->
                            if (ok) locked = false
                        }
                    })
                    screen == "profile" -> ProfileScreen(accountId, onBack = { screen = "settings" })
                    screen == "contacts" -> ContactsScreen(
                        contacts,
                        onOpen = { contact ->
                            screen = "chats"
                            openChat = ChatRowData(contact.id, contact.name, "", "", 0, contact.avatar)
                        },
                        onBack = { screen = "settings" },
                    )
                    screen == "settings" -> SettingsScreen(
                        accountId = accountId,
                        secureScreen = secureScreen,
                        onToggleSecureScreen = { on -> NativeSecurity.setSecureScreen(this@NativeUiActivity, on); secureScreen = on },
                        appLock = appLock,
                        onToggleAppLock = { on -> NativeSecurity.setAppLock(applicationContext, on); appLock = on },
                        unlockAvailable = NativeSecurity.unlockStatus(applicationContext) == "available",
                        onOpenProfile = { screen = "profile" },
                        onOpenContacts = { screen = "contacts" },
                        onBack = { screen = "chats" },
                    )
                    // Item 4 forwarding + multi-select: pick a target chat, then send each chosen message there with the
                    // forwarded flag, oldest-first (the list is already in chat order).
                    forwardingMessages.isNotEmpty() -> NewChatScreen(
                        contacts,
                        onPick = { contact ->
                            val msgs = forwardingMessages
                            forwardingMessages = emptyList()
                            Thread({
                                for (msg in msgs) {
                                    if (msg.text.isNotEmpty()) try { NativeSend.sendText(applicationContext, contact.id, msg.text, null, true) } catch (ignored: Throwable) { /* best-effort */ }
                                }
                            }, "native-forward").start()
                        },
                        onBack = { forwardingMessages = emptyList() },
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
                        onOpenSettings = { screen = "settings" },
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
                                    if (!sent) NativeUiBridge.requestSend(chatId, text, replyToId) // WebView fallback now carries the reply target
                                }, "native-send").start()
                            },
                            // Phase 5: pick + send a photo (tap) or a view-once photo (long-press). Direct chats only.
                            onAttach = { viewOnce ->
                                if (!isGroup) {
                                    pendingViewOnce = viewOnce
                                    photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                }
                            },
                            // Phase 5 scheduled messages: long-press Send → pick a date + time → the web app seals it now and
                            // the server delivers it then (POST /api/v1/scheduled). Direct chats only.
                            onSchedule = { text ->
                                if (!isGroup) {
                                    val chatId = current.id
                                    val cal = java.util.Calendar.getInstance()
                                    android.app.DatePickerDialog(this@NativeUiActivity, { _, y, m, d ->
                                        android.app.TimePickerDialog(this@NativeUiActivity, { _, h, min ->
                                            val c = java.util.Calendar.getInstance()
                                            c.set(y, m, d, h, min, 0); c.set(java.util.Calendar.MILLISECOND, 0)
                                            val sendAt = c.timeInMillis
                                            if (sendAt > System.currentTimeMillis() + 30_000) {
                                                NativeUiBridge.requestSchedule(chatId, text, sendAt)
                                                android.widget.Toast.makeText(applicationContext, "Scheduled", android.widget.Toast.LENGTH_SHORT).show()
                                            } else {
                                                android.widget.Toast.makeText(applicationContext, "Pick a future time", android.widget.Toast.LENGTH_SHORT).show()
                                            }
                                        }, cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE), false).show()
                                    }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH)).apply {
                                        datePicker.minDate = System.currentTimeMillis()
                                    }.show()
                                }
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
                            onForward = { message -> forwardingMessages = listOf(message) },
                            // Item 4 multi-select: forward every selected message (chat order), or delete-for-everyone each
                            // (the server enforces sender-only + the 24h window, so a non-deletable one is simply ignored).
                            onForwardMany = { list -> if (list.isNotEmpty()) forwardingMessages = list },
                            onDeleteMany = { ids ->
                                if (!isGroup && ids.isNotEmpty()) Thread({
                                    for (id in ids) try { NativeSend.deleteForEveryone(applicationContext, id) } catch (ignored: Throwable) { /* best-effort */ }
                                }, "native-delete-many").start()
                            },
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
                    if (it.mediaKind.isNotEmpty()) MediaData(it.mediaKind, it.mediaPreview, it.mediaDuration, it.mediaSource) else null,
                    it.caption, it.albumId, it.albumIndex, it.albumCount,
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
