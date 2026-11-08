import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventPilot } from './eventPilot.mjs';

test('publishes async listeners concurrently and returns results in registration order', async (t) => {
  const pilot = createEventPilot();
  t.after(() => pilot.close());
  const payload = { id: 'event-a' };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  pilot.on('work', async (received, event) => {
    assert.equal(received, payload);
    assert.equal(event, 'work');
    calls.push('first');
    await gate;
    return 1;
  });
  pilot.on('work', () => {
    calls.push('second');
    release();
    return 2;
  });
  assert.deepEqual(await pilot.publish('work', payload), [
    { status: 'fulfilled', value: 1 },
    { status: 'fulfilled', value: 2 },
  ]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(await pilot.publish('unregistered'), []);
});

test('isolates synchronous throws, rejected promises and non-Error failures', async (t) => {
  const pilot = createEventPilot();
  t.after(() => pilot.close());
  const log = t.mock.method(console, 'error', () => {});
  const failure = new Error('private payload details');
  pilot.on('work', () => { throw failure; });
  pilot.on('work', async () => { throw Object.assign(new Error('database details'), { code: 'XX000' }); });
  pilot.on('work', () => Promise.reject(null));
  pilot.on('work', async () => 'completed');
  const results = await pilot.publish('work');
  assert.deepEqual(results.map((item) => item.status), ['rejected', 'rejected', 'rejected', 'fulfilled']);
  assert.equal(results[0].reason, failure);
  assert.equal(results[3].value, 'completed');
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [
    ['Event Pilot listener failed:', 'work', 0, 'Error'],
    ['Event Pilot listener failed:', 'work', 1, 'XX000'],
    ['Event Pilot listener failed:', 'work', 2, 'UnknownError'],
  ]);
});

test('once registrations are claimed before concurrent and recursive publications', async (t) => {
  const pilot = createEventPilot();
  t.after(() => pilot.close());
  let count = 0;
  pilot.on('work', async () => {
    count += 1;
    await pilot.publish('work');
  }, { once: true });
  const results = await Promise.all([pilot.publish('work'), pilot.publish('work')]);
  assert.equal(count, 1);
  assert.equal(results[0].length, 1);
  assert.equal(results[1].length, 0);
});

test('reports a failed listener before unrelated slow work finishes', async (t) => {
  const pilot = createEventPilot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(async () => { release(); await pilot.close(); });
  let reported;
  const failureReported = new Promise((resolve) => { reported = resolve; });
  t.mock.method(console, 'error', () => reported());
  let finished = false;
  pilot.on('work', () => { throw new Error('failed'); });
  pilot.on('work', async () => { await gate; finished = true; });
  const publication = pilot.publish('work');
  await failureReported;
  assert.equal(finished, false);
  release();
  await publication;
  assert.equal(finished, true);
});

test('listener changes affect future publications and unsubscribe is idempotent', async (t) => {
  const pilot = createEventPilot();
  t.after(() => pilot.close());
  const calls = [];
  const listener = () => calls.push('second');
  let unsubscribe;
  pilot.on('work', () => {
    calls.push('first');
    unsubscribe();
    pilot.on('work', () => calls.push('new'), { once: true });
  });
  unsubscribe = pilot.on('work', listener);
  await pilot.publish('work');
  assert.deepEqual(calls, ['first', 'second']);
  unsubscribe();
  await pilot.publish('work');
  assert.deepEqual(calls, ['first', 'second', 'first', 'new']);
});

test('close rejects new work, drains mixed pending listeners and is idempotent', async (t) => {
  const pilot = createEventPilot();
  t.mock.method(console, 'error', () => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pilot.on('work', async () => { await gate; return 'done'; });
  pilot.on('work', async () => { await gate; throw new Error('failed'); });
  const publication = pilot.publish('work');
  let drained = false;
  const closing = pilot.close();
  closing.then(() => { drained = true; });
  assert.equal(pilot.close(), closing);
  assert.throws(() => pilot.on('work', () => {}), /closed/);
  await assert.rejects(pilot.publish('work'), /closed/);
  assert.equal(drained, false);
  release();
  assert.deepEqual((await publication).map((result) => result.status), ['fulfilled', 'rejected']);
  await closing;
  assert.equal(drained, true);
});

test('validates event names, listener functions and once options', async (t) => {
  const pilot = createEventPilot();
  t.after(() => pilot.close());
  for (const event of [null, '', '   ', 42]) {
    assert.throws(() => pilot.on(event, () => {}), /nonempty string/);
    await assert.rejects(pilot.publish(event), /nonempty string/);
  }
  assert.throws(() => pilot.on('work', null), /must be a function/);
  assert.throws(() => pilot.on('work', () => {}, { once: 'true' }), /must be a boolean/);
});
