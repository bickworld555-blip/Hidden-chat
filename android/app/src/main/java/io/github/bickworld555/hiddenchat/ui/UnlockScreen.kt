package io.github.bickworld555.hiddenchat.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The native Unlock gate (Phase 1). Shown before the native UI reveals any chats when the native app-lock switch is
 * on. It prompts the phone's biometrics / device credential through [onPrompt] (wired to AppSecurity via
 * NativeSecurity in the activity); on success the activity clears the lock. The prompt fires once automatically and
 * can be retried with the button, so a cancelled prompt never leaves a dead screen.
 */
@Composable
fun UnlockScreen(onPrompt: () -> Unit) {
    LaunchedEffect(Unit) { onPrompt() }
    Scaffold(containerColor = MaterialTheme.colorScheme.background) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("🔒", fontSize = 44.sp)
            Spacer(Modifier.height(16.dp))
            Text(
                "Hidden Messenger is locked",
                color = MaterialTheme.colorScheme.onBackground,
                fontWeight = FontWeight.SemiBold,
                fontSize = 20.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Unlock with your fingerprint, face or screen lock to continue.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))
            Button(onClick = onPrompt) { Text("Unlock") }
        }
    }
}
