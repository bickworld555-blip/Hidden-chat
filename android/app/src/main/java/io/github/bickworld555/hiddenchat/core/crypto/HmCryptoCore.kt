package io.github.bickworld555.hiddenchat.core.crypto

import io.github.bickworld555.hiddenchat.core.Json
import io.github.bickworld555.hiddenchat.core.crypto.Primitives as P

/**
 * The [CryptoCore] implementation: the orchestration of src/e2e/protocol.js (createProtocol) over [KeyRecords],
 * driving the X3DH / Double Ratchet / Sender Keys state machines. Device identity, prekeys, sessions (current +
 * previous), trust-on-first-use pins, and per-group sender keys are kept as JSON records, by the same record keys the
 * web protocol uses. Every operation runs under `records.exclusive {}` so a session is read, advanced and written
 * back atomically.
 *
 * `rng` is injected so the conformance test can replay the recorded key material; production passes [SecureRng].
 */
class HmCryptoCore(private val records: KeyRecords, private val rng: Rng = SecureRng) : CryptoCore {

    companion object {
        const val PREKEY_BATCH = 100
        const val PREKEY_LOW_WATER = 25
        const val SIGNED_PREKEY_ROTATION_MS = 7L * 24 * 60 * 60 * 1000
        const val KEEP_SIGNED_PREKEYS = 3
        const val KEEP_PREVIOUS_SESSIONS = 4
        const val KEEP_RECEIVING_SENDER_KEYS = 4
    }

    // ---------- record helpers ----------
    private fun loadMap(name: String): MutableMap<String, Any?>? = records.get(name)?.let { Json.map(Json.parse(it))?.toMutableMap() }
    private fun loadList(name: String): MutableList<Any?>? = records.get(name)?.let { Json.list(Json.parse(it))?.toMutableList() }
    private fun saveJson(name: String, value: Any?) = records.set(name, Json.stringify(value))
    private fun keyMap(k: EcKeyPair) = Json.obj("d" to P.b64(P.encodePrivate(k.priv)), "pub" to k.pubB64)
    private fun keyFromMap(m: Map<*, *>) = EcKeyPair.fromRaw(P.unb64(m["d"] as String), P.unb64(m["pub"] as String))
    private fun str(v: Any?) = v as String
    private fun int(v: Any?) = (v as Number).toInt()
    private fun long(v: Any?) = (v as Number).toLong()
    private fun address(userId: String, deviceId: String) = "$userId/$deviceId"
    private fun toHex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    // ---------- identity ----------
    private fun identity(): IdentityKeys {
        loadMap("identity")?.let { return IdentityKeys(keyFromMap(it["dh"] as Map<*, *>), keyFromMap(it["sig"] as Map<*, *>)) }
        val id = IdentityKeys(rng.keyPair(), rng.keyPair())
        saveJson("identity", Json.obj("dh" to keyMap(id.dh), "sig" to keyMap(id.sig), "createdAt" to System.currentTimeMillis()))
        records.set("list-join-pending", "true")
        return id
    }

    private fun publicIdentityMap(id: IdentityKeys) = Json.obj("dh" to id.dh.pubB64, "sig" to id.sig.pubB64)
    private fun identityBytes(dhB64: String, sigB64: String) = P.concat(P.unb64(dhB64), P.unb64(sigB64))

    override fun publicIdentity(): Map<String, Any?> = records.exclusive { publicIdentityMap(identity()) }

    override fun identityAgreement(publicKey: ByteArray): ByteArray = records.exclusive { P.dh(identity().dh.priv, P.decodePublic(publicKey)) }

