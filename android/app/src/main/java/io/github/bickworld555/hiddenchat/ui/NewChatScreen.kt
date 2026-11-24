package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One person in the native new-chat picker (Step 5), mirrored from the web app's chats + known people. */
data class ContactRowData(val id: String, val name: String)

/**
 * The native new-chat picker (Step 5): the people the user can start or continue a conversation with (existing chats
 * and known contacts, mirrored to the native store). Picking one opens its conversation. Starting a chat with someone
 * brand-new by account id/search is a later increment; this covers people the app already knows.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(contacts: List<ContactRowData>, onPick: (ContactRowData) -> Unit, onBack: () -> Unit) {
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
        if (contacts.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("No contacts yet", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
                items(contacts) { contact ->
                    ContactRow(contact, onClick = { onPick(contact) })
                    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
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
        ContactAvatar(contact.name)
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
