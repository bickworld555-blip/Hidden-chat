// On-device voice transcripts and the translation lab (Phase 0 and Phase 1):
//   * the language a voice message was spoken in travels inside the end-to-end encrypted message, never in the part
//     the server routes on;
//   * transcripts use only Android's ON-DEVICE recogniser (no createSpeechRecognizer fallback that may use a server)
//     and report a missing language pack instead of guessing;
//   * the translation lab (ML Kit) exists only in debug builds: release APKs carry neither the library nor the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cleanVoiceLang, resolveVoiceLanguage } from '../src/voiceLanguage.js';
import { routingFor } from '../src/e2e/envelope.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const JAVA = 'android/app/src/main/java/io/github/bickworld555/hiddenchat';

test('the sender’s voice language: chosen, or mapped from the phone; anything odd is dropped', () => {
  assert.equal(resolveVoiceLanguage('bn-BD', 'en-GB'), 'bn-BD');
  assert.equal(resolveVoiceLanguage('auto', 'bn'), 'bn-BD');
  assert.equal(resolveVoiceLanguage('auto', 'hi-IN'), 'hi-IN');
  assert.equal(resolveVoiceLanguage('auto', 'ar_EG'), 'ar-SA');
  assert.equal(resolveVoiceLanguage('auto', 'fr-CA'), 'fr-CA', 'other languages keep the phone’s tag');
  assert.equal(resolveVoiceLanguage('auto', ''), 'en-US');
  assert.equal(cleanVoiceLang('bn-BD:evil'), '');
  assert.equal(cleanVoiceLang('<script>'), '');
});

test('the language rides inside the sealed voice message; the server’s routing part never has it', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { parseVoiceContent, voiceContent } = await import('../src/voice.js');
  const descriptor = { key: 'k'.repeat(43), iv: 'i'.repeat(16), name: 'voice.ogg', type: 'audio/ogg', size: 1234 };
  const content = voiceContent('media_1', 7, { descriptor, lang: 'bn-BD' });
  assert.match(content, /:bn-BD$/);
  assert.equal(parseVoiceContent(content).lang, 'bn-BD');
  assert.equal(routingFor(content).includes('bn'), false, 'routing keeps only the attachment id');
  assert.equal(parseVoiceContent(voiceContent('media_1', 7, { descriptor })).lang, undefined, 'older notes have none');
  assert.equal(parseVoiceContent(voiceContent('media_1', 7, { descriptor, lang: 'x:y' })).lang, undefined);
  // Chats and groups both send it; the receiver transcribes in it.
  for (const file of ['src/components/ChatWindow.jsx', 'src/components/GroupsView.jsx']) {
    assert.match(read(file), /voiceContent\([^)]*lang: resolveVoiceLanguage\(appSettings\(\)\.get\('chats\.voiceLanguage'\)\)/, file);
  }
  assert.match(read('src/components/VoiceMessage.jsx'), /transcribe\(id, sessionToken, lang\)/);
  assert.equal(read('src/transcripts.js').includes('navigator.language'), false, 'not the receiver’s language');
});

test('transcripts use only the on-device recogniser and name a missing language pack', () => {
  const java = read(`${JAVA}/VoiceTranscriber.java`);
  const code = java.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(code.includes('createSpeechRecognizer('), false, 'no recogniser that may send audio to a server');
  assert.ok(code.includes('createOnDeviceSpeechRecognizer('));
  assert.match(code, /return SpeechRecognizer\.isOnDeviceRecognitionAvailable\(context\);/);
  for (const outcome of ['language_pack_missing', 'language_pack_downloading', 'language_unsupported', 'on_device_unavailable']) assert.ok(java.includes(outcome), outcome);
  assert.ok(code.includes('triggerModelDownload('), 'the app can ask for the pack');
});

test('the translation lab and ML Kit exist only in debug builds', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /debugImplementation 'com\.google\.mlkit:translate:/);
  assert.equal(/^\s*implementation 'com\.google\.mlkit/m.test(gradle), false, 'never a release dependency');
  assert.match(gradle, /applicationIdSuffix "\.lab"/, 'installs beside the real app');
  assert.ok(existsSync(new URL('../android/app/src/debug/java/io/github/bickworld555/hiddenchat/TranslationLab.java', import.meta.url)));
  assert.equal(existsSync(new URL(`../${JAVA}/TranslationLab.java`, import.meta.url)), false);
  assert.equal(read('android/app/src/main/AndroidManifest.xml').includes('TranslationLab'), false);
  const plugin = read(`${JAVA}/HiddenNativePlugin.java`);
  assert.match(plugin, /public void translateVoice\(PluginCall call\) \{\n\s+if \(\(getContext\(\)\.getApplicationInfo\(\)\.flags & android\.content\.pm\.ApplicationInfo\.FLAG_DEBUGGABLE\) == 0\) \{/);
  const lab = read('android/app/src/debug/java/io/github/bickworld555/hiddenchat/TranslationLab.java');
  assert.ok(lab.includes('isNetworkConnectionRequired()') && lab.includes('KEY_FEATURE_NOT_INSTALLED'), 'offline voices only');
  assert.ok(lab.includes('VoiceTranscriber.recognise('), 'the lab reuses the on-device-only recogniser');
});
