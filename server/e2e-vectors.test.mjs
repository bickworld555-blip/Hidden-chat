// Test vectors for the end-to-end primitives and every KDF step (docs/security/ENCRYPTION-AUDIT.md §3, §6).
//
// 1. Published standards vectors: RFC 5869 (HKDF-SHA-256), RFC 5903 §8.1 (P-256 ECDH), RFC 6979 A.2.5 (ECDSA P-256
//    SHA-256 verification). They show the Web Crypto calls compute the standard algorithms.
// 2. Protocol vectors: fixed inputs → fixed outputs for X3DH, the root and chain KDFs, the message cipher and the
//    Sender Keys step. Each output is checked twice: against the hex below (a wire-format regression) and against an
//    independent implementation of the documented formula with node:crypto (not Web Crypto), so a reviewer can
//    recompute every value from the brief alone.
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import { test } from 'node:test';
import { dh, fromBase64, hkdf, hkdfWithKeySalt, hmac, hmacKey, messageCipher, aeadEncrypt, toBase64, verify, sign, generateSigningPair, SIGNATURE_BYTES } from '../src/e2e/primitives.js';
import { deriveSharedSecret, kdfChain, kdfRoot, KDF_INFO } from '../src/e2e/ratchet.js';
import { acceptDistribution, senderKeyDecrypt } from '../src/e2e/senderKeys.js';

const hex = (text) => Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const bytesOf = (byte, length) => new Uint8Array(length).fill(byte);
const nodeHkdf = (ikm, salt, info, length) => new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
const nodeHmac = (key, data) => new Uint8Array(createHmac('sha256', key).update(data).digest());

test('RFC 5869 test case 3: HKDF-SHA-256 with empty salt and info', async () => {
  const okm = await hkdf(bytesOf(0x0b, 22), new Uint8Array(0), '', 42);
  assert.equal(toHex(okm), '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
});

test('HKDF with a key salt (the root KDF) is RFC 5869 HKDF with that salt', async () => {
  const salt = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const ikm = hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
  const okm = await hkdfWithKeySalt(await hmacKey(salt.slice()), ikm, KDF_INFO.root, 64);
  assert.equal(toHex(okm), toHex(nodeHkdf(ikm, salt, KDF_INFO.root, 64)));
});

test('RFC 5903 §8.1: P-256 ECDH', async () => {
  const i = hex('C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433');
  const gix = hex('DAD0B65394221CF9B051E1FECA5787D098DFE637FC90B9EF945D0C3772581180');
  const giy = hex('5271A0461CDB8252D61F1C456FA3E59AB1F45B33ACCF5F58389E0577B8990BB3');
  const grx = hex('D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63');
  const gry = hex('56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB');
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64url(i), x: b64url(gix), y: b64url(giy), ext: false }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = await dh(privateKey, new Uint8Array([4, ...grx, ...gry]));
  assert.equal(toHex(shared).toUpperCase(), 'D6840F6B42F6EDAFD13116E0E12565202FEF8E9ECE7DCE03812464D04B9442DE');
});

test('RFC 6979 A.2.5: an ECDSA P-256/SHA-256 signature verifies; a changed one does not', async () => {
  const publicKey = new Uint8Array([4, ...hex('60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6'), ...hex('7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299')]);
  const signature = new Uint8Array([...hex('EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716'), ...hex('F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8')]);
  const message = new TextEncoder().encode('sample');
  assert.equal(await verify(publicKey, signature, message), true);
  const flipped = signature.slice(); flipped[10] ^= 1;
  assert.equal(await verify(publicKey, flipped, message), false);
  assert.equal(await verify(publicKey, signature.slice(0, 63), message), false, 'only 64-byte r ‖ s signatures');
  const own = await generateSigningPair();
  assert.equal((await sign(own.privateKey, message)).length, SIGNATURE_BYTES);
});

test('X3DH: SK = HKDF(0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 ‖ DH4, salt 0×32, info, 32)', async () => {
  const parts = [bytesOf(0x11, 32), bytesOf(0x22, 32), bytesOf(0x33, 32), bytesOf(0x44, 32)];
  const expected = nodeHkdf(new Uint8Array([...bytesOf(0xff, 32), ...parts.flatMap((part) => [...part])]), new Uint8Array(32), KDF_INFO.x3dh, 32);
  const secret = await deriveSharedSecret(parts.map((part) => part.slice()));
  assert.equal(toHex(secret), toHex(expected));
  assert.equal(toHex(secret), X3DH_VECTOR);
  // Without a one-time prekey: three DH outputs.
  const three = await deriveSharedSecret(parts.slice(0, 3).map((part) => part.slice()));
  assert.equal(toHex(three), toHex(nodeHkdf(new Uint8Array([...bytesOf(0xff, 32), ...parts.slice(0, 3).flatMap((part) => [...part])]), new Uint8Array(32), KDF_INFO.x3dh, 32)));
});

