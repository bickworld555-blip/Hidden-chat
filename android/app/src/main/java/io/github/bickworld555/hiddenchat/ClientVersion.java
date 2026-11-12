package io.github.bickworld555.hiddenchat;

/**
 * This app's wire version, the same number as src/clientVersion.js: sent with every request the native side makes to
 * the server (and on its background socket), which refuses older apps (server/clientGate.mjs).
 */
final class ClientVersion {
    static final int PROTOCOL = 2;
    static final String HEADER = "X-HM-Client";
    static final String SUBPROTOCOL = "relay.client." + PROTOCOL;

    private ClientVersion() {}
}
