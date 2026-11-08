// Session hand-over to the Android service, in its own file: @capacitor/core caches a registered plugin (and its
// method list) per process, so this needs a fresh module state.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the account reaches the service before it starts (the service stops itself without one)', async () => {
  const calls = [];
  globalThis.androidBridge = { postMessage() {} };
  let releaseSession;
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: (name) => name === 'HiddenNative',
    PluginHeaders: [{ name: 'HiddenNative', methods: ['setSession', 'startBackground', 'takePendingCall'].map((name) => ({ name, rtype: 'promise' })) }],
    nativePromise: (_plugin, method) => {
      calls.push(`${method}:start`);
      if (method === 'setSession') return new Promise((resolve) => { releaseSession = () => { calls.push('setSession:done'); resolve({ saved: true }); }; });
      if (method === 'takePendingCall') return Promise.resolve({ pending: { event: { type: 'call:signal', callId: 'c1' }, ice: [] } });
      return Promise.resolve({});
    },
  };
  const { nativeSetSession, nativeStartBackground, nativeTakePendingCall } = await import('../src/native.js');
  nativeSetSession({ origin: 'https://hiddenmessenger.com', token: 't', userId: 'u' });
  const started = nativeStartBackground();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!calls.includes('startBackground:start'), 'waits for the session hand-over');
  releaseSession();
  await started;
  assert.deepEqual(calls.filter((call) => call !== 'setSession:start'), ['setSession:done', 'startBackground:start']);
  assert.deepEqual(await nativeTakePendingCall(), { event: { type: 'call:signal', callId: 'c1' }, ice: [] });
});

