package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The native Settings hub (Phase 1). Local, safe controls only — profile/contacts entry points, the shared
 * secure-screen toggle (AppSecurity, FLAG_SECURE) and a native-UI-only "require unlock" switch. No crypto flags,
 * no WebView retirement, no account/E2E changes. Actions needing the Activity (secure screen, unlock availability)
 * are passed in as callbacks from NativeUiActivity.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    accountId: String,
    secureScreen: Boolean,
    onToggleSecureScreen: (Boolean) -> Unit,
    appLock: Boolean,
    onToggleAppLock: (Boolean) -> Unit,
    unlockAvailable: Boolean,
    onOpenProfile: () -> Unit,
    onOpenContacts: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val version = remember {
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("Settings", fontWeight = FontWeight.SemiBold) },
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
        Column(modifier = Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            SectionLabel("Account")
            NavRow("Profile", "Your name, username and account ID", onOpenProfile)
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
            NavRow("Contacts", "People you can message", onOpenContacts)

            SectionLabel("Privacy")
            ToggleRow(
                title = "Hide screen contents",
                subtitle = "Blocks screenshots and hides the app in Recents",
                checked = secureScreen,
                enabled = true,
                onCheckedChange = onToggleSecureScreen,
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant, thickness = 0.5.dp)
            ToggleRow(
                title = "Require unlock",
                subtitle = if (unlockAvailable) "Ask for fingerprint, face or screen lock to open the app"
                else "Set up a screen lock on this phone to use this",
                checked = appLock,
                enabled = unlockAvailable,
                onCheckedChange = onToggleAppLock,
            )

            SectionLabel("About")
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                if (accountId.isNotBlank()) {
                    Text("Account: $accountId", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                }
                Text("Hidden Messenger${if (version.isNotBlank()) " · v$version" else ""}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = MaterialTheme.colorScheme.primary,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, top = 20.dp, bottom = 6.dp),
    )
}

@Composable
private fun NavRow(title: String, subtitle: String, onClick: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(title, color = MaterialTheme.colorScheme.onBackground, fontWeight = FontWeight.Medium, fontSize = 16.sp)
        Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String, checked: Boolean, enabled: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, color = MaterialTheme.colorScheme.onBackground, fontWeight = FontWeight.Medium, fontSize = 16.sp)
            Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}
