package io.github.bickworld555.hiddenchat

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Read-only profile data for the native Profile screen (Phase 1). An authenticated GET /api/v1/me using the session
 * the native side already holds ([RelaySession]) — no E2E crypto, no writes. Returns null when there is no session or
 * the request fails, so the screen can fall back to the locally-known account id.
 */
object NativeProfile {
    data class Info(
        val name: String,
        val username: String,
        val number: String,
        val deviceName: String,
        val userId: String,
    )

    private val client by lazy {
        OkHttpClient.Builder()
            .callTimeout(12, TimeUnit.SECONDS)
            .build()
    }

    fun load(context: Context): Info? {
        val session = RelaySession.read(context) ?: return null
        val origin = session.origin ?: return null
        val token = session.token ?: return null
        if (origin.isEmpty() || token.isEmpty()) return null
        return try {
            val request = Request.Builder()
                .url("$origin/api/v1/me")
                .header("Authorization", "Bearer $token")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string() ?: return null
                val json = JSONObject(body)
                val user = json.optJSONObject("user") ?: JSONObject()
                val device = json.optJSONObject("device") ?: JSONObject()
                Info(
                    name = firstNonBlank(user.optString("name"), user.optString("displayName")),
                    username = user.optString("username", ""),
                    number = firstNonBlank(user.optString("number"), user.optString("accountNumber")),
                    deviceName = device.optString("name", ""),
                    userId = session.userId ?: "",
                )
            }
        } catch (t: Throwable) {
            null
        }
    }

    private fun firstNonBlank(vararg values: String?): String =
        values.firstOrNull { !it.isNullOrBlank() } ?: ""
}
