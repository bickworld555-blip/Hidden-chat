package io.github.bickworld555.hiddenchat.ui

import android.content.Context
import io.github.bickworld555.hiddenchat.NativeServer
import io.github.bickworld555.hiddenchat.core.Json

/**
 * Native account lookup for the new-chat picker (Step 5): finds the one person with exactly this @username or 10-digit
 * account id, through POST /api/v1/users/lookup — the same endpoint and rules the web app uses (src/contactsApi.js
 * lookupUsername, src/accountNumber.js). The search term goes in the request body, never a URL, so nobody can
 * enumerate accounts. Null when the term is not a whole username or id, there is no session, or no such discoverable,
 * unblocked person exists. Runs on the native store/server path with no WebView involved.
 */
object NativeLookup {
    private val USERNAME = Regex("^[a-z0-9_]{3,24}$")
    private val NUMBERISH = Regex("^\\+?[\\d\\s.-]+$")
    private val ACCOUNT_NUMBER = Regex("^[1-9]\\d{9}$")

    /** The whole username or account id this search text means (src/contactsApi.js handleFrom), or "" when neither. */
    fun handleFrom(query: String): String {
        val text = query.trim()
        if (NUMBERISH.matches(text)) {
            val digits = text.filter { it.isDigit() }
            if (ACCOUNT_NUMBER.matches(digits)) return digits
        }
        val handle = text.removePrefix("@").trim().lowercase()
        return if (USERNAME.matches(handle)) handle else ""
    }

    /**
     * The person with exactly this handle, as a picker row, or null. The HTTP call blocks, so callers run this off the
     * main thread. Display name follows the web app's presentName: a set name, else "@username", else the id.
     */
    fun account(context: Context, query: String): ContactRowData? {
        val handle = handleFrom(query)
        if (handle.isEmpty()) return null
        val server = NativeServer.from(context) ?: return null
        val result = server.postJson("/api/v1/users/lookup", mapOf("username" to handle)) ?: return null
        val user = Json.map(result["user"]) ?: return null
        val id = Json.string(user["id"]) ?: return null
        val name = Json.string(user["name"])
        val username = Json.string(user["username"])
        val display = when {
            !name.isNullOrBlank() -> name
            !username.isNullOrBlank() -> "@$username"
            else -> id
        }
        return ContactRowData(id, display, Json.string(user["avatar"]) ?: "")
    }
}
