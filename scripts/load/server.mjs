// The server under load, in its own process (forked by scripts/load/run.mjs) so the clients' work does not count
// against it. Reports its CPU time and memory to the parent every second. SQLite in a temporary directory unless
// LOAD_DATABASE_URL names a staging PostgreSQL database. DATABASE_URL is deliberately ignored, so a shell that has the
// production database configured cannot fill it with test accounts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from '../../server/index.mjs';
import { xmppConfigFromEnv } from '../../server/xmpp.mjs';

const databaseUrl = process.env.LOAD_DATABASE_URL || null;
delete process.env.DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const directory = mkdtempSync(join(tmpdir(), 'hm-load-'));
const service = createChatServer({
  port: 0, host: '127.0.0.1', dataDirectory: directory, migrate: Boolean(databaseUrl), databaseUrl: databaseUrl ?? undefined,
  databasePath: databaseUrl ? undefined : join(directory, 'load.sqlite'),
  pushSender: null, xmppConfig: xmppConfigFromEnv({}), // XMPP off: the load goes through the realtime socket
  // Load comes from one address and sends readable test text: both limits would stop the test, not the server.
  abuseLimits: null, strictE2E: false,
});
const address = await service.listen();
let peakRss = 0;
const report = setInterval(() => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  process.send?.({ type: 'stats', cpu: process.cpuUsage(), rss: memory.rss, heap: memory.heapUsed, peakRss });
}, 1000);
process.send?.({ type: 'ready', port: address.port });
process.on('message', async (message) => {
  if (message?.type !== 'stop') return;
  clearInterval(report);
  await service.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
});
