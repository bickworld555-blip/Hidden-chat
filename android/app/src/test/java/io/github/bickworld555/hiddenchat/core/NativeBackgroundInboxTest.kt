package io.github.bickworld555.hiddenchat.core

import io.github.bickworld555.hiddenchat.core.crypto.MapRecords
import org.junit.Assert.assertEquals
import org.junit.Test

/** The native background inbox keeps sealed events in arrival order and hands them over exactly once. */
class NativeBackgroundInboxTest {
    @Test
    fun keepsInOrderAndTakesOnce() {
        val inbox = NativeBackgroundInbox(MapRecords())
        inbox.add("sealed-1")
        inbox.add("sealed-2")
        inbox.add("sealed-3")
        assertEquals(3, inbox.size())
        assertEquals(listOf("sealed-1", "sealed-2", "sealed-3"), inbox.takeAll())
        assertEquals("cleared after take", 0, inbox.size())
        assertEquals(emptyList<String>(), inbox.takeAll())
    }

    @Test
    fun survivesAcrossInstancesOnTheSameRecords() {
        val records = MapRecords()
        NativeBackgroundInbox(records).add("x")
        // A new instance (e.g. a later service run) sees what an earlier one stored.
        assertEquals(listOf("x"), NativeBackgroundInbox(records).takeAll())
    }
}
