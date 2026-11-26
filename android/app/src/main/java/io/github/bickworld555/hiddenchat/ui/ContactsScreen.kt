package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The native Contacts screen (Phase 1): the people the app already knows, mirrored into the native store, with a
 * search box. Tapping one opens its conversation. Read-only over the native store — no WebView, no crypto change.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(contacts: List<ContactRowData>, onOpen: (ContactRowData) -> Unit, onBack: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val filtered = remember(contacts, query) {
        val q = query.trim()
        if (q.isEmpty()) contacts
        else contacts.filter { it.name.contains(q, ignoreCase = true) || it.id.contains(q, ignoreCase = true) }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Contacts", fontWeight = FontWeight.SemiBold) },
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
                placeholder = { Text("Search contacts") },
            )
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(filtered) { contact ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { onOpen(contact) }.padding(horizontal = 16.dp, vertical = 12.dp),
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
                    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
                }
                if (filtered.isEmpty()) {
                    item {
                        Box(modifier = Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            Text(
                                if (query.isBlank()) "No contacts yet" else "No one found",
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