    // ---------- prekeys ----------
    override fun prepareUpload(serverPreKeyCount: Int, now: Long): Map<String, Any?> = records.exclusive {
        val own = identity()
        val meta = loadMap("meta") ?: mutableMapOf("spkIds" to mutableListOf<Any?>(), "nextSpkId" to 1L, "nextPreKeyId" to 1L)
        val spkIds = (Json.list(meta["spkIds"]) ?: emptyList()).map { long(it) }.toMutableList()
        var nextSpkId = long(meta["nextSpkId"])
        var nextPreKeyId = long(meta["nextPreKeyId"])

        var current = spkIds.lastOrNull()?.let { loadMap("spk:$it") }
        if (current == null || now - long(current["createdAt"]) > SIGNED_PREKEY_ROTATION_MS) {
            val kp = rng.keyPair()
            val signature = X3dh.signSignedPreKey(own, kp.pub)
            val id = nextSpkId; nextSpkId += 1
            current = mutableMapOf("id" to id, "d" to P.b64(P.encodePrivate(kp.priv)), "pub" to kp.pubB64, "signature" to P.b64(signature), "createdAt" to now)
            saveJson("spk:$id", current)
            spkIds.add(id)
            val drop = spkIds.size - KEEP_SIGNED_PREKEYS
            if (drop > 0) { for (old in spkIds.subList(0, drop)) records.delete("spk:$old"); repeat(drop) { spkIds.removeAt(0) } }
        }

        val preKeys = mutableListOf<Any?>()
        if (serverPreKeyCount < PREKEY_LOW_WATER) {
            var count = serverPreKeyCount
            while (count < PREKEY_BATCH) {
                val id = nextPreKeyId; nextPreKeyId += 1
                val kp = rng.keyPair()
                saveJson("opk:$id", Json.obj("d" to P.b64(P.encodePrivate(kp.priv)), "pub" to kp.pubB64))
                preKeys.add(Json.obj("id" to id, "key" to kp.pubB64))
                count += 1
            }
        }
        saveJson("meta", Json.obj("spkIds" to spkIds, "nextSpkId" to nextSpkId, "nextPreKeyId" to nextPreKeyId))
        Json.obj(
            "identity" to publicIdentityMap(own),
            "signedPreKey" to Json.obj("id" to long(current["id"]), "key" to str(current["pub"]), "signature" to str(current["signature"])),
            "preKeys" to preKeys,
        )
    }

    // ---------- sessions ----------
    private class Session(val ratchet: RatchetState, val pending: Map<String, Any?>?, val baseKey: String, val remote: String, val consumePreKey: Long?, val remember: (() -> Unit)?)

    private fun sessionToMap(s: Session): Map<String, Any?> {
        val m = Json.obj("ratchet" to s.ratchet.toMap(), "baseKey" to s.baseKey, "remote" to s.remote)
        if (s.pending != null) m["pending"] = s.pending
        return m
    }

    private fun sessionFromMap(m: Map<*, *>): Session = Session(
        RatchetState.fromMap(m["ratchet"] as Map<*, *>),
        (m["pending"] as? Map<*, *>)?.let { @Suppress("UNCHECKED_CAST") (it as Map<String, Any?>) },
        str(m["baseKey"]), str(m["remote"]), null, null,
    )

    private class SessionRecord(var current: Session?, val previous: MutableList<Session>)

    private fun loadSessions(target: String): SessionRecord {
        val m = loadMap("session:$target") ?: return SessionRecord(null, mutableListOf())
        val current = (m["current"] as? Map<*, *>)?.let { sessionFromMap(it) }
        val previous = (Json.list(m["previous"]) ?: emptyList()).map { sessionFromMap(it as Map<*, *>) }.toMutableList()
        return SessionRecord(current, previous)
    }

    private fun saveSessions(target: String, current: Session?, previous: List<Session>) {
        val m = Json.obj("current" to current?.let { sessionToMap(it) }, "previous" to previous.map { sessionToMap(it) })
        saveJson("session:$target", m)
    }

    private fun checkTrusted(userId: String, deviceId: String, presented: String): (() -> Unit)? {
        val key = "known:${address(userId, deviceId)}"
        val known = records.get(key)
        if (known == presented) return null
        // Trust on first use; a later change is accepted (the app surfaces "security code changed" elsewhere).
        return { records.set(key, presented) }
    }

    // ---------- direct encryption ----------
    private fun parseBundle(any: Any?): PreKeyBundle {
        val b = Json.map(any) ?: throw ProtocolError("no-bundle", "bad bundle")
        val id = Json.map(b["identity"])!!
        val spk = Json.map(b["signedPreKey"])!!
        val opk = Json.map(b["preKey"])
        return PreKeyBundle(
            identityDh = P.unb64(str(id["dh"])), identitySig = P.unb64(str(id["sig"])),
            signedPreKeyId = int(spk["id"]), signedPreKey = P.unb64(str(spk["key"])), signedPreKeySignature = P.unb64(str(spk["signature"])),
            preKeyId = opk?.let { int(it["id"]) }, preKey = opk?.let { P.unb64(str(it["key"])) },
        )
    }

    private fun preKeyHeaderMap(own: IdentityKeys, x: X3dhInitiation): Map<String, Any?> {
        val m = Json.obj("ik" to publicIdentityMap(own), "ek" to P.b64(x.ephemeralPub), "spk" to x.signedPreKeyId.toLong())
        if (x.preKeyId != null) m["opk"] = x.preKeyId.toLong()
        return m
    }

