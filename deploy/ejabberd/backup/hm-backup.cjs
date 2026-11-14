// Off-site backup of ejabberd's database (offline messages waiting for sleeping phones, device accounts, rosters):
// `ejabberdctl backup` on the VPS, encrypted with AES-256-GCM and stored in the production Postgres (Supabase, off
// the VPS) in ops.xmpp_backups. The key is derived from the JWT secret (the "k" of /etc/ejabberd/jwt.jwk, the same
// value as XMPP_JWT_SECRET in the Node app's environment), so a lost VPS does not take the key with it.
//
//   node hm-backup.cjs backup            make a backup, upload it, read it back and compare, keep the newest KEEP
//   node hm-backup.cjs fetch <file>      download and decrypt the newest backup to <file> (then: ejabberdctl restore)
//   node hm-backup.cjs list              what is stored
//
// Needs DBURL in the environment (from /root/.hm-backup.env) and the pg module (PG_MODULE, default
// /root/Hidden-chat/node_modules/pg). Exits non-zero on any failure, so the timer's unit shows it failed.
const { execFileSync } = require('node:child_process');
const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { Client } = require(process.env.PG_MODULE || '/root/Hidden-chat/node_modules/pg');

const KEEP = 14;
const JWK = process.env.HM_JWK || '/etc/ejabberd/jwt.jwk';
const CA = process.env.HM_DB_CA || '/root/Hidden-chat/certs/supabase-root-2021.crt';
const SPOOL = '/var/lib/ejabberd/hm-backup.bak';

const key = () => {
  const { k } = JSON.parse(fs.readFileSync(JWK, 'utf8'));
  return Buffer.from(hkdfSync('sha256', Buffer.from(k, 'base64url'), Buffer.alloc(0), Buffer.from('hm-ejabberd-backup-v1'), 32));
};
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function connect() {
  if (!process.env.DBURL) throw new Error('DBURL is not set');
  const client = new Client({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA, 'utf8') } });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ops`);
  await client.query(`CREATE TABLE IF NOT EXISTS ops.xmpp_backups (
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), host TEXT NOT NULL,
    plain_sha256 TEXT NOT NULL, plain_bytes BIGINT NOT NULL, iv BYTEA NOT NULL, tag BYTEA NOT NULL, data BYTEA NOT NULL)`);
  return client;
}

function decrypt(row) {
  const decipher = createDecipheriv('aes-256-gcm', key(), row.iv);
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.data), decipher.final()]);
}

async function backup() {
  fs.rmSync(SPOOL, { force: true });
  execFileSync('ejabberdctl', ['backup', SPOOL], { stdio: 'pipe' });
  const plain = fs.readFileSync(SPOOL);
  fs.rmSync(SPOOL, { force: true });
  if (plain.length < 100) throw new Error(`backup suspiciously small: ${plain.length} bytes`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const client = await connect();
  try {
    const { rows: [row] } = await client.query(
      'INSERT INTO ops.xmpp_backups(host, plain_sha256, plain_bytes, iv, tag, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      ['chat.hiddenmessenger.com', sha256(plain), plain.length, iv, cipher.getAuthTag(), data]);
    // Read it back from the database and prove it decrypts to the same bytes.
    const { rows: [stored] } = await client.query('SELECT iv, tag, data, plain_sha256 FROM ops.xmpp_backups WHERE id = $1', [row.id]);
    if (sha256(decrypt(stored)) !== stored.plain_sha256) throw new Error('read-back check failed');
    await client.query(`DELETE FROM ops.xmpp_backups WHERE id NOT IN (SELECT id FROM ops.xmpp_backups ORDER BY id DESC LIMIT ${KEEP})`);
    console.log(`backup ${row.id}: ${plain.length} bytes, sha256 ${sha256(plain).slice(0, 16)}, verified`);
    // hm-health.cjs alerts when this is more than a day old.
    fs.mkdirSync('/var/lib/hm-backup', { recursive: true });
    fs.writeFileSync('/var/lib/hm-backup/last-ok', String(Date.now()));
  } finally {
    await client.end();
  }
}

async function fetchLatest(file) {
  if (!file) throw new Error('usage: fetch <file>');
  const client = await connect();
  try {
    const { rows: [row] } = await client.query('SELECT id, created_at, iv, tag, data, plain_sha256 FROM ops.xmpp_backups ORDER BY id DESC LIMIT 1');
    if (!row) throw new Error('no backup stored');
    const plain = decrypt(row);
    if (sha256(plain) !== row.plain_sha256) throw new Error('checksum mismatch');
    fs.writeFileSync(file, plain, { mode: 0o600 });
    console.log(`backup ${row.id} of ${row.created_at.toISOString()} written to ${file} (${plain.length} bytes); restore with: ejabberdctl restore ${file}`);
  } finally {
    await client.end();
  }
}

async function list() {
  const client = await connect();
  try {
    const { rows } = await client.query('SELECT id, created_at, plain_bytes FROM ops.xmpp_backups ORDER BY id DESC');
    for (const row of rows) console.log(row.id, row.created_at.toISOString(), `${row.plain_bytes} bytes`);
  } finally {
    await client.end();
  }
}

const [command, argument] = process.argv.slice(2);
({ backup, fetch: () => fetchLatest(argument), list })[command]?.()
  .catch((error) => { console.error('hm-backup failed:', error.message); process.exit(1); })
  ?? (console.error('usage: hm-backup.cjs backup | fetch <file> | list'), process.exit(2));
