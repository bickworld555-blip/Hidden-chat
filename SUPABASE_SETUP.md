# Phase 1: Supabase setup and SQLite migration

This guide preserves Relay's existing username/password login and device sessions.
Supabase is the PostgreSQL host, **not** the authentication provider in this phase.
The browser continues to use `/api` and `/ws` on the app origin. Do not bypass the
Express authorization checks by querying Supabase from the browser.

## 1. Create the production project

1. Sign in at <https://supabase.com/dashboard>, enable MFA on your account, and
   create a project in an organization you control.
2. Select a region near your future Hostinger VPS and users. Choose an appropriate
   production plan and review backup/PITR availability before importing real data.
3. Generate a strong **database password**, save it in your password manager, and
   wait for the project to finish provisioning.
4. Open **Connect**. Save the project URL and project reference.
5. Copy the **Direct connection** URI for an IPv6-capable persistent server. If
   the Windows machine/VPS is IPv4-only, use **Session pooler**, port **5432**.
   Copy the actual pooler host and username from the dashboard; do not guess them.
   Do not use the transaction pooler on port 6543 for this configuration: the app
   sets its private schema through PostgreSQL connection startup options.
6. Replace `[YOUR-PASSWORD]` with your percent-encoded database password.
   Encode only the password component (for example `@` becomes `%40`), not the
   whole URI. Do not place a real password in a command that enters shell history.
7. In Database Settings, download the CA certificate and enable SSL enforcement.
   Enabling enforcement can restart the database; do it before importing data.
   The app verifies TLS certificates and hostname; never use
   `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`.

### Where to find API keys

Use Connect / Project Settings > API Keys:

| Value | Allowed location | Needed by this phase? |
| --- | --- | --- |
| Project URL | Browser or backend | No |
| Publishable key (`sb_publishable_...`) | Browser with suitable RLS policies | No |
| Secret key (`sb_secret_...`) | Backend secret manager only | No |
| Legacy `anon` key | Browser with suitable RLS policies | No |
| Legacy `service_role` key | Backend secret manager only | No |
| PostgreSQL connection URI/password | Backend only | **Yes** |

Supabase recommends publishable/secret keys for new projects over the legacy
`anon`/`service_role` keys. A PostgreSQL password is not an API key. The chosen
direct-database architecture does not use any Supabase HTTP API keys. Do not add
unused keys to the frontend or set `VITE_DATABASE_URL`,
`VITE_SUPABASE_SERVICE_ROLE_KEY`, or `VITE_SUPABASE_SECRET_KEY`.
Every `VITE_*` value can be read from the delivered JavaScript.

## 2. Configure this app locally

Run these commands in **PowerShell**, not at the REA repository root:

