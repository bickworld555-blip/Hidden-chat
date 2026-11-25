package io.github.bickworld555.hiddenchat

/**
 * The disappearing-message timers the app honors (item 4): 24 hours, 7 days, 90 days — and nothing else. A faithful
 * match of the web (src/e2e/lifecycle.js `cleanDisappear` / `DISAPPEAR_CHOICES`, src/disappearing.js): any other `ex`
 * duration found inside an envelope, or any other `chat:disappearing` value, is IGNORED (treated as "no timer").
 *
 * Why native must agree with the web here: without this, native honored an arbitrary `ex` (e.g. a test/malicious peer's
 * 20 s) while the WebView ignored it. Native would set an expiry and sweep the message from its chat_messages
 * projection, but the WebView — treating it as an ordinary, non-disappearing message — kept it and re-mirrored it on the
 * next relaunch, so the swept message resurrected. Validating `ex` the same way on both sides removes that disagreement.
 */
object NativeDisappear {
    // 24h, 7d, 90d in seconds (src/disappearing.js). The only durations a timer may take.
    private val STANDARD_SECONDS = setOf(86_400L, 604_800L, 7_776_000L)

    /** [seconds] when it is one of the allowed disappearing timers, else 0 ("no timer"). Mirrors web cleanDisappear. */
    fun clean(seconds: Long?): Long = if (seconds != null && seconds in STANDARD_SECONDS) seconds else 0L
}
