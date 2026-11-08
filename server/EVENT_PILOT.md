# Event Pilot

`createEventPilot()` in [eventPilot.mjs](eventPilot.mjs) creates an in-process
async dispatcher. No dependencies, environment variables, database tables or
public endpoints are added. It does not replace the existing `ws` protocol or
the separate Socket.IO adapter in `events.mjs`.

## Initialize and register

Every `createChatServer()` instance owns its own `eventPilot`. Register listeners
before calling `listen()` in your server entry point:

```js
import { createChatServer } from './index.mjs';

const service = createChatServer();
service.eventPilot.on('server:listening', async (address) => {
  console.info('Server ready on port:', address.port);
}, { once: true });
service.eventPilot.on('server:stopping', async () => {
  console.info('Server requests drained; finishing background work.');
});
await service.listen();
```

`server:listening` is published after database readiness and the HTTP listener
start. `server:stopping` is published after HTTP, socket handlers and maintenance
drain, but before the database closes. Server shutdown drains accepted Event
Pilot publications before closing its database. A failed lifecycle listener is
reported but does not roll back startup, crash the service or prevent other
listeners from running. Database readiness errors still prevent startup.

You may also use a standalone instance:

```js
import { createEventPilot } from './eventPilot.mjs';

const pilot = createEventPilot();
const unsubscribe = pilot.on('job:completed', async ({ jobId }) => {
  console.info('Completed job:', jobId);
});
const results = await pilot.publish('job:completed', { jobId: 'example' });
if (results.some((result) => result.status === 'rejected')) {
  console.warn('Some event listeners failed; inspect the listener error logs.');
}
unsubscribe();
await pilot.close();
```

## Contract and ownership

- `on(name, listener, { once: false })` registers a sync or async callback and
  returns an idempotent unsubscribe function. Each registration is distinct.
  Registration is synchronous; await any external setup before registering.
- `publish(name, payload)` snapshots listeners in registration order, then
  invokes them concurrently as `(payload, name)`. It returns Promise.allSettled
  results (`fulfilled/value` or `rejected/reason`) in registration order.
  No listeners means an empty results array. Invalid input rejects explicitly.
- Synchronous throws and promise rejections are isolated. Failures log the event
  name, listener index and error code/name, not the payload or error message.
  Detailed reasons remain in the returned internal results; do not forward
  them directly to clients or transport logs.
- Once listeners are removed before callbacks run, including during recursive
  and concurrent publication. Unsubscribing/adding during a publication affects
  only subsequent publications; it does not cancel the current snapshot.
- `close()` immediately rejects new registrations/publications, releases
  registrations and awaits already accepted dispatches. Repeated closes share
  one promise. The server owns its pilot: do not manually close it while the
  server is running.
- Listeners must await all work they start. Detached work is not tracked.
  Do not await `close()` or the owning server's shutdown from a listener:
  shutdown waits for that listener, creating a deadlock.
- Delivery is memory-only and non-durable: there are no retries, persistence,
  global ordering between publications or cross-process broadcasts. It is for
  trusted internal events, not authorization or mandatory database writes.
  Payloads are shared by reference; treat them as read-only. Use bounded work
  and await publishing at the producer; a never-settling listener blocks its
  publication and final shutdown. CPU-blocking code cannot be isolated here.

## Test

From the `chat-app` directory in PowerShell:

```powershell
node --test --test-concurrency=1 server\eventPilot.test.mjs server\index.test.mjs server\postgres.test.mjs
```

Tests cover async dispatch, mixed failures, snapshot/unsubscribe semantics,
recursive/concurrent once delivery, draining and server lifecycle integration.
The PostgreSQL tests use PGlite, not a live Supabase instance.
