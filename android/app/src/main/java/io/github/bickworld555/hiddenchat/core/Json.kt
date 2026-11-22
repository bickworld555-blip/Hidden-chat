package io.github.bickworld555.hiddenchat.core

/**
 * JSON exactly as JavaScript writes and reads it. The protocol's wire formats, associated data and signed device
 * lists are defined by `JSON.stringify` (src/e2e/): the same bytes must come out here, so this is written out by
 * hand rather than through Android's org.json (which escapes "/" as "\/", a different byte string under the same
 * signature). Values: String, Long, Double, Boolean, null, List, and Map with insertion order (LinkedHashMap).
 *
 * Pure JVM: no Android classes, so the core runs in unit tests on the computer as well.
 */
object Json {
    fun stringify(value: Any?): String = StringBuilder().also { write(value, it, 0) }.toString()

    private fun write(value: Any?, out: StringBuilder, depth: Int) {
        if (depth > 200) throw IllegalArgumentException("JSON too deep.")
        when (value) {
            null -> out.append("null")
            is String -> quote(value, out)
            is Boolean -> out.append(value)
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Double -> out.append(number(value))
            is Float -> out.append(number(value.toDouble()))
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, entry) in value) {
                    if (!first) out.append(',')
                    first = false
                    quote(key.toString(), out)
                    out.append(':')
                    write(entry, out, depth + 1)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                value.forEachIndexed { index, entry -> if (index > 0) out.append(','); write(entry, out, depth + 1) }
                out.append(']')
            }
            else -> throw IllegalArgumentException("Not a JSON value: ${value::class.java.simpleName}")
        }
    }

    // JavaScript prints an integral double without a decimal point; anything else here is not part of a signed format.
    private fun number(value: Double): String = when {
        value.isNaN() || value.isInfinite() -> "null"
        value == Math.floor(value) && Math.abs(value) < 1e15 -> value.toLong().toString()
        else -> value.toString()
    }

    /** A string as JSON.stringify writes it (well-formed: a lone surrogate becomes \uXXXX). */
    fun quote(text: String, out: StringBuilder) {
        out.append('"')
        var index = 0
        while (index < text.length) {
            val c = text[index]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append(String.format("\\u%04x", c.code))
                c.isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate() -> { out.append(c).append(text[index + 1]); index++ }
                c.isSurrogate() -> out.append(String.format("\\u%04x", c.code))
                else -> out.append(c)
            }
            index++
        }
        out.append('"')
    }

    /** Parses a document; throws IllegalArgumentException on anything malformed or trailing. */
    fun parse(text: String): Any? = Parser(text).document()

    fun map(value: Any?): Map<String, Any?>? {
        @Suppress("UNCHECKED_CAST")
        return value as? Map<String, Any?>
    }

    fun list(value: Any?): List<Any?>? = value as? List<Any?>

    fun string(value: Any?): String? = value as? String

    /** A JavaScript "safe integer" (Number.isSafeInteger): a Long within ±2^53, also when it was read as a double. */
    fun safeInteger(value: Any?): Long? {
        val n: Long = when (value) {
            is Long -> value
            is Int -> value.toLong()
            is Double -> if (value == Math.floor(value) && !value.isInfinite()) value.toLong() else return null
            else -> return null
        }
        return if (n in -9007199254740991L..9007199254740991L) n else null
    }

    fun obj(vararg pairs: Pair<String, Any?>): LinkedHashMap<String, Any?> = linkedMapOf(*pairs)

    private class Parser(private val text: String) {
        private var pos = 0

        fun document(): Any? {
            val value = value(0)
            skipSpace()
            if (pos != text.length) fail("trailing characters")
            return value
        }

        private fun fail(reason: String): Nothing = throw IllegalArgumentException("Invalid JSON ($reason at $pos).")

        private fun skipSpace() {
            while (pos < text.length && (text[pos] == ' ' || text[pos] == '\n' || text[pos] == '\r' || text[pos] == '\t')) pos++
        }

        private fun value(depth: Int): Any? {
            if (depth > 200) fail("too deep")
            skipSpace()
            if (pos >= text.length) fail("unexpected end")
            return when (val c = text[pos]) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c in '0'..'9') num() else fail("unexpected character")
            }
        }

        private fun literal(word: String, result: Any?): Any? {
            if (!text.startsWith(word, pos)) fail("bad literal")
            pos += word.length
            return result
        }

        private fun obj(depth: Int): LinkedHashMap<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            pos++
            skipSpace()
            if (pos < text.length && text[pos] == '}') { pos++; return out }
            while (true) {
                skipSpace()
                if (pos >= text.length || text[pos] != '"') fail("expected key")
                val key = str()
                skipSpace()
                if (pos >= text.length || text[pos] != ':') fail("expected colon")
                pos++
                out[key] = value(depth + 1)
                skipSpace()
                if (pos >= text.length) fail("unexpected end")
                when (text[pos]) {
                    ',' -> pos++
                    '}' -> { pos++; return out }
                    else -> fail("expected , or }")
                }
            }
        }

        private fun arr(depth: Int): ArrayList<Any?> {
            val out = ArrayList<Any?>()
            pos++
            skipSpace()
            if (pos < text.length && text[pos] == ']') { pos++; return out }
            while (true) {
                out.add(value(depth + 1))
                skipSpace()
                if (pos >= text.length) fail("unexpected end")
                when (text[pos]) {
                    ',' -> pos++
                    ']' -> { pos++; return out }
                    else -> fail("expected , or ]")
                }
            }
        }

        private fun str(): String {
            pos++
            val out = StringBuilder()
            while (true) {
                if (pos >= text.length) fail("unterminated string")
                val c = text[pos++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (pos >= text.length) fail("unterminated escape")
                        when (val e = text[pos++]) {
                            '"' -> out.append('"'); '\\' -> out.append('\\'); '/' -> out.append('/')
                            'b' -> out.append('\b'); 'f' -> out.append('\u000C'); 'n' -> out.append('\n'); 'r' -> out.append('\r'); 't' -> out.append('\t')
                            'u' -> {
                                if (pos + 4 > text.length) fail("bad unicode escape")
                                out.append(text.substring(pos, pos + 4).toInt(16).toChar())
                                pos += 4
                            }
                            else -> fail("bad escape \\$e")
                        }
                    }
                    c < ' ' -> fail("control character in string")
                    else -> out.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = pos
            if (text[pos] == '-') pos++
            if (pos >= text.length) fail("bad number")
            if (text[pos] == '0') pos++
            else if (text[pos] in '1'..'9') while (pos < text.length && text[pos] in '0'..'9') pos++
            else fail("bad number")
            var integral = true
            if (pos < text.length && text[pos] == '.') {
                integral = false
                pos++
                if (pos >= text.length || text[pos] !in '0'..'9') fail("bad fraction")
                while (pos < text.length && text[pos] in '0'..'9') pos++
            }
            if (pos < text.length && (text[pos] == 'e' || text[pos] == 'E')) {
                integral = false
                pos++
                if (pos < text.length && (text[pos] == '+' || text[pos] == '-')) pos++
                if (pos >= text.length || text[pos] !in '0'..'9') fail("bad exponent")
                while (pos < text.length && text[pos] in '0'..'9') pos++
            }
            val raw = text.substring(start, pos)
            if (integral) raw.toLongOrNull()?.let { return it }
            return raw.toDouble()
        }
    }
}
