package io.github.bickworld555.hiddenchat.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The app's visual language for the native (Compose) UI — Step 5. A dark-first messenger palette (the brand blue, a
 * near-black chat background) so the native screens read like the existing WebView UI. Kept deliberately small for the
 * foundation; colors and type will be aligned to the web app's tokens (src/styles.css) as screens are built out.
 */
private val Brand = Color(0xFF2674D9)
private val BrandDark = Color(0xFF1B5CB8)

private val DarkColors = darkColorScheme(
    primary = Brand,
    onPrimary = Color.White,
    background = Color(0xFF0B141A),
    onBackground = Color(0xFFE7EDF2),
    surface = Color(0xFF111B21),
    onSurface = Color(0xFFE7EDF2),
    surfaceVariant = Color(0xFF1E2A32),
    onSurfaceVariant = Color(0xFF93A3AD),
    secondary = Color(0xFF53BDEB),
)

private val LightColors = lightColorScheme(
    primary = BrandDark,
    onPrimary = Color.White,
    background = Color(0xFFF7F9FA),
    onBackground = Color(0xFF0B141A),
    surface = Color.White,
    onSurface = Color(0xFF0B141A),
    surfaceVariant = Color(0xFFEAF0F3),
    onSurfaceVariant = Color(0xFF54656F),
    secondary = Color(0xFF1B8A6B),
)

@Composable
fun HiddenTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
