package io.github.bickworld555.hiddenchat

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes a compressed audio file to a 16-bit PCM WAV. The WebView records voice notes as webm/opus with no cue points,
 * so Android's players (MediaPlayer and ExoPlayer alike) report the item non-seekable and a tap-to-seek reverts to the
 * start. A decoded WAV is trivially seekable, which makes the native voice-note bubble's seek work. Playback is
 * unchanged (same audio). Runs off the main thread (blocking decode).
 */
object AudioDecode {
    /** Decodes [src] to a WAV at [dst]; returns true on success (some PCM was written). */
    fun decodeToWav(src: File, dst: File): Boolean {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        var raf: RandomAccessFile? = null
        try {
            extractor.setDataSource(src.absolutePath)
            var trackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) { trackIndex = i; format = f; break }
            }
            if (trackIndex < 0 || format == null) return false
            extractor.selectTrack(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: return false

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(format, null, null, 0)
            codec.start()

            raf = RandomAccessFile(dst, "rw")
            raf.setLength(0)
            // Sample rate / channels can be corrected from the decoder's output format once known; seed from the track.
            var sampleRate = format.getIntegerOr(MediaFormat.KEY_SAMPLE_RATE, 48000)
            var channels = format.getIntegerOr(MediaFormat.KEY_CHANNEL_COUNT, 1)
            writeWavHeader(raf, sampleRate, channels, 0)
            var pcmBytes = 0L

            val info = MediaCodec.BufferInfo()
            var sawInputEos = false
            var sawOutputEos = false
            while (!sawOutputEos) {
                if (!sawInputEos) {
                    val inIndex = codec.dequeueInputBuffer(10000)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex)
                        val size = if (inBuf != null) extractor.readSampleData(inBuf, 0) else -1
                        if (size < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEos = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }
                val outIndex = codec.dequeueOutputBuffer(info, 10000)
                if (outIndex >= 0) {
                    val outBuf = codec.getOutputBuffer(outIndex)
                    if (outBuf != null && info.size > 0) {
                        val chunk = ByteArray(info.size)
                        outBuf.position(info.offset)
                        outBuf.get(chunk, 0, info.size)
                        raf.write(chunk)
                        pcmBytes += info.size
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
                } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val out = codec.outputFormat
                    sampleRate = out.getIntegerOr(MediaFormat.KEY_SAMPLE_RATE, sampleRate)
                    channels = out.getIntegerOr(MediaFormat.KEY_CHANNEL_COUNT, channels)
                }
            }
            writeWavHeader(raf, sampleRate, channels, pcmBytes)
            return pcmBytes > 0
        } catch (failed: Throwable) {
            android.util.Log.w("AudioDecode", "decode failed", failed)
            return false
        } finally {
            runCatching { raf?.close() }
            runCatching { codec?.stop() }; runCatching { codec?.release() }
            runCatching { extractor.release() }
        }
    }

    private fun MediaFormat.getIntegerOr(key: String, fallback: Int): Int =
        if (containsKey(key)) getInteger(key) else fallback

    /** Writes a 44-byte PCM WAV header at the start of the file (16-bit little-endian). */
    private fun writeWavHeader(raf: RandomAccessFile, sampleRate: Int, channels: Int, pcmBytes: Long) {
        raf.seek(0)
        val byteRate = sampleRate * channels * 2
        val bb = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        bb.put("RIFF".toByteArray(Charsets.US_ASCII))
        bb.putInt((36 + pcmBytes).toInt())
        bb.put("WAVE".toByteArray(Charsets.US_ASCII))
        bb.put("fmt ".toByteArray(Charsets.US_ASCII))
        bb.putInt(16)
        bb.putShort(1)
        bb.putShort(channels.toShort())
        bb.putInt(sampleRate)
        bb.putInt(byteRate)
        bb.putShort((channels * 2).toShort())
        bb.putShort(16)
        bb.put("data".toByteArray(Charsets.US_ASCII))
        bb.putInt(pcmBytes.toInt())
        raf.write(bb.array())
    }
}