test('Double Ratchet: root KDF, chain KDF and message cipher', async () => {
  const rootBytes = bytesOf(0x5a, 32);
  const dhOutput = bytesOf(0xa5, 32);
  // Root KDF: okm = HKDF(salt = root key, ikm = DH output, root info, 64) → next root ‖ chain key.
  const okm = nodeHkdf(dhOutput, rootBytes, KDF_INFO.root, 64);
  const [nextRoot, chain] = await kdfRoot(await hmacKey(rootBytes.slice()), dhOutput.slice());
  // The keys are non-extractable: check them by what they compute.
  assert.equal(toHex(await hmac(nextRoot, new Uint8Array([9]))), toHex(nodeHmac(okm.slice(0, 32), new Uint8Array([9]))));
  // Chain KDF: message key = HMAC(ck, 0x01), next chain key = HMAC(ck, 0x02).
  const [nextChain, messageKey] = await kdfChain(chain);
  const chainBytes = okm.slice(32, 64);
  assert.equal(toHex(messageKey), toHex(nodeHmac(chainBytes, new Uint8Array([1]))));
  assert.equal(toHex(messageKey), CHAIN_MESSAGE_KEY_VECTOR);
  const [, secondMessageKey] = await kdfChain(nextChain);
  assert.equal(toHex(secondMessageKey), toHex(nodeHmac(nodeHmac(chainBytes, new Uint8Array([2])), new Uint8Array([1]))));
  // Message cipher: HKDF(message key, salt 0×32, message info, 44) → AES-256-GCM key (32) ‖ nonce (12).
  const cipherOkm = nodeHkdf(messageKey, new Uint8Array(32), KDF_INFO.message, 44);
  const cipher = await messageCipher(messageKey.slice(), KDF_INFO.message);
  assert.equal(toHex(cipher.iv), toHex(cipherOkm.slice(32)));
  const plaintext = new TextEncoder().encode('hello'); const ad = bytesOf(7, 3);
  const nodeCipher = createCipheriv('aes-256-gcm', cipherOkm.slice(0, 32), cipherOkm.slice(32)); nodeCipher.setAAD(ad);
  const expected = Buffer.concat([nodeCipher.update(plaintext), nodeCipher.final(), nodeCipher.getAuthTag()]);
  assert.equal(toHex(await aeadEncrypt(cipher, plaintext, ad)), expected.toString('hex'));
  assert.equal(expected.toString('hex'), MESSAGE_CIPHERTEXT_VECTOR);
});

test('Sender Keys: the chain steps like the Double Ratchet chain; ids and counters are refused when malformed', async () => {
  const groupId = 'g1';
  const signing = await generateSigningPair();
  const distribution = { type: 'skdm', g: groupId, kid: 'AAAAAAAAAAAAAAAA', ck: toBase64(bytesOf(0x42, 32)), sp: toBase64(signing.publicKey) };
  const state = await acceptDistribution(distribution, groupId);
  const [, messageKey] = await kdfChain(state.chain);
  assert.equal(toHex(messageKey), toHex(nodeHmac(bytesOf(0x42, 32), new Uint8Array([1]))));
  await assert.rejects(acceptDistribution({ ...distribution, kid: 'x'.repeat(5000) }, groupId), /Invalid sender key distribution/);
  await assert.rejects(senderKeyDecrypt(state, 'u/d', { kid: distribution.kid, n: 1e300, c: '', s: '' }), /Invalid group message/, 'counters must be safe integers');
});

test('base64 on the wire is canonical: one encoding per byte string', () => {
  assert.deepEqual([...fromBase64('QQ==')], [65]);
  for (const lenient of ['QR==', 'QQ', 'QQ=', 'Q Q==', 'QQ==\n', '-_8=']) assert.throws(() => fromBase64(lenient), /Invalid base64/, lenient);
});

// Fixed outputs for the inputs above (regenerate only for a deliberate wire-format change).
const X3DH_VECTOR = '39934e9a506e8b51bdaeedf8b0dc32ae89c89dba70bb325c068ddb615da4a3e8';
const CHAIN_MESSAGE_KEY_VECTOR = 'd1b99508a3195e4333f4cb98dd02836650a684c1e291ad6c559af8a08880b00f';
const MESSAGE_CIPHERTEXT_VECTOR = '1e0f6d3b8dfb41bc4efcd424cee4597cbd7be7a925';
