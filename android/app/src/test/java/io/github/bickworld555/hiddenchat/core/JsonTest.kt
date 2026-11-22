package io.github.bickworld555.hiddenchat.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Json must write what JavaScript's JSON.stringify writes: the protocol's associated data and signed lists depend on it. */
class JsonTest {
    @Test
    fun writesLikeJavaScript() {
        assertEquals("""["hm-sk-v1","group/1","user/dev",0]""", Json.stringify(listOf("hm-sk-v1", "group/1", "user/dev", 0L)))
        assertEquals("""{"v":1,"u":"22","d":[{"id":"a","dh":null}]}""", Json.stringify(Json.obj("v" to 1L, "u" to "22", "d" to listOf(Json.obj("id" to "a", "dh" to null)))))
        assertEquals("\"quote \\\" slash / back \\\\ nl \\n tab \\t nul \\u0000 bn বাংলা\"", Json.stringify("quote \" slash / back \\ nl \n tab \t nul \u0000 bn বাংলা"))
        assertEquals("a lone surrogate is escaped, as well-formed JSON.stringify does", "\"\\ud800\"", Json.stringify("\ud800"))
        assertEquals("a surrogate pair stays", "\"😀\"", Json.stringify("😀"))
        assertEquals("1700000000123", Json.stringify(1700000000123L))
        assertEquals("2", Json.stringify(2.0))
        assertEquals("true", Json.stringify(true))
    }

    @Test
    fun readsBack() {
        val value = Json.map(Json.parse("""{"dh":"QQ==","pn":0,"n":12,"x":{"a":[1,2.5,"s",null,true]},"big":9007199254740993}"""))!!
        assertEquals("QQ==", value["dh"])
        assertEquals(0L, value["pn"])
        assertEquals(12L, Json.safeInteger(value["n"]))
        assertEquals(listOf<Any?>(1L, 2.5, "s", null, true), Json.list(Json.map(value["x"])!!["a"]))
        assertNull("beyond 2^53 is not a safe integer", Json.safeInteger(value["big"]))
        assertEquals("a/b\n\u00e9\ud83d\ude00", Json.parse("\"a\\/b\\n\\u00e9\\ud83d\\ude00\""))
    }

    @Test
    fun roundTripsCanonically() {
        val text = """{"v":1,"u":"2222222222","ak":"abc","n":3,"at":1700000000123,"d":[{"id":"dev-a","dh":"x","sig":"y"}]}"""
        assertEquals(text, Json.stringify(Json.parse(text)))
    }

    @Test
    fun refusesMalformed() {
        for (bad in listOf("{", "[1,]", "{\"a\":1,}", "01", "\"unterminated", "{\"a\":1} x", "nul", "\"\u0001\"")) {
            assertTrue("accepted: $bad", runCatching { Json.parse(bad) }.isFailure)
        }
    }
}
