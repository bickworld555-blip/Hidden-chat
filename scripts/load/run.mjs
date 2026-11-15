// Load test for the realtime server: many persistent sockets, message bursts and call signaling, through the same
// REST and WebSocket protocol the app uses. Reports latency percentiles, failures, and (for the local server) the
// server process's CPU time and memory. See docs/LOAD_TESTING.md.
//
//   npm run load -- --users 1000 --duration 60 --rate 6 --calls 100
//
// By default it starts its own server (scripts/load/server.mjs, SQLite in a temp folder). --target points it at another
// server; anything but localhost also needs --allow-remote and --accounts (sign-ups are rate limited per address).
// It never targets production unless --i-understand-this-is-production is given as well.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export const PRODUCTION_HOSTS = ['hiddenmessenger.com', 'www.hiddenmessenger.com', 'chat.hiddenmessenger.com'];
const PASSWORD = 'Load-Test-Battery-42!';

export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: {
    target: { type: 'string' }, users: { type: 'string', default: '200' }, duration: { type: 'string', default: '30' },
    ramp: { type: 'string', default: '10' }, rate: { type: 'string', default: '6' }, calls: { type: 'string', default: '20' },
    accounts: { type: 'string' }, 'save-accounts': { type: 'string' }, out: { type: 'string' },
    'signup-concurrency': { type: 'string', default: '8' },
    'allow-remote': { type: 'boolean', default: false }, 'i-understand-this-is-production': { type: 'boolean', default: false },
  } });
  const number = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`--${name} must be a number from ${min} to ${max}.`);
    return value;
  };
  const options = {
    target: values.target ?? null, users: number('users', 2, 50_000), duration: number('duration', 1, 3600), ramp: number('ramp', 0, 600),
    rate: number('rate', 0, 600), calls: number('calls', 0, 25_000), signupConcurrency: number('signup-concurrency', 1, 64),
    accounts: values.accounts ?? null, saveAccounts: values['save-accounts'] ?? null, out: values.out ?? null,
  };
  if (options.calls * 2 > options.users) throw new Error('--calls needs two users per call (at most users / 2).');
  if (options.target) {
    const host = new URL(options.target).hostname;
    const local = host === 'localhost' || host === '::1' || host.startsWith('127.');
    if (!local && !values['allow-remote']) throw new Error(`${host} is not this machine: add --allow-remote to load it.`);
    if (!local && !options.accounts) throw new Error('A remote server rate-limits sign-ups: pass --accounts with existing test accounts.');
    if (PRODUCTION_HOSTS.includes(host) && !values['i-understand-this-is-production']) {
      throw new Error('Refusing to load production. Use a staging server, or add --i-understand-this-is-production after agreeing a window.');
    }
  }
  return options;
}

/** p50/p95/p99/max of a list of milliseconds. */
export function percentiles(samples) {
  if (!samples.length) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

async function startLocalServer() {
  const child = fork(fileURLToPath(new URL('./server.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const stats = { first: null, last: null };
  const port = await new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.type === 'ready') resolve(message.port);
      if (message?.type === 'stats') { stats.first ??= message; stats.last = message; }
    });
    child.once('exit', (code) => reject(new Error(`The load server exited (${code}).`)));
  });
  return {
    url: `http://127.0.0.1:${port}`, stats,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.send({ type: 'stop' }); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); }),
  };
}

async function api(base, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { 'X-HM-Client': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await response.json(); } catch { /* empty */ }
  return { status: response.status, data };
}

async function pool(items, concurrency, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }));
  return results;
}

async function signUp(base, count, concurrency) {
  const run = randomUUID().slice(0, 6);
  const accounts = await pool(Array.from({ length: count }, (_, index) => index), concurrency, async (index) => {
    const response = await api(base, '/api/v1/auth/register', { method: 'POST', body: { username: `load${run}${index}`, dob: '1990-01-01', password: PASSWORD } });
    if (response.status !== 201) throw new Error(`Sign-up ${index} failed (${response.status}: ${response.data?.error ?? 'no body'}).`);
    return { id: response.data.user.id, token: response.data.token };
  });
  return accounts;
}

