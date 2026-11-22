package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.HmCryptoCore
import io.github.bickworld555.hiddenchat.core.crypto.MapRecords
import io.github.bickworld555.hiddenchat.core.crypto.SecureRng
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The decrypt-on-fetch handler opens real message:new / group:message events and reports undecryptable ones. */
class NativeFetchHandlerTest {
    private val aliceUser = "1111111111"; private val aliceDev = "alice-dev"
    private val bobUser = "2222222222"; private val bobDev = "bob-dev"

    private fun setup(): Triple<HmCryptoCore, HmCryptoCore, (String, List<String>) -> List<Any?>> {
        val alice = HmCryptoCore(MapRecords(), SecureRng)
        val bob = HmCryptoCore(MapRecords(), SecureRng)
        val upload = bob.prepareUpload(0, 1700000000000L)
        val preKeys = Json.list(upload["preKeys"])!!
        var next = 0
        val claim: (String, List<String>) -> List<Any?> = { _, ids ->
            ids.map { Json.obj("deviceId" to it, "identity" to upload["identity"], "signedPreKey" to upload["signedPreKey"], "preKey" to preKeys[next++]) }
        }
        return Triple(alice, bob, claim)
    }

    @Test
    fun opensADirectEvent() {
        val (alice, bob, claim) = setup()
        val entries = alice.encryptForDevices(mapOf(bobUser to listOf(Json.obj("deviceId" to bobDev))), "hi bob", claim)
        val content = NativeInbox.PREFIX + "text|" + Json.stringify(Json.obj("v" to 2L, "sd" to aliceDev, "d" to entries))
        val event = Json.obj("type" to "message:new", "message" to Json.obj("id" to "m1", "senderId" to aliceUser, "content" to content))
        val delivery = NativeFetchHandler.handle(bob, bobUser, bobDev, event)!!
        assertTrue(delivery.opened)
        assertEquals("hi bob", delivery.plaintext)
        assertEquals("m1", delivery.messageId)
        assertEquals(aliceUser, delivery.senderId)
    }

    @Test
    fun opensAGroupEvent() {
        val (alice, bob, claim) = setup()
        val sent = alice.encryptGroup("grp", aliceUser, aliceDev, mapOf(aliceUser to listOf(aliceDev), bobUser to listOf(bobDev)), "group hi", claim)
        val body = Json.map(sent["body"])!!
        val env = Json.obj("v" to 2L, "sd" to aliceDev, "mh" to body["mh"], "g" to body["g"])
        if (body["x"] != null) env["x"] = body["x"]
        val content = NativeInbox.PREFIX + "text|" + Json.stringify(env)
        val event = Json.obj("type" to "group:message", "message" to Json.obj("id" to "g1", "senderId" to aliceUser, "groupId" to "grp", "content" to content))
        val delivery = NativeFetchHandler.handle(bob, bobUser, bobDev, event)!!
        assertEquals("group hi", delivery.plaintext)
        assertEquals("grp", delivery.groupId)
    }

    @Test
    fun reportsAnUndecryptableMessageWithoutThrowing() {
        val (_, bob, _) = setup()
        val content = NativeInbox.PREFIX + "text|" + Json.stringify(Json.obj("v" to 2L, "sd" to "x", "d" to Json.obj()))
        val event = Json.obj("type" to "message:new", "message" to Json.obj("id" to "m9", "senderId" to aliceUser, "content" to content))
        val delivery = NativeFetchHandler.handle(bob, bobUser, bobDev, event)!!
        assertFalse(delivery.opened)
        assertEquals("not-addressed", delivery.error)
    }

    @Test
    fun ignoresNonMessageEvents() {
        val (_, bob, _) = setup()
        assertNull(NativeFetchHandler.handle(bob, bobUser, bobDev, Json.obj("type" to "connection:ready")))
        assertNull(NativeFetchHandler.handle(bob, bobUser, bobDev, Json.obj("type" to "message:ack", "message" to Json.obj("id" to "m1"))))
    }
}
