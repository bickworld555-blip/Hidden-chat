package io.github.bickworld555.hiddenchat.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import io.github.bickworld555.hiddenchat.core.store.NativeStore
import io.github.bickworld555.hiddenchat.ui.theme.HiddenTheme

/**
 * The entry point for the native (Compose) UI — Step 5. Hosts the chat list and the conversation screen, both read
 * from the native store (the projections the web app mirrors there). Registered in the manifest exported=false with no
 * launcher intent, so the app still launches straight into the WebView; reachable only for a device test
 * (`adb shell am start -n <pkg>/.ui.NativeUiActivity`). The native UI grows from here, kept off the default path.
 */
class NativeUiActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // One-shot read on open (the lists are small); a reactive store Flow + background load is a later increment.
        val chats = readChats()
        setContent {
            HiddenTheme {
                var openChat by remember { mutableStateOf<ChatRowData?>(null) }
                var messages by remember { mutableStateOf(emptyList<MessageRowData>()) }
                // Android back from a conversation returns to the list rather than leaving the screen.
                BackHandler(enabled = openChat != null) { openChat = null }
                val current = openChat
                if (current == null) {
                    ChatListScreen(chats, onOpenChat = { chat ->
                        messages = readMessages(chat.id)
                        openChat = chat
                    })
                } else {
                    ConversationScreen(current.name, messages, onBack = { openChat = null })
                }
            }
        }
    }

    private fun readChats(): List<ChatRowData> = try {
        NativeStore.get(this)?.chats()?.map { ChatRowData(it.id, it.name, it.preview, it.time, it.unread) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }

    private fun readMessages(chatId: String): List<MessageRowData> = try {
        NativeStore.get(this)?.messages(chatId)?.map { MessageRowData(it.mine, it.text, it.time) } ?: emptyList()
    } catch (ignored: Throwable) {
        emptyList()
    }
}
