package io.github.bickworld555.hiddenchat;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secrets at rest, protected by the Android Keystore like WhatsApp's AndroidKeyStore + AES/GCM use: an AES-256 key
 * generated inside the Keystore (hardware-backed where the phone has it) that never leaves it. Values are sealed as
 * "ks1:" + base64(iv || ciphertext || tag).
 *
 * Used for the session token and push key in this app's preferences, and to wrap the web app's local data key
 * (src/secureStorage.js), so nothing readable is left on disk if the app's files are copied off the phone.
 */
final class SecureStore {
    private static final String TAG = "SecureStore";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "hm-secure-store-v1";
    private static final String PREFIX = "ks1:";
    private static final int IV_BYTES = 12;

    private SecureStore() {}

    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry entry = store.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    static boolean isSealed(String value) {
        return value != null && value.startsWith(PREFIX);
    }

    /** Seals a value; null in, null out. Throws if the Keystore is unusable (callers decide the fallback). */
    static String seal(String plain) throws Exception {
        if (plain == null) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
    }

    /** Opens a sealed value; a value that was never sealed (stored by an older version) is returned as it is. */
    static String open(String stored) throws Exception {
        if (stored == null || !isSealed(stored)) return stored;
        byte[] all = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, IV_BYTES));
        return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
    }

    /** seal() that never throws: on a phone whose Keystore fails, the value is kept as before (logged). */
    static String sealOrKeep(String plain) {
        try {
            return seal(plain);
        } catch (Exception broken) {
            Log.w(TAG, "Keystore unavailable; value kept unsealed", broken);
            return plain;
        }
    }

    /** open() that never throws: a value that cannot be opened (Keystore reset) reads as missing. */
    static String openOrNull(String stored) {
        try {
            return open(stored);
        } catch (Exception broken) {
            Log.w(TAG, "sealed value could not be opened (Keystore key changed?)", broken);
            return null;
        }
    }
}
