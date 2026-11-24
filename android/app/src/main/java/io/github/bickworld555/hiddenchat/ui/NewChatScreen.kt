package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** One person in the native new-chat picker (Step 5), mirrored from the web app's chats + known people. */
data class ContactRowData(val id: String, val name: String, val avatar: String = "")

/**
 * The native new-chat picker (Step 5): the people the user can start or continue a conversation with. It lists the
 * people the app already knows (existing chats and contacts, mirrored to the native store) and filters them as the user
 * types, and it also looks up someone brand-new by exact @username or 10-digit account id (NativeLookup, the same
 * server endpoint the web app uses) so a first chat can be started without the WebView. Picking anyone opens its
 * conversation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(contacts: List<ContactRowData>, onPick: (ContactRowData) -> Unit, onBack: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<ContactRowData?>(null) }
    var searching by remember { mutableStateOf(false) }
    val context = LocalContext.current

    // Debounced account lookup: only for a whole username/id, off the main thread, and never a duplicate of someone
    // already known. Re-runs whenever the query changes; the previous effect is cancelled, so a stale result is dropped.
    LaunchedEffect(query) {
        found = null
        val handle = NativeLookup.handleFrom(query)
        if (handle.isEmpty()) { searching = false; return@LaunchedEffect }
        searching = true
        delay(400)
        val person = withContext(Dispatchers.IO) { runCatching { NativeLookup.account(context, query) }.getOrNull() }
        found = person?.takeIf { p -> contacts.none { it.id == p.id } }
        searching = false
    }

    val filtered = remember(contacts, query) {
        val q = query.trim()
        if (q.isEmpty()) contacts
        else contacts.filter { it.name.contains(q, ignoreCase = true) || it.id.contains(q, ignoreCase = true) }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("New chat", fontWeight = FontWeight.SemiBold) },
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
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                placeholder = { Text("Search name, @username or 10-digit ID") },
            )
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                found?.let { person ->
                    item {
                        ContactRow(person, onClick = { onPick(person) })
                        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
                    }
                }
                items(filtered) { contact ->
                    ContactRow(contact, onClick = { onPick(contact) })
                    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
                }
                if (found == null && filtered.isEmpty()) {
                    item {
                        Box(
                            modifier = Modifier.fillMaxWidth().padding(24.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                when {
                                    searching -> "Searching…"
                                    query.isBlank() -> "No contacts yet"
                                    NativeLookup.handleFrom(query).isEmpty() -> "Type a full @username or 10-digit ID"
                                    else -> "No one found"
                                },
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 15.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ContactRow(contact: ContactRowData, onClick: () -> Unit) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ContactAvatar(contact.name, contact.avatar)
        Spacer(Modifier.width(14.dp))
        Text(
            contact.name,
            color = MaterialTheme.colorScheme.onBackground,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
