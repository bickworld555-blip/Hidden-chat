import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getPostgresPool } from './database.mjs';
import { registerChatEvents } from './events.mjs';

let pool;
before(() => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://localhost/events-test';
  try { pool = getPostgresPool(); } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
after(async () => { await pool.end(); });

function host(t, { userId = 'user-a', allowed = true, connected = true } = {}) {
  const handlers = new Map();
  const emissions = [];
  const rooms = [];
  const broadcasts = [];
  const checks = [];
  const socket = {
    id: 'socket-a',
    connected,
    data: {
      userId,
      async authorizeConversation(user, conversation) {
        checks.push([user, conversation]);
        return allowed;
      },
    },
    on(event, handler) { handlers.set(event, handler); },
    emit(event, payload) { emissions.push({ event, payload }); },
    async join(room) { rooms.push(room); },
  };
  const io = {
    to(room) {
      return { emit(event, payload) { broadcasts.push({ room, event, payload }); } };
    },
  };
  t.mock.method(console, 'error', () => {});
  registerChatEvents(io, socket);
  return { socket, io, handlers, emissions, rooms, broadcasts, checks };
}

test('authorized joins use the requested conversation room', async (t) => {
  const h = host(t);
  await h.handlers.get('join_conversation')('conversation-a');
  assert.deepEqual(h.rooms, ['conversation-a']);
  assert.deepEqual(h.checks, [['user-a', 'conversation-a']]);
});

test('messages use positional parameters and broadcast exactly the saved row', async (t) => {
  const h = host(t);
  const saved = { id: 'message-a', conversation_id: 'conversation-a', sender_id: 'user-a', content: " exact ' ? ", attachment_url: 'https://example.com/file', created_at: '2026-11-07T00:00:00Z' };
  let query;
  t.mock.method(pool, 'query', async (text, values) => {
    query = { text, values };
    return { rows: [saved] };
  });
  await h.handlers.get('send_message')({ ...saved });
  assert.match(query.text, /INSERT INTO public\.messages/);
  assert.match(query.text, /VALUES \(\$1, \$2, \$3, \$4\)/);
  assert.match(query.text, /RETURNING id, conversation_id, sender_id, content, attachment_url, created_at/);
  assert.deepEqual(query.values, ['conversation-a', 'user-a', saved.content, saved.attachment_url]);
  assert.deepEqual(h.broadcasts, [{ room: 'conversation-a', event: 'receive_message', payload: saved }]);
  assert.equal(h.emissions.length, 0);
});

test('unauthenticated, unauthorized, spoofed and malformed events never query the database', async (t) => {
  const query = t.mock.method(pool, 'query', async () => assert.fail('Unexpected query'));
  const payload = { conversation_id: 'conversation-a', sender_id: 'user-a', content: 'Hello' };
  for (const options of [{ userId: null }, { allowed: false }, { connected: false }]) {
    const h = host(t, options);
    await h.handlers.get('join_conversation')('conversation-a');
    await h.handlers.get('send_message')(payload);
    assert.equal(h.rooms.length, 0);
    assert.equal(h.emissions.length, 2);
  }
  const h = host(t);
  for (const input of [null, [], {}, { ...payload, sender_id: 'someone-else' }, { ...payload, content: '' }, { ...payload, content: 'x'.repeat(4001) }, { ...payload, attachment_url: {} }]) {
    await h.handlers.get('send_message')(input);
  }
  delete h.socket.data.authorizeConversation;
  await h.handlers.get('join_conversation')('conversation-a');
  assert.equal(query.mock.callCount(), 0);
  assert.ok(h.emissions.every((item) => item.event === 'message_error'));
});

test('missing attachments are stored as null and attachment-only messages are accepted', async (t) => {
  const h = host(t);
  const queries = [];
  t.mock.method(pool, 'query', async (_sql, values) => {
    queries.push(values);
    return { rows: [{ id: 'message-a' }] };
  });
  await h.handlers.get('send_message')({ conversation_id: 'c', sender_id: 'user-a', content: 'Hello' });
  await h.handlers.get('send_message')({ conversation_id: 'c', sender_id: 'user-a', content: '', attachment_url: 'https://example.com/file' });
  assert.equal(queries[0][3], null);
  assert.equal(queries.length, 2);
});

test('database and room failures emit errors without exposing database details', async (t) => {
  const h = host(t);
  t.mock.method(pool, 'query', async () => { throw Object.assign(new Error('private database details'), { code: 'XX000' }); });
  await h.handlers.get('send_message')({ conversation_id: 'c', sender_id: 'user-a', content: 'Hello' });
  assert.equal(h.broadcasts.length, 0);
  assert.equal(h.emissions[0].event, 'message_error');
  assert.ok(!h.emissions[0].payload.message.includes('private'));
  h.socket.join = async () => { throw new Error('Room failed'); };
  await h.handlers.get('join_conversation')('c');
  assert.equal(h.emissions[1].payload.event, 'join_conversation');
});

test('failed broadcasting reports a committed message so the client does not resend', async (t) => {
  const h = host(t);
  t.mock.method(pool, 'query', async () => ({ rows: [{ id: 'saved-id' }] }));
  h.io.to = () => { throw new Error('Socket failure'); };
  await h.handlers.get('send_message')({ conversation_id: 'c', sender_id: 'user-a', content: 'Hello' });
  assert.equal(h.emissions[0].payload.saved_message_id, 'saved-id');
});

test('disconnect logs the socket identity and reason', (t) => {
  const h = host(t);
  const log = t.mock.method(console, 'info', () => {});
  h.handlers.get('disconnect')('transport close');
  assert.deepEqual(log.mock.calls[0].arguments, ['Chat socket disconnected:', 'socket-a', 'transport close']);
});
