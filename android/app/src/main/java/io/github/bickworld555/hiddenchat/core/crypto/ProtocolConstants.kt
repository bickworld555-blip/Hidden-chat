package io.github.bickworld555.hiddenchat.core.crypto

/**
 * The protocol's fixed strings, shared by every implementation of [CryptoCore]. These are domain-separation labels
 * and context strings that are part of the wire format (src/e2e/ratchet.js KDF_INFO, src/e2e/deviceList.js,
 * src/e2e/preview.js, docs/security/ENCRYPTION-AUDIT.md §3): changing one breaks interoperability with every device
 * already running the web code. They are public constants, not secrets and not the cryptography itself.
 */
object KdfInfo {
    const val X3DH = "HiddenMessenger X3DH P-256 v1"
    const val ROOT = "HiddenMessenger DoubleRatchet root v1"
    const val MESSAGE = "HiddenMessenger DoubleRatchet message v1"
    const val SIGNED_PREKEY = "HiddenMessenger signed prekey v1"
}

object ProtocolLabels {
    const val SENDER_KEY_MESSAGE = "HiddenMessenger SenderKey message v1"
    const val PREVIEW_INFO = "hm-preview-v1"
    const val PREVIEW_KEY_STATEMENT = "hm-preview-key-v1|"
    const val DEVICE_LIST_CONTEXT = "HiddenMessenger device list v1"
    const val LINK_CLAIM_CONTEXT = "HiddenMessenger link claim v1"
}
