package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One chat row's data. Step 5 foundation uses placeholder rows; a later increment reads the native message store. */
data class ChatRowData(val name: String, val lastMessage: String, val time: String, val unread: Int = 0)

private val SAMPLE_CHATS = listOf(
    ChatRowData("Hidden Messenger", "Native UI foundation (Step 5) — placeholder data", "now", 2),
    ChatRowData("Design", "Let's align the chat list with the web app tokens", "09:41"),
    ChatRowData("Calls", "Native WebRTC media is wired (Step 4)", "Yesterday"),
    ChatRowData("Family", "See you this weekend 🎉", "Mon", 0),
    ChatRowData("Work", "Pushed the build to the test device", "Sun"),
)

/**
 * The native chat list (Step 5 foundation). A scaffold mirroring the web app's home screen — a top bar, a scrollable
 * list of conversations, and a compose button. Placeholder data for now; the real list will come from the native store
 * once the data seam is built. Nothing points a launcher at this yet, so the WebView UI is unaffected.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen() {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Hidden Messenger", fontWeight = FontWeight.SemiBold) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { /* a later increment opens the new-chat flow */ },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) { Text("+", fontSize = 26.sp) }
        },
    ) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
            items(SAMPLE_CHATS) { chat ->
                ChatRow(chat)
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
            }
        }
    }
}

@Composable
private fun ChatRow(chat: ChatRowData) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(chat.name)
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                chat.name,
                color = MaterialTheme.colorScheme.onBackground,
                fontWeight = FontWeight.Medium,
                fontSize = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                chat.lastMessage,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(chat.time, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            if (chat.unread > 0) {
                Spacer(Modifier.size(6.dp))
                Box(
                    modifier = Modifier.clip(CircleShape).background(MaterialTheme.colorScheme.primary).size(20.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("${chat.unread}", color = MaterialTheme.colorScheme.onPrimary, fontSize = 11.sp) }
            }
        }
    }
}

@Composable
private fun Avatar(name: String) {
    val initials = name.trim().split(" ").mapNotNull { it.firstOrNull()?.toString() }.take(2).joinToString("").uppercase()
    val palette = listOf(Color(0xFF2674D9), Color(0xFF1B8A6B), Color(0xFFB8641B), Color(0xFF8A1B6B), Color(0xFF1B6B8A))
    val color = palette[(name.hashCode() and 0x7FFFFFFF) % palette.size]
    Box(
        modifier = Modifier.clip(CircleShape).background(color).size(48.dp),
        contentAlignment = Alignment.Center,
    ) { Text(initials.ifEmpty { "?" }, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp) }
}
