// GIF search through GIPHY, proxied: the API key and users' addresses stay on the server's side, only GIPHY's own
// media hosts can be fetched, and nothing works without a signed-in session or a configured key.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { allowedMediaUrl, gifConfigFromEnv, presentGifs } from './gifs.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const GIF_BYTES = Buffer.from('GIF89a-test-bytes');
const giphyItem = (id) => ({
  id, title: `Cat ${id}`,
  images: {
    fixed_width_small: { url: `https://media1.giphy.com/media/${id}/100w.gif`, width: '100', height: '80' },
    downsized: { url: `https://media1.giphy.com/media/${id}/giphy-downsized.gif`, size: '120000' },
  },
});
const asked = [];
async function fakeGiphy(url) {
  const href = String(url);
  asked.push(href);
  if (href.startsWith('https://api.giphy.com/')) return new Response(JSON.stringify({ data: [giphyItem('a1'), giphyItem('b2'), { id: 'bad', images: {} }] }), { headers: { 'Content-Type': 'application/json' } });
  if (href.startsWith('https://media1.giphy.com/')) return new Response(GIF_BYTES, { headers: { 'Content-Type': 'image/gif', 'Content-Length': String(GIF_BYTES.length) } });
  return new Response('no', { status: 404 });
}

let service;
let directory;
let baseUrl;
let off;
let offUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-gifs-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory,
    gifConfig: { apiKey: 'test-key', rating: 'pg-13' }, gifFetch: fakeGiphy });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
  off = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'off.sqlite'), dataDirectory: join(directory, 'off'), gifConfig: null });
  offUrl = `http://127.0.0.1:${(await off.listen()).port}`;
});
after(async () => {
  await service?.close();
  await off?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function session(url) {
  const response = await fetch(`${url}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `gif${Math.random().toString(36).slice(2, 9)}`, dob: '1990-04-12', password: PASSWORD }) });
  return (await response.json()).token;
}
const get = (url, path, token) => fetch(url + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('the key comes from GIPHY_API_KEY; without it GIF search is off', () => {
  assert.equal(gifConfigFromEnv({}), null);
  assert.deepEqual(gifConfigFromEnv({ GIPHY_API_KEY: ' k ' }), { apiKey: 'k', rating: 'pg-13' });
});

test('only GIPHY media hosts pass the proxy', () => {
  assert.ok(allowedMediaUrl('https://media2.giphy.com/media/x/giphy.gif'));
  assert.ok(allowedMediaUrl('https://i.giphy.com/x.gif'));
  assert.equal(allowedMediaUrl('http://media.giphy.com/x.gif'), null);
  assert.equal(allowedMediaUrl('https://giphy.com.evil.example/x.gif'), null);
  assert.equal(allowedMediaUrl('https://user:pw@media.giphy.com/x.gif'), null);
  assert.equal(presentGifs({ data: [{ id: 'x', images: { fixed_width_small: { url: 'https://evil.example/a.gif' }, downsized: { url: 'https://media.giphy.com/a.gif' } } }] }).length, 0);
});

test('search returns pickable GIFs through the server; the key never reaches the app', async () => {
  const token = await session(baseUrl);
  assert.equal((await get(baseUrl, '/api/v1/gifs/search?q=cat')).status, 401, 'signed-in only');
  assert.deepEqual(await (await get(baseUrl, '/api/v1/gifs/status', token)).json(), { enabled: true, provider: 'GIPHY' });
  const response = await get(baseUrl, '/api/v1/gifs/search?q=cat', token);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes('test-key'), false, 'no API key in the answer');
  const body = JSON.parse(text);
  assert.deepEqual(body.gifs.map((gif) => gif.id), ['a1', 'b2'], 'items without usable images are dropped');
  assert.equal(body.attribution, 'Powered by GIPHY');
  const searches = asked.filter((href) => href.startsWith('https://api.giphy.com/v1/gifs/search'));
  assert.equal(searches.length, 1);
  assert.match(searches[0], /api_key=test-key/);
  await get(baseUrl, '/api/v1/gifs/search?q=CAT', token);
  assert.equal(asked.filter((href) => href.startsWith('https://api.giphy.com/v1/gifs/search')).length, 1, 'cached');
  assert.equal((await get(baseUrl, '/api/v1/gifs/search', token)).status, 200, 'an empty search shows trending');
  assert.ok(asked.some((href) => href.startsWith('https://api.giphy.com/v1/gifs/trending')));
});

test('the GIF image comes through the server; other hosts are refused', async () => {
  const token = await session(baseUrl);
  const ok = await get(baseUrl, `/api/v1/gifs/media?u=${encodeURIComponent('https://media1.giphy.com/media/a1/giphy-downsized.gif')}`, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/gif');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), GIF_BYTES);
  assert.equal((await get(baseUrl, `/api/v1/gifs/media?u=${encodeURIComponent('https://example.com/a.gif')}`, token)).status, 400);
});

test('without a key the app is told GIF search is off', async () => {
  const token = await session(offUrl);
  assert.deepEqual(await (await get(offUrl, '/api/v1/gifs/status', token)).json(), { enabled: false, provider: null });
  assert.equal((await get(offUrl, '/api/v1/gifs/search?q=cat', token)).status, 404);
});