    override fun encryptForDevices(devices: Map<String, Any?>, plaintext: String, claimBundles: (String, List<String>) -> List<Any?>): Map<String, Any?> = records.exclusive {
        val own = identity()
        val bytes = P.utf8(plaintext)
        val out = Json.obj()
        val updates = mutableListOf<Pair<String, SessionRecord>>()
        val trustUpdates = mutableListOf<() -> Unit>()

        for ((userId, listAny) in devices) {
            val list = Json.list(listAny) ?: emptyList()
            val perDevice = LinkedHashMap<String, SessionRecord>()
            val missing = mutableListOf<String>()
            for (devAny in list) {
                val dev = Json.map(devAny)!!
                val deviceId = str(dev["deviceId"])
                val listed = Json.map(dev["identity"])
                var rec = loadSessions(address(userId, deviceId))
                if (rec.current != null && listed != null) {
                    val listedPresented = P.b64(identityBytes(str(listed["dh"]), str(listed["sig"])))
                    if (rec.current!!.remote != listedPresented) {
                        rec = SessionRecord(null, (listOf(rec.current!!) + rec.previous).take(KEEP_PREVIOUS_SESSIONS).toMutableList())
                    }
                }
                perDevice[deviceId] = rec
                if (rec.current == null) missing.add(deviceId)
            }
            if (missing.isNotEmpty()) {
                val bundles = claimBundles(userId, missing)
                for (deviceId in missing) {
                    val bundleAny = bundles.firstOrNull { Json.string(Json.map(it)?.get("deviceId")) == deviceId }
                        ?: throw ProtocolError("no-bundle", "a device of this contact has no keys yet")
                    val bundle = parseBundle(bundleAny)
                    val x = X3dh.initiate(own, bundle, rng)
                    val remotePresented = P.b64(P.concat(bundle.identityDh, bundle.identitySig))
                    checkTrusted(userId, deviceId, remotePresented)?.let { trustUpdates.add(it) }
                    val ratchet = DoubleRatchet.initInitiator(x, rng)
                    perDevice[deviceId]!!.current = Session(ratchet, preKeyHeaderMap(own, x), P.b64(x.ephemeralPub), remotePresented, null, null)
                }
            }
            val perUser = Json.obj()
            for (devAny in list) {
                val deviceId = str(Json.map(devAny)!!["deviceId"])
                val rec = perDevice[deviceId]!!
                val cur = rec.current!!
                val (nextRatchet, msg) = DoubleRatchet.encrypt(cur.ratchet, bytes)
                rec.current = Session(nextRatchet, cur.pending, cur.baseKey, cur.remote, cur.consumePreKey, cur.remember)
                updates.add(address(userId, deviceId) to rec)
                val entry = Json.obj()
                if (cur.pending != null) entry["p"] = cur.pending
                entry["h"] = msg.header.toMap()
                entry["c"] = P.b64(msg.ciphertext)
                perUser[deviceId] = entry
            }
            out[userId] = perUser
        }
        for ((target, rec) in updates) saveSessions(target, rec.current, rec.previous)
        for (remember in trustUpdates) remember()
        out
    }

    private fun respondTo(userId: String, deviceId: String, header: Map<String, Any?>): Session {
        val own = identity()
        val spk = loadMap("spk:${long(header["spk"])}") ?: throw ProtocolError("stale-prekey", "expired signed prekey")
        val opkId = (header["opk"] as? Number)?.toLong()
        val opk = opkId?.let { loadMap("opk:$it") }
        if (opkId != null && opk == null) throw ProtocolError("stale-prekey", "one-time prekey already used")
        val ik = Json.map(header["ik"])!!
        val resp = X3dh.respond(own, P.unb64(str(ik["dh"])), P.unb64(str(ik["sig"])), P.unb64(str(header["ek"])), keyFromMap(spk), opk?.let { keyFromMap(it) })
        val remotePresented = P.b64(identityBytes(str(ik["dh"]), str(ik["sig"])))
        val remember = checkTrusted(userId, deviceId, remotePresented)
        val ratchet = DoubleRatchet.initResponder(resp, keyFromMap(spk))
        return Session(ratchet, null, str(header["ek"]), remotePresented, opkId, remember)
    }

