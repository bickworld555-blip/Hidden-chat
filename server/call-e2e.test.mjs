import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';

function waitForEvent(socket, type, filter = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`Timed out waiting for event: ${type}`));
    }, timeoutMs);

    function handler(raw) {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.type === type && filter(payload)) {
          clearTimeout(timer);
          socket.off('message', handler);
          resolve(payload);
        }
      } catch {}
    }

    socket.on('message', handler);
  });
}

test('persistent call flow: ringing does not prematurely timeout and establishes bidirectional connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-call-e2e-'));
  const service = createChatServer({ port: 0, databasePath: join(directory, 'call-e2e.sqlite') });
  const address = await service.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function register(username) {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, dob: '1990-05-15', password: 'Correct-Horse-Battery-42!' }),
    });
    assert.equal(res.status, 201);
    return res.json();
  }

  const caller = await register('alice_persistent');
  const callee = await register('bob_persistent');

  // Add contacts
  await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: callee.user.id }),
  });
  await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${callee.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: caller.user.id }),
  });

  const callerSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [`relay.auth.${caller.token}`, 'relay.v1']);
  const calleeSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [`relay.auth.${callee.token}`, 'relay.v1']);

  await Promise.all([
    new Promise((resolve) => callerSocket.on('open', resolve)),
    new Promise((resolve) => calleeSocket.on('open', resolve)),
  ]);

  const callId = 'test-call-persists';

  // 1. Caller initiates call
  const incomingOfferPromise = waitForEvent(calleeSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'offer');
  const callerRingingPromise = waitForEvent(callerSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'ringing');

  callerSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: callee.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-offer-1',
    signal: { type: 'offer', sdp: 'v=0\r\no=alice 1234 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
  }));

  const incomingOffer = await incomingOfferPromise;
  assert.equal(incomingOffer.from, caller.user.id);
  assert.equal(incomingOffer.mode, 'video');
  assert.equal(incomingOffer.fromUser?.username, 'alice_persistent');

  const callerRinging = await callerRingingPromise;
  assert.equal(callerRinging.signal.type, 'ringing');

  // 2. Persistent ringing check: verify no premature spontaneous abort
  let prematureAbort = false;
  const abortHandler = (raw) => {
    try {
      const p = JSON.parse(raw.toString());
      if (p.type === 'call:signal' && p.signal?.type === 'end') prematureAbort = true;
    } catch {}
  };
  callerSocket.on('message', abortHandler);
  calleeSocket.on('message', abortHandler);

  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(prematureAbort, false, 'Call should not prematurely auto-terminate during ringing');

  callerSocket.off('message', abortHandler);
  calleeSocket.off('message', abortHandler);

  // 3. Callee accepts call: sends answer, connected signal, and ICE
  const callerAnswerPromise = waitForEvent(callerSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'answer');
  const callerConnectedPromise = waitForEvent(callerSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'connected');
  const callerIcePromise = waitForEvent(callerSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'ice');

  calleeSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: caller.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-ans-1',
    signal: { type: 'answer', sdp: 'v=0\r\no=bob 5678 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
  }));

  calleeSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: caller.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-conn-1',
    signal: { type: 'connected' },
  }));

  calleeSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: caller.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-ice-callee-1',
    signal: { type: 'ice', candidate: { candidate: 'candidate:callee1 1 udp 2122260223 127.0.0.1 5000 typ host' } },
  }));

  const receivedAnswer = await callerAnswerPromise;
  assert.equal(receivedAnswer.signal.type, 'answer');
  assert.equal(typeof receivedAnswer.signal.sdp, 'string');

  const receivedConnected = await callerConnectedPromise;
  assert.equal(receivedConnected.signal.type, 'connected');

  const receivedIce = await callerIcePromise;
  assert.equal(receivedIce.signal.type, 'ice');
  assert.ok(receivedIce.signal.candidate);

  // 4. Caller responds with ICE candidate
  const calleeIcePromise = waitForEvent(calleeSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'ice');
  callerSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: callee.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-ice-caller-1',
    signal: { type: 'ice', candidate: { candidate: 'candidate:caller1 1 udp 2122260223 127.0.0.1 5001 typ host' } },
  }));
  const calleeReceivedIce = await calleeIcePromise;
  assert.equal(calleeReceivedIce.signal.type, 'ice');

  // 5. Clean termination
  const callerEndPromise = waitForEvent(callerSocket, 'call:signal', (ev) => ev.callId === callId && ev.signal.type === 'end');
  calleeSocket.send(JSON.stringify({
    type: 'call:signal',
    targetId: caller.user.id,
    callId,
    mode: 'video',
    signalId: 'sig-end-1',
    signal: { type: 'end', reason: 'ended' },
  }));
  const endSignal = await callerEndPromise;
  assert.equal(endSignal.signal.reason, 'ended');

  callerSocket.close();
  calleeSocket.close();
  await service.close();
});
