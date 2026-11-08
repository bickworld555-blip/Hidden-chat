# Standalone Socket.IO chat events

`events.mjs` is an adapter for a host that already provides Socket.IO and the
`public.messages` table. It does not replace the existing `ws` server or create
that table. The table must supply `id` and `created_at` defaults and accept
`conversation_id`, `sender_id`, `content`, and nullable `attachment_url`.
These columns are different from the existing `relay.messages` schema.

After authenticating a socket in trusted server middleware, set
`socket.data.userId` and `socket.data.authorizeConversation`. The latter must
check current membership for the given user/conversation and return exactly
`true` to permit access. Never copy these values from client event payloads.

```js
import { registerChatEvents } from './events.mjs';
import { getPostgresPool } from './database.mjs';

io.on('connection', (socket) => {
  // Authentication middleware has already populated these server-owned values.
  registerChatEvents(io, socket);
});
```

The host must remove sockets from rooms when membership is revoked. Access is
checked on each join/send, but an already joined recipient otherwise stays in
the room until the host removes it.

Client events:

- `join_conversation`: conversation ID string.
- `send_message`: `{ conversation_id, sender_id, content, attachment_url? }`.
- `receive_message`: the database-returned row, including its ID and timestamp.
- `message_error`: `{ event, message, saved_message_id? }`.

`sender_id` must match the authenticated user. Content is preserved unchanged
and limited to 4,000 characters, following the existing backend limit. An empty
text is allowed with an attachment. No SQL values are interpolated.

The shared pool is initialized lazily from the backend database configuration;
the host owns its lifetime and must call `await getPostgresPool().end()` after
draining handlers during final shutdown. Do not close it per socket or reuse it
after shutdown. It is separate from pools owned by `createChatServer`.

Room broadcasts are not durable delivery acknowledgements. If the insert
succeeds but broadcast throws, `message_error.saved_message_id` identifies the
committed record; refresh history instead of resending. An interrupted database
connection can leave insert completion unknown; use a separate idempotency
contract before enabling automatic message retries.

Tests use mocked host sockets/pool queries. Actual Socket.IO transport,
Supabase permissions, and the external `public.messages` schema are not verified
by those tests.
