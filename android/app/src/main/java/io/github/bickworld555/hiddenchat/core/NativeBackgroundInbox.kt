package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.KeyRecords

/**
 * What the native background fetch decrypted while the app had no screen, kept for the WebView to import when it next
 * opens — the native counterpart of src/backgroundInbox.js. Each entry is an already-sealed "opened event"
 * (Keystore-sealed by the caller, so nothing readable sits at rest); the WebView opens it over the bridge and applies
 * it through its normal event handler, exactly as it imports the WebView page's inbox today.
 *
 * Ordering: a message is sealed into the inbox BEFORE it is acknowledged to the server, so a crash never loses a
 * message (it stays queued on the server until the app, or the next fetch, stores it).
 */
class NativeBackgroundInbox(private val records: KeyRecords) {
    /** Keeps one sealed opened-event, in arrival order. */
    fun add(sealed: String) = records.exclusive {
        val list = (records.get(KEY)?.let { Json.list(Json.parse(it)) } ?: emptyList()).toMutableList()
        list.add(sealed)
        records.set(KEY, Json.stringify(list))
    }

    /** Returns every sealed event in arrival order and clears the inbox (the WebView has taken them). */
    fun takeAll(): List<String> = records.exclusive {
        val list = (records.get(KEY)?.let { Json.list(Json.parse(it)) } ?: emptyList()).mapNotNull { it as? String }
        records.delete(KEY)
        list
    }

    fun size(): Int = records.exclusive { (records.get(KEY)?.let { Json.list(Json.parse(it)) } ?: emptyList()).size }

    companion object {
        const val KEY = "native-inbox"
    }
}