```powershell
Set-Location C:\Users\shakil\WorldMessenger\chat-app
node --version
npm --version
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Use a supported Node.js release with `node:sqlite` (Node 24 LTS recommended).
Do not overwrite an existing environment file. Before editing one, make a
private, timestamped backup outside Git.

Set the following **backend-only** variables in `.env`:

```dotenv
DATABASE_URL=postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@EXACT_SESSION_POOLER_HOST:5432/postgres
DATABASE_SSL_CA=C:\certificates\prod-supabase.cer
DATABASE_POOL_MAX=5
NODE_ENV=production
HOST=127.0.0.1
PORT=4174
RELAY_ALLOWED_ORIGINS=https://chat.example.com
RELAY_SEED_DEMO=false
RELAY_DATA_DIRECTORY=C:\relay-data
RELAY_TURN_URL=
RELAY_TURN_USERNAME=
RELAY_TURN_CREDENTIAL=
```

Replace every placeholder with your values. For the direct endpoint, use the
exact direct URI instead. Remove SSL query parameters such as `sslmode` from
`DATABASE_URL`; `DATABASE_SSL_CA` owns TLS configuration. The CA variable can be
omitted only when the endpoint's certificate is trusted by Node's CA store.
On the eventual Linux VPS, use Linux paths for the certificate/data directory
(for example `/etc/relay/supabase-ca.crt` and `/var/lib/relay`).

`RELAY_ALLOWED_ORIGINS` accepts comma-separated **exact HTTPS origins**.
The TURN variables need a real relay for reliable mobile-network calls;
database migration does not make TURN unnecessary. Keep TURN credentials private
and use short-lived credentials before public rollout.

**Frontend environment:** no Supabase variables are required. In development,
Vite already proxies `/api` and `/ws`. In production, the HTTPS reverse proxy
must serve `dist` and proxy both paths to Express, including WebSocket upgrades.
The Vite dev server and `vite preview` are not the production server.

Check ignore rules without printing any file contents:

```powershell
git check-ignore .env .data node_modules dist backups
```

The parent repository is already initialized Git and contains unrelated changes.
Do not run `git init` again or blindly stage the entire parent repository.
This phase neither pushes code nor deploys it.

## 3. Create the private schema

```powershell
npm run db:migrate
```

The command loads `.env`, acquires a migration lock, creates the `relay` schema
in a transaction, and records its version. Re-running the same migration does
not drop tables or overwrite data. Existing incompatible schemas cause an error.
Do not also run the raw SQL file manually outside a transaction.

The schema is intentionally separate from `public`. All tables enable RLS, and
the `anon`/`authenticated` roles have no schema/table permissions. Do not add
`relay` to Supabase's exposed Data API schemas. The owner connection used for
migration can access the data; this is **not** a per-user Supabase Auth policy.

### Actual schema mapping

| Existing data | Supabase destination |
| --- | --- |
| Users and scrypt password hashes | `relay.users` |
| Device sessions (hashed tokens) | `relay.sessions` |
| Contact links / chat lists | `relay.contacts` |
| Disappearing-message settings | `relay.chat_settings` |
| Messages, deletion tombstones and replies | `relay.messages` |
| Reactions and per-user hidden messages | `relay.message_reactions`, `relay.message_hidden` |
| Attachment metadata / resumable uploads | `relay.media`, `relay.uploads` |
| One-time pairing codes | `relay.pairing_codes` |
| Call history | Existing per-user browser IndexedDB; no server table |
| Active calls / signaling ownership | Memory-only; no migration |
| Live-location coordinates | Memory-only consent-based relay; never persisted |
| Settlements | No schema or implementation exists in this app |

IDs remain text, password hashes remain scrypt, timestamps retain their existing
ISO-text or epoch-millisecond representation, and integer flags remain integers.
No Supabase Auth users are created. Browser session storage and call history
do not automatically transfer to a new domain.

Do not invent settlement/payment records or start persisting live coordinates.
Those features require separate behavior, authority and retention decisions.
If you have another local PostgreSQL database, its schema was not found here:
do not restore it blindly into this project's `public` schema.

## 4. Back up and preview the SQLite import

Stop the old Relay server and keep it stopped until cutover. Stop any destination
app server too. Do not interrupt a real call or upload without notifying users.
Back up the **entire** `.data` directory, which includes attachment/portrait bytes,
not just the SQLite database:

```powershell
Set-Location C:\Users\shakil\WorldMessenger\chat-app
$backup = Join-Path $env:USERPROFILE ("RelayBackups\before-supabase-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $backup
Copy-Item -LiteralPath .data -Destination $backup -Recurse
npm run db:import -- .data\relay.sqlite
```

If your SQLite path is elsewhere, supply its exact path instead and back up its
associated media/avatar directories. Backups contain private user data, password
hashes and session hashes; encrypt/restrict them and never upload them to GitHub.

The preview prints only per-table counts. The built-in demo IDs `ava`, `jordan`,
`nia`, `theo`, and `studio` and their related records are excluded. Missing or
unknown schema columns/tables stop the import rather than silently dropping facts.

## 5. Apply and verify the import

Use a **fresh, empty** destination:

```powershell
npm run db:import -- .data\relay.sqlite --apply
```

This writes a consistent SQLite backup under ignored `backups`, imports from that
snapshot, takes a destination write lock, inserts bounded batches, and verifies
every table's count and SHA-256 content digest before committing. A constraint
or verification failure rolls back the whole import. A nonempty destination is
rejected, including a second successful import; do not delete live data to rerun.
The SQLite source is not changed. The snapshot and full-directory backup remain
available for recovery.

**Attachment bytes are not uploaded to Supabase Storage.** For the initial cutover,
retain the existing disk layout:

```powershell
New-Item -ItemType Directory -Path C:\relay-data
Copy-Item -LiteralPath .data\media -Destination C:\relay-data -Recurse
if (Test-Path .data\avatars) { Copy-Item -LiteralPath .data\avatars -Destination C:\relay-data -Recurse }
```

These commands assume the destination directory does not already exist. Inspect
an existing directory before copying; never overwrite another instance's files.
On Hostinger, transfer these bytes privately and set `RELAY_DATA_DIRECTORY` to a
persistent directory outside deployment releases. Keep the original `.data`
and backups; do not delete them after the first successful connection.

## 6. Validate before deployment

```powershell
npm test
npm run build
npm run start:production
```

In a second PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4174/api/v1/health
```

Startup checks the PostgreSQL schema version before listening. `health` is a
liveness endpoint, not a complete database/production readiness test.
Through the eventual HTTPS app origin, test:

- Existing login and new registration, including duplicate handles.
- Two real devices: new messages, offline delivery, replies, receipts and reactions.
- Upload/download original bytes, profile photos and resumable uploads.
- Video/audio calls over different mobile networks with TURN configured.
- Live-location consent, expiry and revocation without server coordinate retention.
- Restart persistence, session revocation, backups and restoration on a separate project.

The automated PostgreSQL tests use an embedded PostgreSQL engine (PGlite), not
Supabase, Supavisor, real TLS or a production network. Only your actual project
test establishes those integrations. Do not provide credentials in chat.

### Remaining public-rollout gates

This phase does **not** certify the existing app as production-ready. Before
opening registration to the public, complete authentication abuse/rate limits,
session expiry/revocation policy, HTTPS/proxy configuration, durable attachment
backups/capacity limits, monitoring, restore verification, TURN provisioning and
the receiving-device pairing UX. Use a single backend process for now: active
calls, live sessions and socket ownership are not shared between PM2 workers.
Deployments/restarts end active calls and live sessions.

For least privilege, use the project owner only for migrations/imports. Before
rollout, create a backend-only login role in the Supabase SQL Editor:

```sql
CREATE ROLE relay_app LOGIN PASSWORD 'REPLACE_PRIVATELY_WITH_A_NEW_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA relay TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA relay TO relay_app;
REVOKE INSERT, UPDATE, DELETE ON relay.schema_version FROM relay_app;
DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'relay'
  LOOP
    EXECUTE format(
      'CREATE POLICY relay_backend ON relay.%I TO relay_app USING (true) WITH CHECK (true)',
      item.tablename
    );
  END LOOP;
END $$;
```

Run this role creation once, not as an idempotent migration. Store its password
privately; use `relay_app` for a direct connection or `relay_app.PROJECT_REF` for
the shared session pooler, with the exact dashboard host. Replace the runtime
`DATABASE_URL`, then repeat the real-project tests. This role's RLS policies are
backend-only; Express still enforces individual users' access. Keep a separate
owner URI privately for future maintenance.

If cutover fails, stop the new server and return to the backed-up SQLite instance
in a private development/staging environment (`NODE_ENV=development`, unset
`DATABASE_URL`, `RELAY_SEED_DEMO=false`). Do not serve stale SQLite data publicly
or discard writes already accepted by PostgreSQL; reconcile those writes first.

Phases 2 and 3 follow after this checkpoint: GitHub-to-Hostinger deployment,
HTTPS/PM2 single-instance configuration, then a chosen mobile wrapper and signed
Android artifact workflow. No APK workflow or iOS build has been created in Phase 1.

## References

- [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase API key types](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
