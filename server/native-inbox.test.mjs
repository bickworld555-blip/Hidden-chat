// importNativeInbox applies what the native background fetch decrypted, in order, skipping malformed entries and
// never throwing on a bad one — so a single corrupt entry cannot lose the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importNativeInbox } from '../src/e2e/client.js';

test('applies each native inbox entry in order and skips malformed ones', async () => {
  const seen = [];
  const entries = [
    JSON.stringify({ event: { type: 'message:new', message: { id: 'm1', senderId: 'a', content: 'e2e2:text|{"v":2,"sd":"d","d":{}}' } }, inner: '{"c":"hi"}' }),
    'not json at all',
    JSON.stringify({ event: { type: 'message:new', message: { id: 'm2', senderId: 'a', content: 'plain, not an envelope' } }, inner: 'ignored' }),
  ];
  const applied = await importNativeInbox(entries, async (event) => { seen.push(event?.message?.id); });
  assert.deepEqual(seen, ['m1', 'm2'], 'both well-formed entries applied, the malformed one skipped');
  assert.equal(applied, 2);
});

test('one entry whose handler throws does not stop the others', async () => {
  const seen = [];
  const entries = [
    JSON.stringify({ event: { type: 'message:new', message: { id: 'ok1', senderId: 'a', content: 'x' } }, inner: 'i' }),
    JSON.stringify({ event: { type: 'message:new', message: { id: 'boom', senderId: 'a', content: 'x' } }, inner: 'i' }),
    JSON.stringify({ event: { type: 'message:new', message: { id: 'ok2', senderId: 'a', content: 'x' } }, inner: 'i' }),
  ];
  const applied = await importNativeInbox(entries, async (event) => {
    if (event?.message?.id === 'boom') throw new Error('handler failed');
    seen.push(event?.message?.id);
  });
  assert.deepEqual(seen, ['ok1', 'ok2']);
  assert.equal(applied, 2);
});
