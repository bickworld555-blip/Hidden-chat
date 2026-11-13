// No Email. No Number. Only Privacy. — checked on every run, so nothing brings them back by accident:
//   * no table (Postgres migrations, after every later DROP, and the SQLite schema the server creates) has a column for
//     a phone number, an email address, an address book or a hardware identifier;
//   * the Android app declares no permission that reads contacts, phone numbers, SMS, call logs, accounts, other
//     apps or background location — in its manifest and, when a build has run, in every merged manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IDENTIFIER = /(?:^|_)(?:phone|phones|mobile|msisdn|e164|email|emails|e_mail|mail_address|imei|imsi|android_id|advertising_id|mac_address|ip_address|address_book|contact_book|phonebook)(?:_|$)/i;
const PROHIBITED_PERMISSIONS = [
  'READ_CONTACTS', 'WRITE_CONTACTS', 'GET_ACCOUNTS', 'READ_PROFILE',
  'READ_PHONE_STATE', 'READ_PHONE_NUMBERS', 'READ_PRIVILEGED_PHONE_STATE',
  'READ_SMS', 'RECEIVE_SMS', 'SEND_SMS', 'RECEIVE_MMS',
  'READ_CALL_LOG', 'WRITE_CALL_LOG', 'PROCESS_OUTGOING_CALLS',
  'ACCESS_BACKGROUND_LOCATION', 'QUERY_ALL_PACKAGES',
];
// USE_FINGERPRINT is allowed: androidx.biometric declares it for fingerprint unlock on Android 7–8.1 (a normal permission).

/** Every column the Postgres migrations leave behind: CREATE TABLE and ADD COLUMN, minus later DROP COLUMN. */
function postgresColumns() {
  const directory = join(ROOT, 'supabase', 'migrations');
  const columns = new Set();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    let table = null;
    for (const raw of readFileSync(join(directory, file), 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/--.*$/, '');
      const created = /CREATE TABLE (?:IF NOT EXISTS )?(?:relay\.)?(\w+)\s*\(/i.exec(line);
      if (created) { table = created[1]; continue; }
      if (table && /^\s*\);?\s*$/.test(line)) { table = null; continue; }
      if (table) {
        const column = /^\s*"?([a-z_][a-z0-9_]*)"?\s+(?:TEXT|INTEGER|BIGINT|SMALLINT|BOOLEAN|REAL|DOUBLE|NUMERIC|BYTEA|JSONB?|TIMESTAMPTZ?|SERIAL|BIGSERIAL|UUID)\b/i.exec(line);
        if (column && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(column[1])) columns.add(`${table}.${column[1]}`);
      }
      for (const match of line.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:relay\.)?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?/gi)) columns.add(`${match[1]}.${match[2]}`);
      for (const match of line.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:relay\.)?(\w+)\s+DROP COLUMN (?:IF EXISTS )?"?(\w+)"?/gi)) columns.delete(`${match[1]}.${match[2]}`);
    }
  }
  return columns;
}

test('no Postgres table keeps a phone number, an email address, an address book or a device identifier', () => {
  const columns = postgresColumns();
  assert.ok(columns.has('users.username') && columns.has('business_profiles.website'), 'the scan reads the migrations');
  assert.ok(!columns.has('business_profiles.phone') && !columns.has('business_profiles.email'), 'migration 027 dropped them');
  assert.deepEqual([...columns].filter((column) => IDENTIFIER.test(column.split('.')[1])), []);
});

test('the SQLite schema the server creates has no such column either', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-identifiers-'));
  const service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  try {
    const tables = service.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
    assert.ok(tables.includes('users') && tables.includes('business_profiles'));
    const found = [];
    for (const table of tables) {
      for (const column of service.db.prepare(`PRAGMA table_info(${table})`).all()) if (IDENTIFIER.test(column.name)) found.push(`${table}.${column.name}`);
    }
    assert.deepEqual(found, []);
  } finally {
    await service.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The app's manifest and every merged manifest a build left behind (the merged ones include library permissions). */
function manifests() {
  const source = join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const found = [source];
  const merged = join(ROOT, 'android', 'app', 'build', 'intermediates');
  const walk = (directory, depth) => {
    if (depth > 6 || !existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, depth + 1);
      else if (name === 'AndroidManifest.xml' && /merged_manifests?|packaged_manifests/.test(path)) found.push(path);
    }
  };
  walk(merged, 0);
  return found;
}

test('the Android app asks for no contacts, phone, SMS, call log, account or background-location permission', () => {
  const files = manifests();
  assert.ok(existsSync(files[0]), 'the app manifest exists');
  for (const file of files) {
    const xml = readFileSync(file, 'utf8');
    const declared = [...xml.matchAll(/<uses-permission(?:-sdk-23)?[^>]*android:name="android\.permission\.([A-Z_]+)"/g)].map((match) => match[1]);
    assert.ok(declared.includes('INTERNET'), `${file} lists permissions`);
    assert.deepEqual(declared.filter((name) => PROHIBITED_PERMISSIONS.includes(name)), [], file);
  }
  const plugin = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'bickworld555', 'hiddenchat', 'HiddenNativePlugin.java'), 'utf8');
  assert.equal(/ContactsContract|READ_CONTACTS|listContacts/.test(plugin), false, 'no code reads the address book');
  assert.equal(existsSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'bickworld555', 'hiddenchat', 'Invites.java')), false);
});
