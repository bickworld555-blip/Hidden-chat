import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFetch, apiUrl, normalizeApiBaseUrl, websocketUrl } from '../src/api.js';

test('API base URL preserves same-origin defaults and validates explicit origins', () => {
  assert.equal(normalizeApiBaseUrl(), '');
  assert.equal(normalizeApiBaseUrl(' https://backend.ngrok-free.app/ '), 'https://backend.ngrok-free.app');
  assert.equal(apiUrl('/api/v1/me'), '/api/v1/me');
  assert.equal(apiUrl('/api/v1/media/a?dl=token', 'https://backend.ngrok-free.app'), 'https://backend.ngrok-free.app/api/v1/media/a?dl=token');
  for (const input of ['ws://backend.example', 'https://backend.example/api', 'https://backend.example/?token=x', 'https://backend.example/#hash', 'https://user:password@backend.example', 'not a URL']) {
    assert.throws(() => normalizeApiBaseUrl(input));
  }
  assert.throws(() => apiUrl('//attacker.example/api'), /API path/);
  assert.throws(() => apiUrl('https://attacker.example/api'), /API path/);
});

test('WebSocket origin follows the configured backend or the current frontend', () => {
  assert.equal(websocketUrl('', 'http://localhost:5190/chat'), 'ws://localhost:5190/ws');
  assert.equal(websocketUrl('', 'https://frontend.ngrok-free.app/chat'), 'wss://frontend.ngrok-free.app/ws');
  assert.equal(websocketUrl('https://backend.ngrok-free.app', 'https://frontend.ngrok-free.app'), 'wss://backend.ngrok-free.app/ws');
  assert.throws(() => websocketUrl('', 'file:///app.html'), /HTTP/);
});

test('Ngrok API fetch bypasses the interstitial without losing auth, body or cancellation', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://frontend.ngrok-free.app/', protocol: 'https:', hostname: 'frontend.ngrok-free.app' } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete globalThis.location;
  });
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const controller = new AbortController();
  const options = { method: 'PUT', headers: { Authorization: 'Bearer test-token', 'X-Upload-Offset': '8' }, body: 'chunk', signal: controller.signal };
  await apiFetch('/api/v1/uploads/upload-a', options);
  const [url, request] = mock.mock.calls[0].arguments;
  assert.equal(url, '/api/v1/uploads/upload-a');
  assert.equal(request.headers.get('ngrok-skip-browser-warning'), 'true');
  assert.equal(request.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(request.headers.get('X-Upload-Offset'), '8');
  assert.equal(request.body, options.body);
  assert.equal(request.signal, options.signal);
  assert.deepEqual(options.headers, { Authorization: 'Bearer test-token', 'X-Upload-Offset': '8' });
});