function connect(base, account, metrics, onEvent) {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, [`relay.auth.${account.token}`, 'relay.v1', 'relay.client.2']);
    let ready = false;
    let settled = false;
    // Each socket counts once: an error is followed by a close, and a timeout by both.
    const fail = () => { if (settled) return; settled = true; metrics.connectFailures += 1; resolve(null); };
    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (!ready && !settled && event.type === 'connection:ready') { ready = true; settled = true; metrics.connect.push(performance.now() - started); resolve(socket); }
      onEvent(event);
    });
    socket.on('error', () => { if (!ready) fail(); });
    socket.on('close', () => { if (ready) metrics.drops += 1; else fail(); });
    setTimeout(() => { if (!ready) { fail(); socket.terminate(); } }, 15_000).unref();
  });
}

export async function runLoad(options, { log = console.log } = {}) {
  const local = options.target ? null : await startLocalServer();
  const base = options.target ?? local.url;
  const metrics = { connect: [], ack: [], delivery: [], burstAck: [], burstIds: new Set(), callSetup: [], connectFailures: 0, drops: 0, sendFailures: 0, errors: {}, sent: 0, delivered: 0, callsFailed: 0 };
  const pendingAcks = new Map();
  const pendingDeliveries = new Map();
  const pendingCalls = new Map();
  const sockets = [];
  try {
    log(`target ${base} · ${options.users} users · ramp ${options.ramp}s · ${options.duration}s · ${options.rate} msg/user/min · ${options.calls} calls`);
    const accounts = options.accounts ? JSON.parse(readFileSync(options.accounts, 'utf8')).slice(0, options.users) : await signUp(base, options.users, options.signupConcurrency);
    if (accounts.length < options.users) throw new Error(`Only ${accounts.length} accounts available.`);
    if (options.saveAccounts) writeFileSync(options.saveAccounts, JSON.stringify(accounts));

    const handle = (index) => (event) => {
      const now = performance.now();
      if (event.type === 'message:ack' && pendingAcks.has(event.message?.id)) {
        (metrics.burstIds.has(event.message.id) ? metrics.burstAck : metrics.ack).push(now - pendingAcks.get(event.message.id));
        pendingAcks.delete(event.message.id);
      }
      if (event.type === 'message:new' && pendingDeliveries.has(event.message?.id)) {
        if (!metrics.burstIds.has(event.message.id)) metrics.delivery.push(now - pendingDeliveries.get(event.message.id));
        pendingDeliveries.delete(event.message.id); metrics.delivered += 1;
      }
      if (event.type === 'error') metrics.errors[event.code ?? event.message ?? 'error'] = (metrics.errors[event.code ?? event.message ?? 'error'] ?? 0) + 1;
      if (event.type === 'call:signal' && event.signal?.type === 'offer') {
        // The callee answers at once (opaque SDP: the server relays it without parsing).
        sockets[index]?.send(JSON.stringify({ type: 'call:signal', targetId: event.from, callId: event.callId, mode: 'audio', signalId: randomUUID(), signal: { type: 'answer', sdp: 'v=0 load' } }));
      }
      if (event.type === 'call:signal' && event.signal?.type === 'answer' && pendingCalls.has(event.callId)) {
        metrics.callSetup.push(now - pendingCalls.get(event.callId)); pendingCalls.delete(event.callId);
        sockets[index]?.send(JSON.stringify({ type: 'call:signal', targetId: event.from, callId: event.callId, mode: 'audio', signalId: randomUUID(), signal: { type: 'end' } }));
      }
    };

    const baseline = local?.stats.last ?? null;
    const phaseStart = performance.now();
    // Ramp: spread the connections evenly over --ramp seconds.
    const gap = options.users > 1 ? (options.ramp * 1000) / options.users : 0;
    const opening = [];
    for (let index = 0; index < accounts.length; index += 1) {
      opening.push(connect(base, accounts[index], metrics, handle(index)).then((socket) => { sockets[index] = socket; }));
      if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
    }
    await Promise.all(opening);
    log(`connected ${sockets.filter(Boolean).length}/${accounts.length}`);
    const keepAlive = setInterval(() => { for (const socket of sockets) if (socket?.readyState === 1) socket.send('{"type":"client:ping"}'); }, 20_000);

    // Pairs: user 2k talks to 2k+1. One first message links them (calls need a link), then the steady rate.
    const peerOf = (index) => (index % 2 === 0 ? index + 1 : index - 1);
    const send = (index, { burst = false } = {}) => {
      const socket = sockets[index]; const peer = accounts[peerOf(index)];
      if (!socket || socket.readyState !== 1 || !peer) { metrics.sendFailures += 1; return; }
      const id = randomUUID(); const at = performance.now();
      pendingAcks.set(id, at); pendingDeliveries.set(id, at); metrics.sent += 1;
      if (burst) metrics.burstIds.add(id);
      socket.send(JSON.stringify({ type: 'message:send', message: { id, receiverId: peer.id, content: `load ${id.slice(0, 8)}` } }));
    };
    // The first messages all leave at once (users / 2 of them): reported apart as a burst, which then drains.
    for (let index = 0; index < accounts.length; index += 2) send(index, { burst: true });
    for (let waited = 0; waited < 30_000 && metrics.burstAck.length < metrics.burstIds.size; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));

    const end = Date.now() + options.duration * 1000;
    const perSecond = (options.users * options.rate) / 60;
    let carry = 0;
    const sender = setInterval(() => {
      carry += perSecond / 10;
      for (; carry >= 1; carry -= 1) send(Math.floor(Math.random() * accounts.length));
    }, 100);
    // Calls: spread over the first half of the run; each caller is an even user, its peer the callee.
    const callers = Array.from({ length: options.calls }, (_, call) => call * 2);
    const callGap = options.calls ? (options.duration * 500) / options.calls : 0;
    const calling = (async () => {
      for (const index of callers) {
        const socket = sockets[index];
        if (socket?.readyState === 1) {
          const callId = randomUUID();
          pendingCalls.set(callId, performance.now());
          socket.send(JSON.stringify({ type: 'call:signal', targetId: accounts[peerOf(index)].id, callId, mode: 'audio', signalId: randomUUID(), signal: { type: 'offer', sdp: 'v=0 load' } }));
        } else metrics.callsFailed += 1;
        await new Promise((resolve) => setTimeout(resolve, callGap));
      }
    })();
    while (Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 500));
    clearInterval(sender);
    await calling;
    await new Promise((resolve) => setTimeout(resolve, 3000)); // let in-flight messages land
    clearInterval(keepAlive);
    metrics.callsFailed += pendingCalls.size;

    const server = local?.stats.last ? {
      // From the first connection to the end (sign-ups excluded), over the wall time of that phase.
      cpuSeconds: Math.round(((local.stats.last.cpu.user + local.stats.last.cpu.system) - ((baseline ?? local.stats.first).cpu.user + (baseline ?? local.stats.first).cpu.system)) / 1e4) / 100,
      phaseSeconds: Math.round((performance.now() - phaseStart) / 1000),
      peakRssMb: Math.round(local.stats.last.peakRss / 1048576), heapMb: Math.round(local.stats.last.heap / 1048576),
    } : 'not measured (remote server)';
    const report = {
      at: new Date().toISOString(), target: base, options: { ...options, accounts: options.accounts ? '(file)' : null },
      connections: { opened: metrics.connect.length, failed: metrics.connectFailures, droppedDuringRun: metrics.drops, latencyMs: percentiles(metrics.connect) },
      burst: { messages: metrics.burstIds.size, ackMs: percentiles(metrics.burstAck) },
      messages: { sent: metrics.sent, delivered: metrics.delivered, unacknowledged: pendingAcks.size, undelivered: pendingDeliveries.size, sendFailures: metrics.sendFailures, steadyAckMs: percentiles(metrics.ack), steadyDeliveryMs: percentiles(metrics.delivery) },
      calls: { attempted: options.calls, failed: metrics.callsFailed, offerToAnswerMs: percentiles(metrics.callSetup) },
      serverErrors: metrics.errors, server,
    };
    if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2));
    return report;
  } finally {
    for (const socket of sockets) socket?.terminate();
    await local?.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await runLoad(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Load test failed: ${error.message}`);
    process.exit(1);
  }
}
