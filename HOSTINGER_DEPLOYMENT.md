# GoChat / Relay: Hostinger VPS + Supabase

This setup targets a **Hostinger Linux VPS**, not static/shared hosting. It runs
one Node.js process behind Nginx; active calls, sockets and live location are
memory-owned, so do not enable clustering or multiple replicas. Restarting the
service interrupts calls and sockets. The database is Supabase PostgreSQL, not
Supabase Auth or Storage. Attachments and avatars need persistent local disk.

## 1. Production environment variables

Use [.env.example](.env.example) as the complete template. On the VPS keep runtime
values in `/etc/relay/relay.env`, outside releases and Git. Do not overwrite an
existing file: take a private timestamped backup before editing. Never paste
credentials in chat, command history or workflow logs.

| Variable | Required / purpose |
| --- | --- |
| `NODE_ENV=production` | Required: prohibits SQLite and demo seeding |
| `DATABASE_URL` | Required: exact Supabase direct or **session** pooler URI |
| `DATABASE_SSL_CA` | Absolute downloaded CA path; omit only if Node trusts the endpoint |
| `DATABASE_POOL_MAX=5` | Optional, integer 1-20; keep within Supabase connection capacity |
| `HOST=127.0.0.1` | VPS loopback binding behind Nginx |
| `PORT=4174` | Fixed nonzero port; must match both Nginx upstreams |
| `RELAY_ALLOWED_ORIGINS` | Required: comma-separated exact HTTPS origins, no paths/wildcards |
| `RELAY_SEED_DEMO=false` | Never seed production demo users |
| `RELAY_DATA_DIRECTORY=/var/lib/relay` | Persistent directory for uploads and avatars |
| `RELAY_TURN_URL` | TURN URLs separated by commas/spaces; required for reliable restrictive-network calls |
| `RELAY_TURN_USERNAME`, `RELAY_TURN_CREDENTIAL` | Credentials for the configured TURN relay |
| `RELAY_ICE_SERVERS=[]` | Optional JSON array of additional ICE servers |
| `CALL_RING_TIMEOUT_MS=0` | Optional ringing timeout in milliseconds; 0 retains existing behavior |
| `ANDROID_APP_URL` | **Android build only**: public HTTPS app origin, not an APK URL |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` and `JWT_SECRET`
are **not used** by this backend. Do not provision unnecessary privileged keys.
Login uses scrypt password hashes and random device-session tokens whose hashes
are stored in PostgreSQL, not JWTs. No production `VITE_*` secrets are needed.
`VITE_ALLOWED_HOSTS`, `VITE_TUNNEL_HOST`, `VITE_HMR_CLIENT_PORT` are dev-only.

For local Windows checks use Windows paths for the CA/data directory; the
template's Linux paths are specifically for Hostinger.

## 2. Supabase prerequisites

Follow [Supabase setup and migration](SUPABASE_SETUP.md) to:

1. Create the project, configure backups and download the database CA.
2. Copy the actual **direct connection** URI for an IPv6-capable VPS, or
   **session pooler on 5432** for IPv4. Do not use transaction pooler port 6543:
   this app selects the private `relay` schema through connection startup options.
3. Percent-encode the password component. Remove `sslmode`, `sslcert`, `sslkey`,
   `sslrootcert` and `ssl` query parameters; the app owns verified TLS configuration.
4. Enable database SSL enforcement. Do not disable certificate verification to
   work around errors; correct the CA, hostname, URI or network configuration.
5. Run the versioned migration before first startup. It is transactional and
   idempotent. The `relay` schema is private and RLS-enabled; do not expose it in
   the Supabase Data API. A database owner connection bypasses RLS, so Express
   session authorization remains mandatory.
6. If importing old SQLite data, follow the guide's backup/import procedure
   during a scheduled outage and separately copy attachment/avatar bytes.

The service checks schema readiness before listening. `/api/v1/health` is
liveness; `/api/v1/ready` checks the current schema/database and returns HTTP 503
on failure without exposing credentials. Migration/connection failures stop
deployment rather than fall back to SQLite.

## 3. Prepare the VPS once

Prerequisites: Node **24 LTS** and matching npm, Nginx, systemd, curl (with
`--retry-all-errors`), tar, SSH and a valid HTTPS certificate. Confirm executable
paths with `command -v node npm`; adapt [relay.service](deploy/relay.service) if
Node is not `/usr/bin/node`. This repository does not install or upgrade software.

Use a dedicated `relay` account with an SSH home directory. As an administrator,
create `/opt/relay/releases` and `/var/lib/relay` owned by `relay`, and `/etc/relay`
owned by root with group `relay`. Suggested permissions: release directories
0755 (Nginx must traverse them), data 0700, configuration directory 0750, runtime
environment 0640 root:relay. Make the CA readable to the service. Never store
secrets in the Nginx document root.

The deployment account needs only passwordless permission for the exact command
`systemctl restart relay` (use the absolute systemctl path in sudoers and validate
with `visudo`). Do not grant unrestricted sudo. Treat its SSH key as production
execution authority; the account can read the runtime configuration.

Install [relay.service](deploy/relay.service) as `/etc/systemd/system/relay.service`
after backing up any existing service file, then run `sudo systemctl daemon-reload`
and `sudo systemctl enable relay`. The first deployment creates
`/opt/relay/current` pointing at its immutable release directory. The service's
filesystem sandbox permits writes only under `/var/lib/relay`; if customizing
the data path, update `ReadWritePaths` too.

Prepare [nginx.conf](deploy/nginx.conf) with your real domain, HTTPS certificate
paths and upstream port. Preserve the `map` in the Nginx `http` context. Install
it as a site only after reviewing existing sites and making private backups.
Run `sudo nginx -t` before `sudo systemctl reload nginx`. Obtain the certificate
before enabling the HTTPS template; certificate issuance is not automated here.
Use DNS records pointing to the VPS and permit only HTTPS/HTTP and your chosen
SSH port through the firewall; do not expose port 4174 publicly.

Nginx serves `dist`, proxies `/api/` without rewriting its path, and upgrades
`/ws`. The 16 MB body limit accommodates the app's 8 MB resumable chunks and
avatars, not a single 100 GB request. Plan disk capacity and backup retention
for the advertised large-file feature. TURN needs its own reachable relay and
firewall configuration. TURN credentials are returned to authenticated clients;
use temporary credentials and rotation before public rollout.

## 4. Enable GitHub Actions auto-deployment deliberately

Work in the **nested `chat-app` Git repository**, which is the root of
`bickworld555-blip/Hidden-chat` on GitHub. Do not push the unrelated REA parent's
history to that remote.

[Validate and deploy Relay VPS](.github/workflows/deploy-vps.yml) runs tests and
the production build on pushes to `main`. It packages only runtime source and
`dist`, not `.env`, certificates, `.data`, node_modules or APK signing keys.
Deployment remains **disabled** until repository variable
`RELAY_DEPLOY_ENABLED=true` is explicitly set.

Create a GitHub environment named `production`, restrict it to `main`, and
configure required approval if your GitHub plan supports it. Add these settings:

| GitHub setting | Value |
| --- | --- |
| Repository variable `RELAY_DEPLOY_ENABLED` | Leave unset/false until VPS, schema, DNS and HTTPS are ready |
| Production environment variable `RELAY_VPS_HOST` | VPS DNS hostname or IPv4 address, no URL/path |
| Production environment variable `RELAY_VPS_PORT` | SSH port, default 22 |
| Production environment variable `RELAY_VPS_USER` | `relay` |
| Production environment secret `RELAY_SSH_PRIVATE_KEY` | Dedicated deploy key; public key installed for the VPS account |
| Production environment secret `RELAY_SSH_KNOWN_HOSTS` | Independently verified OpenSSH known_hosts entry |
| Repository variable `ANDROID_APP_URL` | Same public HTTPS app origin, for the existing APK workflow |

For nonstandard SSH ports the known_hosts entry uses `[hostname]:port`. Verify
the host-key fingerprint through the Hostinger console or a trusted connection;
do not trust an unverified `ssh-keyscan` result. Never disable strict host checks.
Database credentials belong only on the VPS, not in Actions.

After configuration, set the enable flag and manually run the workflow on `main`
for the first release. [deploy-vps.sh](scripts/deploy-vps.sh) extracts the validated
artifact into a commit-addressed release, installs locked production dependencies,
migrates the schema, switches the symlink, restarts the service and checks local
readiness. On readiness failure it restores the previous app symlink if one
exists and reports failure; migrations are **not** rolled back. The version-1
migration adds an absent schema or validates the current version; future
non-backward-compatible migrations need a separate reviewed cutover.

A release directory that already exists is not overwritten; use a new commit
for a retry, or inspect and remove only that specific inactive failed release.
Retain the previous working release for rollback. Clean up named older inactive
releases/failed archives after verification to avoid filling the VPS disk.

## 5. Verify the actual public deployment

These checks must be run against the real VPS; local tests do not establish them:

- `sudo systemctl status relay` and `sudo journalctl -u relay`: no startup/TLS/schema errors.
- `curl --fail https://YOUR_DOMAIN/api/v1/health` and
  `curl --fail https://YOUR_DOMAIN/api/v1/ready`: HTTP 200, `{"status":"ok"}`.
- The public root serves the built UI over valid HTTPS, not Vite/preview.
- Registration/login, contact lookup, message delivery/read receipts, file
  upload/download and avatar updates work for two controlled test accounts.
- Authenticated `/ws` upgrades succeed; unauthenticated and foreign-origin
  upgrades are rejected.
- Calls work across Wi-Fi/mobile data using the configured TURN relay.
- Restart the service during a scheduled test: users/messages and media survive;
  live calls/location are expected to end, not persist.
- Confirm private `relay` tables are not exposed to Supabase anon/authenticated
  Data API clients and backups cover database **and** local media.

The APK workflow independently requires the existing Android signing secrets
documented in [Android build instructions](ANDROID_BUILD.md). A successful web
deployment does not prove that APK signing or phone connectivity succeeded.

Complete these live checks before declaring the deployment ready. Do not treat
a Git push or green local build as proof of a successful live deployment.
