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
                var openChat by remember { mutableStateOf<ChatRowData?>(null) }
                var messages by remember { mutableStateOf(emptyList<MessageRowData>()) }
                var loadingMessages by remember { mutableStateOf(false) }

                LaunchedEffect(version) {
                    chats = withContext(Dispatchers.IO) { readChats(store) }
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

                // Android back from a conversation returns to the list rather than leaving the screen.
                BackHandler(enabled = openChat != null) { openChat = null }

                val current = openChat
                if (current == null) {
                    ChatListScreen(chats, onOpenChat = { openChat = it })
                } else {
                    ConversationScreen(
                        current.name,
                        messages,
                        loading = loadingMessages && messages.isEmpty(),
                        onBack = { openChat = null },
                        // Interim send: the web app's E2E path seals + relays; the message returns via the store mirror.
                        onSend = { text -> NativeUiBridge.requestSend(current.id, text) },
                    )
                }
            }
        }
    }

    private fun readChats(store: NativeStore?): List<ChatRowData> = try {
        store?.chats()?.map { ChatRowData(it.id, it.name, it.preview, it.time, it.unread) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }

    private fun readMessages(store: NativeStore?, chatId: String): List<MessageRowData> = try {
        store?.messages(chatId)?.map { MessageRowData(it.mine, it.text, it.time) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }
}
