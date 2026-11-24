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

                // Android back from a sub-screen returns to the list rather than leaving the app.
                BackHandler(enabled = openChat != null) { openChat = null }
                BackHandler(enabled = showNewChat) { showNewChat = false }

                val current = openChat
                when {
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
                    else -> ConversationScreen(
                        current.name,
                        messages,
                        loading = loadingMessages && messages.isEmpty(),
                        onBack = { openChat = null },
                        // Fully-native send (native device-list trust + sealing + native socket) when possible; falls
                        // back to the web app's E2E relay when the native socket is closed (foreground) or the native
                        // core is unavailable. Off the main thread (it fetches device lists + encrypts).
                        onSend = { text ->
                            val chatId = current.id
                            Thread({
                                val sent = try { NativeSend.sendText(applicationContext, chatId, text) } catch (ignored: Throwable) { false }
                                if (!sent) NativeUiBridge.requestSend(chatId, text)
                            }, "native-send").start()
                        },
                    )
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
        if (NativeForegroundSocket.owns(applicationContext)) NativeUiBridge.requestSocketHandover(true)
        else NativeSendSocket.start(applicationContext)
    }

    override fun onStop() {
        super.onStop()
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
        store?.messages(chatId)?.map { MessageRowData(it.mine, it.text, it.time) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }

    private fun readContacts(store: NativeStore?): List<ContactRowData> = try {
        store?.contacts()?.map { ContactRowData(it.id, it.name, it.avatar) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }
}
