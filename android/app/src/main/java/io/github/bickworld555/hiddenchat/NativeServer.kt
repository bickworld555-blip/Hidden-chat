package io.github.bickworld555.hiddenchat

import android.content.Context
import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.NativeTransport
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Authenticated JSON GET/PUT to the account's server for the native end-to-end path (key publish, device list; the
 * relay.fetch socket connects separately). Origin and token come from the session (RelaySession), which also fixes
 * the device id the server ties published keys to. In the app package so it can read the (package-private) session.
 */
class NativeServer private constructor(private val origin: String, private val token: String) : NativeTransport {
    private val client = OkHttpClient()
    private val jsonType = "application/json".toMediaType()

    override fun getJson(path: String): Map<String, Any?>? =
        request(Request.Builder().url(origin + path).get())

    override fun putJson(path: String, body: Map<String, Any?>): Map<String, Any?>? =
        request(Request.Builder().url(origin + path).put(Json.stringify(body).toRequestBody(jsonType)))

    /** A JSON POST (e.g. /api/v1/queue/ack), used by the native background group fetch. */
    fun postJson(path: String, body: Map<String, Any?>): Map<String, Any?>? =
        request(Request.Builder().url(origin + path).post(Json.stringify(body).toRequestBody(jsonType)))

    /** A GET whose body is a JSON array (e.g. a group's message history), not an object. */
    fun getArray(path: String): List<Any?>? {
        val request = Request.Builder().url(origin + path).get()
            .header("Authorization", "Bearer $token")
            .header(ClientVersion.HEADER, ClientVersion.PROTOCOL.toString())
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) null else Json.list(Json.parse(body.string()))
            }
        } catch (failed: Exception) {
            null
        }
    }

    private fun request(builder: Request.Builder): Map<String, Any?>? {
        val request = builder
            .header("Authorization", "Bearer $token")
            .header(ClientVersion.HEADER, ClientVersion.PROTOCOL.toString())
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) null else Json.map(Json.parse(body.string()))
            }
        } catch (failed: Exception) {
            null
        }
    }

    companion object {
        /** The transport for the current session, or null when signed out. */
        fun from(context: Context): NativeServer? {
            val session = RelaySession.read(context) ?: return null
            val origin = session.origin ?: return null
            val token = session.token ?: return null
            return NativeServer(origin, token)
        }
    }
}
