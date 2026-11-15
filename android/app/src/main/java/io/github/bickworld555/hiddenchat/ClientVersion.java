package io.github.bickworld555.hiddenchat;

/**
 * This app's wire version, the same number as src/clientVersion.js: sent with every request the native side makes to
 * the server (and on its background socket), which refuses older apps (server/clientGate.mjs).
 */
final class ClientVersion {
    // 3: confirms incoming calls (PushService posts /api/v1/calls/:id/ringing; the app sends a "ringing" signal).
    static final int PROTOCOL = 3;
    static final String HEADER = "X-HM-Client";
    static final String SUBPROTOCOL = "relay.client." + PROTOCOL;

    private ClientVersion() {}
}
