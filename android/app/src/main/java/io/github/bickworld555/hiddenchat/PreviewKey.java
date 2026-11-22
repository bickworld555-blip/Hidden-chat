package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * This phone's notification preview key (src/e2e/preview.js): a P-256 key pair whose private half never leaves
 * Android (stored in preferences encrypted by an Android Keystore key). Senders seal the first words of a message to
 * the public half; the sealed preview arrives inside the push and is opened here, so the notification shows the real
 * text at once, without waiting for the app's WebView (where the message keys live) to start: 1-2 s on the S23.
 *
 * Sealed form: ephemeral public key (65 bytes, uncompressed) ‖ iv (12) ‖ AES-256-GCM ciphertext and tag. Key: HKDF-
 * SHA-256 of the ECDH secret, salt = ephemeral ‖ recipient public keys, info "hm-preview-v1". Associated data: the
 * sender's user id. Plaintext: JSON { t: text, at: ms }; a preview older than MAX_AGE_MS is not shown (a replay).
 */
final class PreviewKey {
    private static final String TAG = "PreviewKey";
    private static final String PREFS = "hm_preview_key";
    private static final String PRIVATE = "private";
    private static final String PUBLIC = "public";
    private static final String INFO = "hm-preview-v1";
    private static final int POINT_BYTES = 65;
    private static final int IV_BYTES = 12;
    static final long MAX_AGE_MS = 10 * 60 * 1000;
    static final int MAX_TEXT_CHARS = 200;

    private static KeyPair cached;

    private PreviewKey() { }

    private static SharedPreferences prefs(Context context) throws Exception {
        Context app = context.getApplicationContext();
        MasterKey master = new MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(app, PREFS, master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /** The key pair, created on first use. Null when this phone cannot keep one (previews then stay off). */
    private static synchronized KeyPair pair(Context context) {
        if (cached != null) return cached;
        try {
            SharedPreferences store = prefs(context);
            String savedPrivate = store.getString(PRIVATE, null);
            String savedPublic = store.getString(PUBLIC, null);
            KeyFactory factory = KeyFactory.getInstance("EC");
            if (savedPrivate != null && savedPublic != null) {
                PrivateKey privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(Base64.decode(savedPrivate, Base64.NO_WRAP)));
                PublicKey publicKey = factory.generatePublic(new X509EncodedKeySpec(Base64.decode(savedPublic, Base64.NO_WRAP)));
                cached = new KeyPair(publicKey, privateKey);
                return cached;
            }
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair created = generator.generateKeyPair();
            boolean saved = store.edit()
                .putString(PRIVATE, Base64.encodeToString(created.getPrivate().getEncoded(), Base64.NO_WRAP))
                .putString(PUBLIC, Base64.encodeToString(created.getPublic().getEncoded(), Base64.NO_WRAP))
                .commit();
            if (!saved) return null;
            cached = created;
            return cached;
        } catch (Throwable unavailable) {
            Log.w(TAG, "no preview key on this phone", unavailable);
            return null;
        }
    }

    /** The public key as senders use it: the uncompressed point, base64. Empty when there is none. */
    static String publicKey(Context context) {
        KeyPair own = pair(context);
        return own == null ? "" : Base64.encodeToString(point((ECPublicKey) own.getPublic()), Base64.NO_WRAP);
    }

    private static byte[] point(ECPublicKey key) {
        byte[] out = new byte[POINT_BYTES];
        out[0] = 4;
        copyCoordinate(key.getW().getAffineX(), out, 1);
        copyCoordinate(key.getW().getAffineY(), out, 33);
        return out;
    }

    private static void copyCoordinate(BigInteger value, byte[] out, int offset) {
        byte[] bytes = value.toByteArray(); // big-endian, possibly with a leading zero or shorter than 32
        int length = Math.min(32, bytes.length);
        System.arraycopy(bytes, bytes.length - length, out, offset + 32 - length, length);
    }

    /**
     * Opens a sealed preview from `senderId`. Null when there is none, it is not for this key, it was tampered with,
     * or it is older than MAX_AGE_MS: the caller then notifies as it did before previews.
     */
    static String open(Context context, String sealedBase64, String senderId) {
        if (sealedBase64 == null || sealedBase64.isEmpty() || senderId == null || senderId.isEmpty()) return null;
        KeyPair own = pair(context);
        if (own == null) return null;
        try {
            return open(own, Base64.decode(sealedBase64, Base64.DEFAULT), senderId, System.currentTimeMillis());
        } catch (Throwable unreadable) {
            Log.i(TAG, "preview not opened: " + unreadable.getClass().getSimpleName());
            return null;
        }
    }

    static String open(KeyPair own, byte[] sealed, String senderId, long now) throws Exception {
        if (sealed.length <= POINT_BYTES + IV_BYTES + 16 || sealed[0] != 4) return null;
        byte[] ephemeral = Arrays.copyOfRange(sealed, 0, POINT_BYTES);
        byte[] iv = Arrays.copyOfRange(sealed, POINT_BYTES, POINT_BYTES + IV_BYTES);
        ECPublicKey ownPublic = (ECPublicKey) own.getPublic();
        ECParameterSpec curve = ownPublic.getParams();
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(ephemeral, 1, 33)), new BigInteger(1, Arrays.copyOfRange(ephemeral, 33, 65)));
        PublicKey sender = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, curve));
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(own.getPrivate());
        agreement.doPhase(sender, true);
        byte[] shared = agreement.generateSecret();
        byte[] salt = new byte[POINT_BYTES * 2];
        System.arraycopy(ephemeral, 0, salt, 0, POINT_BYTES);
        System.arraycopy(point(ownPublic), 0, salt, POINT_BYTES, POINT_BYTES);
        byte[] key = hkdf(shared, salt, INFO.getBytes(StandardCharsets.UTF_8));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(senderId.getBytes(StandardCharsets.UTF_8));
        byte[] plain = cipher.doFinal(sealed, POINT_BYTES + IV_BYTES, sealed.length - POINT_BYTES - IV_BYTES);
        JSONObject value = new JSONObject(new String(plain, StandardCharsets.UTF_8));
        String text = value.optString("t", "");
        long at = value.optLong("at", 0);
        if (text.isEmpty() || at <= 0 || Math.abs(now - at) > MAX_AGE_MS) return null;
        return text.length() > MAX_TEXT_CHARS ? text.substring(0, MAX_TEXT_CHARS) : text;
    }

    /** HKDF-SHA-256 (RFC 5869), 32 bytes out. */
    static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info);
        mac.update((byte) 1);
        return mac.doFinal();
    }
}
