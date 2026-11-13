// On-device voice transcripts and voice message translation:
//   * the language a voice message was spoken in travels inside the end-to-end encrypted message, never in the part
//     the server routes on;
//   * transcripts use only Android's ON-DEVICE recogniser (no createSpeechRecognizer fallback that may use a server)
//     and report a missing language pack instead of guessing;
//   * whisper.cpp (pinned, model checked) covers languages without an Android pack; translation and speech run on the
//     phone with no network step; the measurement lab exists only in debug builds.
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

test('the measurement lab exists only in debug builds; translation and speech ship in the app', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /^\s*implementation 'com\.google\.mlkit:translate:/m, 'ML Kit on-device translation ships');
  assert.match(gradle, /applicationIdSuffix "\.lab"/, 'the lab installs beside the real app');
  assert.ok(existsSync(new URL('../android/app/src/debug/java/io/github/bickworld555/hiddenchat/TranslationLab.java', import.meta.url)));
  assert.equal(existsSync(new URL(`../${JAVA}/TranslationLab.java`, import.meta.url)), false);
  assert.equal(read('android/app/src/main/AndroidManifest.xml').includes('TranslationLab'), false);
  const plugin = read(`${JAVA}/HiddenNativePlugin.java`);
  assert.match(plugin, /public void translationLab\(PluginCall call\) \{\r?\n\s+if \(\(getContext\(\)\.getApplicationInfo\(\)\.flags & android\.content\.pm\.ApplicationInfo\.FLAG_DEBUGGABLE\) == 0\) \{/);
  const lab = read('android/app/src/debug/java/io/github/bickworld555/hiddenchat/TranslationLab.java');
  assert.ok(lab.includes('VoiceTranscriber.recognise(') && lab.includes('VoiceTranslator.translate(') && lab.includes('VoiceSpeaker.offlineVoice('), 'the lab measures the shipped code');
});

test('whisper.cpp is pinned and its model checked; Bangla falls back to it, never to a server', () => {
  const cmake = read('android/app/src/main/cpp/CMakeLists.txt');
  assert.match(cmake, /URL https:\/\/github\.com\/ggml-org\/whisper\.cpp\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz/);
  assert.match(cmake, /URL_HASH SHA256=[0-9a-f]{64}/, 'the source archive is pinned by hash');
  const models = read(`${JAVA}/WhisperModels.java`);
  assert.match(models, /static final String SHA256 = "[0-9a-f]{64}";/);
  assert.ok(models.includes('digest.digest()') && models.includes('part.delete()'), 'a download that fails the checksum is deleted');
  const transcriber = read(`${JAVA}/VoiceTranscriber.java`);
  assert.ok(transcriber.includes('WhisperEngine.transcribe(') && transcriber.includes('speech_model_missing'));
  const jni = read('android/app/src/main/cpp/hm_whisper.cpp').replace(/\/\/.*$/gm, '');
  assert.equal(/curl|http|socket/i.test(jni), false, 'the native bridge has no network code');
  assert.match(read('android/app/build.gradle'), /abiFilters 'arm64-v8a'/);
});

test('translations never download by themselves, and speech uses offline voices only', () => {
  const translator = read(`${JAVA}/VoiceTranslator.java`);
  const translate = translator.slice(translator.indexOf('static void translate('), translator.indexOf('static void download('));
  assert.equal(/\.download\(|downloadModel/.test(translate), false, 'translating never downloads a model');
  assert.ok(translate.includes('MODEL_MISSING'));
  const speaker = read(`${JAVA}/VoiceSpeaker.java`);
  assert.ok(speaker.includes('isNetworkConnectionRequired()') && speaker.includes('KEY_FEATURE_NOT_INSTALLED') && speaker.includes('ACTION_INSTALL_TTS_DATA'));
});

test('“Play in …” appears only for another language, when turned on, and keeps results on the phone', async () => {
  const { needsTranslation, missingFor } = await import('../src/voiceTranslation.js');
  assert.equal(needsTranslation('bn-BD', 'hi-IN'), true);
  assert.equal(needsTranslation('bn-BD', 'bn-IN'), false, 'same language, different country');
  assert.equal(needsTranslation('', 'hi-IN'), false, 'older notes without a language');
  const status = { languages: { 'hi-IN': { speech: 'whisper', translation: true, voice: '' }, 'bn-BD': { speech: 'whisper-download', translation: false, voice: 'bn' } } };
  assert.deepEqual(missingFor(status, 'hi-IN'), ['voice']);
  assert.deepEqual(missingFor(status, 'bn-BD'), ['speech:whisper-download', 'translation']);
  const code = read('src/voiceTranslation.js');
  assert.ok(code.includes('secureSet(KEY') && !/apiFetch|fetch\(/.test(code), 'kept encrypted on the phone; no network calls');
  assert.match(read('src/components/VoiceMessage.jsx'), /translateOn && nativeShell\(\) && id && needsTranslation\(lang, translateTo\)/);
});