    override fun decryptFromDevice(userId: String, deviceId: String, entry: Map<String, Any?>): String = records.exclusive {
        val target = address(userId, deviceId)
        val rec = loadSessions(target)
        val header = RatchetHeader.fromMap(Json.map(entry["h"]) ?: throw ProtocolError("decrypt-failed", "no header"))
        val ciphertext = P.unb64(str(entry["c"]))
        val pending = Json.map(entry["p"])
        val candidates = mutableListOf<Session>()
        if (pending != null) {
            val ek = str(pending["ek"])
            val existing = (listOfNotNull(rec.current) + rec.previous).firstOrNull { it.baseKey == ek }
            if (existing != null) candidates.add(existing) else candidates.add(respondTo(userId, deviceId, pending))
        } else {
            candidates.addAll(listOfNotNull(rec.current) + rec.previous)
        }
        var lastError: Exception = ProtocolError("no-session", "no secure session with this device yet")
        for (session in candidates) {
            try {
                val (nextRatchet, pt) = DoubleRatchet.decrypt(session.ratchet, header, ciphertext, rng)
                val updated = Session(nextRatchet, if (pending != null) session.pending else null, session.baseKey, session.remote, null, null)
                val others = (listOfNotNull(rec.current) + rec.previous).filter { it !== session && it.baseKey != session.baseKey }
                saveSessions(target, updated, others.take(KEEP_PREVIOUS_SESSIONS))
                session.consumePreKey?.let { records.delete("opk:$it") }
                session.remember?.invoke()
                return@exclusive String(pt, Charsets.UTF_8)
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw if (lastError is ProtocolError) lastError else ProtocolError("decrypt-failed", "this message could not be decrypted")
    }

    override fun forgetSession(userId: String, deviceId: String) { records.exclusive {
        val target = address(userId, deviceId)
        val rec = loadSessions(target)
        if (rec.current == null) return@exclusive
        saveSessions(target, null, (listOf(rec.current!!) + rec.previous).take(KEEP_PREVIOUS_SESSIONS))
    } }

    // ---------- groups (Sender Keys) ----------
    private fun ownSenderKeyToMap(s: OwnSenderKey) = Json.obj(
        "groupId" to s.groupId, "kid" to s.kid, "chainKey" to P.b64(s.chainKey), "n" to s.n,
        "signing" to keyMap(s.signing), "initialChainKey" to s.initialChainKey?.let { P.b64(it) }, "memberHash" to s.memberHash,
    )

    private fun ownSenderKeyFromMap(m: Map<*, *>) = OwnSenderKey(
        str(m["groupId"]), str(m["kid"]), P.unb64(str(m["chainKey"])), int(m["n"]),
        keyFromMap(m["signing"] as Map<*, *>), (m["initialChainKey"] as? String)?.let { P.unb64(it) }, str(m["memberHash"]),
    )

    private fun inboundToMap(s: InboundSenderKey) = Json.obj(
        "groupId" to s.groupId, "kid" to s.kid, "chainKey" to P.b64(s.chainKey), "n" to s.n, "signingPub" to P.b64(s.signingPub),
        "skipped" to s.skipped.entries.associateTo(linkedMapOf<String, Any?>()) { it.key.toString() to P.b64(it.value) },
    )

    private fun inboundFromMap(m: Map<*, *>): InboundSenderKey {
        val skipped = linkedMapOf<Int, ByteArray>()
        (m["skipped"] as? Map<*, *>)?.forEach { (k, v) -> skipped[(k as String).toInt()] = P.unb64(v as String) }
        return InboundSenderKey(str(m["groupId"]), str(m["kid"]), P.unb64(str(m["chainKey"])), int(m["n"]), P.unb64(str(m["signingPub"])), skipped)
    }

    private fun membersHash(addresses: List<String>): String = toHex(P.sha256(P.utf8(addresses.sorted().joinToString("\n")))).substring(0, 32)

    override fun encryptGroup(groupId: String, meUserId: String, meDeviceId: String, memberDevices: Map<String, List<String>>, plaintext: String, claimBundles: (String, List<String>) -> List<Any?>): Map<String, Any?> = records.exclusive {
        val all = mutableListOf<String>()
        for ((userId, ids) in memberDevices) for (deviceId in ids) all.add(address(userId, deviceId))
        val mh = membersHash(all)
        val ownMapStored = loadMap("sk-own:$groupId")
        var own = ownMapStored?.let { ownSenderKeyFromMap(it["state"] as Map<*, *>) }
        var distribution = ownMapStored?.get("distribution") as? Map<*, *>
        if (own == null || own.memberHash != mh) {
            own = SenderKeys.create(groupId, mh, rng)
            distribution = own.distribution().toMap()
        }
        val body = Json.obj()
        body["mh"] = mh
        if (distribution != null) {
            val targets = Json.obj()
            for ((userId, ids) in memberDevices) {
                val listForUser = ids.filter { !(userId == meUserId && it == meDeviceId) }.map { Json.obj("deviceId" to it) }
                if (listForUser.isNotEmpty()) targets[userId] = listForUser
            }
            if (targets.isNotEmpty()) {
                // encryptForDevices runs its own exclusive(); it is reentrant here (ReentrantLock).
                body["x"] = encryptForDevices(targets, Json.stringify(distribution), claimBundles)
            }
        }
        val (nextOwn, message) = SenderKeys.encrypt(own, address(meUserId, meDeviceId), P.utf8(plaintext))
        body["g"] = message.toMap()
        saveJson("sk-own:$groupId", Json.obj("state" to ownSenderKeyToMap(nextOwn), "distribution" to distribution))
        Json.obj("body" to body, "keyId" to nextOwn.kid)
    }

    override fun confirmGroupSend(groupId: String, keyId: String) { records.exclusive {
        val stored = loadMap("sk-own:$groupId") ?: return@exclusive
        val state = ownSenderKeyFromMap(stored["state"] as Map<*, *>)
        if (stored["distribution"] != null && state.kid == keyId) saveJson("sk-own:$groupId", Json.obj("state" to ownSenderKeyToMap(state.confirmed()), "distribution" to null))
    } }

    override fun resetGroup(groupId: String) { records.exclusive { records.delete("sk-own:$groupId") } }

    override fun decryptGroup(groupId: String, meUserId: String, meDeviceId: String, userId: String, deviceId: String, body: Map<String, Any?>): String = records.exclusive {
        val sender = address(userId, deviceId)
        val key = "sk-in:$groupId:$sender"
        val g = Json.map(body["g"]) ?: throw ProtocolError("decrypt-failed", "no group message")
        val kid = str(g["kid"])
        var states = (loadList(key) ?: mutableListOf()).map { it as Map<*, *> }.toMutableList()
        val mine = Json.map(body["x"])?.let { Json.map(it[meUserId]) }?.let { Json.map(it[meDeviceId]) }
        if (mine != null && states.none { str(it["kid"]) == kid }) {
            val distribution = Json.map(Json.parse(decryptFromDevice(userId, deviceId, mine))) ?: throw ProtocolError("decrypt-failed", "bad distribution")
            if (str(distribution["kid"]) != kid) throw ProtocolError("decrypt-failed", "the group key does not match its message")
            val accepted = SenderKeys.accept(SenderKeyDistribution.fromMap(distribution))
            states = (listOf(inboundToMap(accepted) as Map<*, *>) + states).take(KEEP_RECEIVING_SENDER_KEYS).toMutableList()
            saveJson(key, states)
        }
        val index = states.indexOfFirst { str(it["kid"]) == kid }
        if (index < 0) throw ProtocolError("no-sender-key", "waiting for this message; ask the sender to open the group")
        val (nextInb, pt) = SenderKeys.decrypt(inboundFromMap(states[index]), sender, SenderKeyMessage.fromMap(g))
        states[index] = inboundToMap(nextInb)
        saveJson(key, states)
        String(pt, Charsets.UTF_8)
    }

    // ---------- safety number, preview, wipe ----------
    override fun safetyNumber(mine: List<Map<String, Any?>>, theirs: List<Map<String, Any?>>): String {
        fun flatten(list: List<Map<String, Any?>>) = list.map { "${str(it["dh"])}.${str(it["sig"])}" }.sorted().joinToString(",")
        val pair = listOf(flatten(mine), flatten(theirs)).sorted()
        val digest = P.iteratedSha256(P.utf8("${pair[0]}|${pair[1]}"), 1024)
        val groups = (0 until 12).map {
            val value = (((digest[(it * 2) % 32].toInt() and 0xff) shl 16) or ((digest[(it * 2 + 1) % 32].toInt() and 0xff) shl 8) or (digest[(it * 2 + 5) % 32].toInt() and 0xff)) % 100000
            value.toString().padStart(5, '0')
        }
        return groups.joinToString(" ")
    }

    override fun signPreviewKey(previewKeyBase64: String): String = records.exclusive {
        val statement = P.concat(P.utf8("hm-preview-key-v1|"), P.unb64(previewKeyBase64))
        P.b64(P.sign(identity().sig.priv, statement))
    }

    override fun wipe() { records.exclusive { records.clear() } }
}
