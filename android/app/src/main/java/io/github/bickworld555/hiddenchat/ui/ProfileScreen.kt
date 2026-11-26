package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.bickworld555.hiddenchat.NativeProfile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The native Profile screen (Phase 1). Shows the signed-in account: name, @username and account number from an
 * authenticated GET /api/v1/me ([NativeProfile]), falling back to the locally-known account id. Read-only — editing
 * name/photo still happens in the current app until the native edit flow lands; this screen does no crypto and never
 * touches the E2E identity.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(accountId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    var info by remember { mutableStateOf<NativeProfile.Info?>(null) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        info = withContext(Dispatchers.IO) { runCatching { NativeProfile.load(context) }.getOrNull() }
        loading = false
    }

    val displayName = info?.name?.takeIf { it.isNotBlank() } ?: "Your account"

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Profile", fontWeight = FontWeight.SemiBold) },
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
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 24.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Top,
        ) {
            ContactAvatar(displayName, null)
            Spacer(Modifier.height(18.dp))
            Text(displayName, color = MaterialTheme.colorScheme.onBackground, fontWeight = FontWeight.SemiBold, fontSize = 22.sp)
            info?.username?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(4.dp))
                Text("@$it", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 15.sp)
            }
            val number = info?.number?.takeIf { it.isNotBlank() }
            if (number != null) {
                Spacer(Modifier.height(10.dp))
                Text(formatAccountNumber(number), color = MaterialTheme.colorScheme.onBackground, fontSize = 17.sp)
                Text("Account ID", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            } else if (accountId.isNotBlank()) {
                Spacer(Modifier.height(10.dp))
                Text(accountId, color = MaterialTheme.colorScheme.onBackground, fontSize = 15.sp)
                Text("Account", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
            }
            info?.deviceName?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(10.dp))
                Text("This device: $it", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            }
            Spacer(Modifier.height(28.dp))
            Text(
                if (loading) "Loading your profile…"
                else "Editing your name and photo is coming to the native app.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** 10-digit account id as "123 456 7890"; anything else is shown unchanged. */
private fun formatAccountNumber(raw: String): String {
    val digits = raw.filter { it.isDigit() }
    return if (digits.length == 10) "${digits.substring(0, 3)} ${digits.substring(3, 6)} ${digits.substring(6)}" else raw
}
