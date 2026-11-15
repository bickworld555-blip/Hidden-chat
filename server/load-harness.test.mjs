// The load-test harness (scripts/load/run.mjs) keeps working: a tiny run against its own local server, and the
// guards that keep it away from production.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions, percentiles, runLoad } from '../scripts/load/run.mjs';

test('load harness: sockets, message acks and deliveries, and call signaling all measured', async () => {
  const report = await runLoad(parseOptions(['--users', '12', '--duration', '2', '--ramp', '0', '--rate', '60', '--calls', '3']), { log: () => {} });
  assert.equal(report.connections.opened, 12);
  assert.equal(report.connections.failed, 0);
  assert.ok(report.messages.sent > 6);
  assert.equal(report.messages.delivered, report.messages.sent, 'every message reached its receiver');
  assert.equal(report.messages.steadyAckMs.count + report.burst.ackMs.count, report.messages.sent);
  assert.equal(report.burst.messages, 6, 'one opening message per pair');
  assert.deepEqual([report.calls.failed, report.calls.offerToAnswerMs.count], [0, 3]);
  assert.deepEqual(report.serverErrors, {});
  assert.ok(report.server.cpuSeconds >= 0 && report.server.peakRssMb > 0, 'the server process is measured');
});

test('load harness: never production by accident, never a remote server without accounts', () => {
  assert.throws(() => parseOptions(['--target', 'https://hiddenmessenger.com']), /--allow-remote/);
  assert.throws(() => parseOptions(['--target', 'https://staging.example', '--allow-remote']), /--accounts/);
  assert.throws(() => parseOptions(['--target', 'https://hiddenmessenger.com', '--allow-remote', '--accounts', 'a.json']), /Refusing to load production/);
  assert.equal(parseOptions(['--target', 'http://127.0.0.1:4174']).target, 'http://127.0.0.1:4174');
  assert.throws(() => parseOptions(['--users', '10', '--calls', '6']), /two users per call/);
  assert.deepEqual(percentiles([5, 1, 3, 2, 4]), { count: 5, p50: 3, p95: 5, p99: 5, max: 5 });
});
