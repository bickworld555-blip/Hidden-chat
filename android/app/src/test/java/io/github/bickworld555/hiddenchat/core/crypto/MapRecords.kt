package io.github.bickworld555.hiddenchat.core.crypto

import java.util.concurrent.locks.ReentrantLock

/** An in-memory [KeyRecords] for tests: the SQLCipher-backed NativeStore's role, without a database. */
class MapRecords : KeyRecords {
    private val map = HashMap<String, String>()
    private val lock = ReentrantLock()
    override fun get(name: String): String? = map[name]
    override fun set(name: String, json: String) { map[name] = json }
    override fun delete(name: String) { map.remove(name) }
    override fun clear() { map.clear() }
    override fun <T> exclusive(work: () -> T): T {
        lock.lock()
        try { return work() } finally { lock.unlock() }
    }
    fun size() = map.size
}
