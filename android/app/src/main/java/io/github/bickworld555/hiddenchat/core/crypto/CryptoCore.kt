package io.github.bickworld555.hiddenchat.core.crypto

/**
 * The end-to-end encryption core as the rest of the native app sees it: the same operations the web app's protocol
 * object offers (src/e2e/protocol.js createProtocol), so the store, the background fetch and the WebView bridge are
 * written against one contract whichever implementation fills it.
 *
 * Values cross this boundary as JSON documents (parsed with io.github.bickworld555.hiddenchat.core.Json), in the
 * exact shapes the wire protocol defines in src/e2e/envelope.js and src/e2e/protocol.js:
 *   - device map:      { [userId]: [ { deviceId, identity?: { dh, sig } } ] }
 *   - sealed entries:  { [userId]: { [deviceId]: { p?, h, c } } }
 *   - a group body:    { mh, g: { kid, n, c, s }, x?: sealed entries }
 *   - identities:      { dh, sig } (base64 of 65-byte P-256 points)
 *
 * An implementation must pass E2eVectorsTest (the transcript recorded from the web protocol by
 * scripts/e2e-native-vectors.mjs) before any phone runs it: every ciphertext, header and plaintext there must match
 * byte for byte, because other phones, the desktop app and the website keep running the web code.
 *
 * Errors: an operation that cannot complete throws [ProtocolError] with one of the codes the web app already
 * handles (src/e2e/client.js RESET_SESSION_ERRORS and the messaging layer): no-bundle, no-session, decrypt-failed,
 * stale-prekey, identity-mismatch, no-sender-key, not-addressed.
 */
interface CryptoCore {
    /** Device identity, a fresh signed prekey when due, and one-time prekeys up to a batch: the upload body for PUT /api/v1/e2e/keys. */
    fun prepareUpload(serverPreKeyCount: Int, now: Long = System.currentTimeMillis()): Map<String, Any?>

    /** This device's public identity { dh, sig }. */
    fun publicIdentity(): Map<String, Any?>

    /** Encrypts [plaintext] for every device in [devices]; [claimBundles] fetches prekey bundles for devices without a session. */
    fun encryptForDevices(devices: Map<String, Any?>, plaintext: String, claimBundles: (userId: String, deviceIds: List<String>) -> List<Any?>): Map<String, Any?>

    /** Decrypts one device entry { p?, h, c } sent by userId/deviceId; returns the plaintext. */
    fun decryptFromDevice(userId: String, deviceId: String, entry: Map<String, Any?>): String

    /** The other device lost its session: the next message to it starts a fresh key agreement. */
    fun forgetSession(userId: String, deviceId: String)

    /** Group message: returns { body: { mh, g, x? }, keyId }. */
    fun encryptGroup(groupId: String, meUserId: String, meDeviceId: String, memberDevices: Map<String, List<String>>, plaintext: String, claimBundles: (userId: String, deviceIds: List<String>) -> List<Any?>): Map<String, Any?>

    /** The server stored the group message: its sender key distribution stops being attached. */
    fun confirmGroupSend(groupId: String, keyId: String)

    fun resetGroup(groupId: String)

    fun decryptGroup(groupId: String, meUserId: String, meDeviceId: String, userId: String, deviceId: String, body: Map<String, Any?>): String

    /** The 60-digit safety number (12 groups of 5) over both accounts' device identities. */
    fun safetyNumber(mine: List<Map<String, Any?>>, theirs: List<Map<String, Any?>>): String

    /** This device's identity signature over the phone's notification preview public key (base64 in, base64 out). */
    fun signPreviewKey(previewKeyBase64: String): String

    /** ECDH of this device's identity key with a linked device's link key: 32 bytes. */
    fun identityAgreement(publicKey: ByteArray): ByteArray

    /** Forgets every key and session of this device (sign-out). */
    fun wipe()
}

class ProtocolError(val code: String, message: String) : Exception(message)

/**
 * Where the core keeps what it must remember between calls (identity, prekeys, sessions, pinned identities, sender
 * keys), by name, as JSON text: the same records the web protocol kept in its key storage. NativeStore implements it
 * on the SQLCipher database; tests use a map.
 */
interface KeyRecords {
    fun get(name: String): String?
    fun set(name: String, json: String)
    fun delete(name: String)
    /** Removes every record (sign-out). */
    fun clear()
    /** Runs [work] with no other core operation interleaved (sessions are read, advanced and written back as one step). */
    fun <T> exclusive(work: () -> T): T
}

/** The one core in use, set at start-up by the app shell; null until an implementation is wired in. */
object CryptoCores {
    @Volatile
    private var active: CryptoCore? = null
    fun install(core: CryptoCore?) { active = core }
    fun current(): CryptoCore? = active
    fun available(): Boolean = active != null
}
