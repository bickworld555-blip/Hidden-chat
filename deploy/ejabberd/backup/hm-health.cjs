// VPS health check, every 5 minutes (hm-health.timer): ejabberd, the public XMPP WebSocket path, coturn, the age of
// the last off-site backup and free disk. Each problem is reported to the Node API (POST /api/v1/xmpp/ops-alert,
// signed like mod_hm's hooks with the JWT key), which sends it to the operations webhook at most once per kind per
// 15 minutes. Node itself is watched from outside (.github/workflows/uptime.yml), which also probes XMPP.
const { execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');

const ALERT_URL = process.env.HM_ALERT_URL || 'https://hiddenmessenger.com/api/v1/xmpp/ops-alert';
const JWK = process.env.HM_JWK || '/etc/ejabberd/jwt.jwk';
const BACKUP_STAMP = '/var/lib/hm-backup/last-ok';
const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const DISK_MAX_PERCENT = 90;

const run = (command, args) => { try { return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 20_000 }) }; } catch (error) { return { ok: false, out: String(error.stdout ?? error.message) }; } };

async function report(kind, text) {
  const { k } = JSON.parse(fs.readFileSync(JWK, 'utf8'));
  const body = JSON.stringify({ kind, text, ts: Math.floor(Date.now() / 1000) });
  const signature = createHmac('sha256', Buffer.from(k, 'base64url')).update(body).digest('hex');
  try {
    const response = await fetch(ALERT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hm-signature': signature, 'user-agent': 'hm-health/1' }, body, signal: AbortSignal.timeout(10_000) });
    console.log(`alert ${kind}: HTTP ${response.status}`);
  } catch (error) {
    console.log(`alert ${kind} not delivered: ${error.name}`);
  }
}

(async () => {
  const problems = [];
  const status = run('ejabberdctl', ['status']);
  if (!status.ok || !/is running/.test(status.out)) problems.push(['ejabberd', 'ejabberd is not running.']);
  try {
    const response = await fetch('https://chat.hiddenmessenger.com/xmpp-websocket', { signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) problems.push(['websocket', `The XMPP WebSocket path answers ${response.status}.`]);
  } catch (error) {
    problems.push(['websocket', `The XMPP WebSocket path does not answer (${error.name}).`]);
  }
  if (run('systemctl', ['is-active', '--quiet', 'coturn']).ok === false) problems.push(['coturn', 'coturn (TURN relay for calls) is not running.']);
  let stamp = 0;
  try { stamp = Number(fs.readFileSync(BACKUP_STAMP, 'utf8').trim()) || 0; } catch { /* never ran */ }
  if (Date.now() - stamp > BACKUP_MAX_AGE_MS) problems.push(['backup', stamp ? `The last off-site backup is ${Math.round((Date.now() - stamp) / 3_600_000)} h old.` : 'No off-site backup has succeeded yet.']);
  const disk = run('df', ['--output=pcent', '/']);
  const used = Number(disk.out.split('\n')[1]?.trim().replace('%', ''));
  if (Number.isFinite(used) && used >= DISK_MAX_PERCENT) problems.push(['disk', `The VPS disk is ${used}% full.`]);
  for (const [kind, text] of problems) await report(kind, text);
  console.log(problems.length ? `${problems.length} problem(s)` : 'healthy');
})();
