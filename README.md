# Relay Chat

## Hostinger production deployment

Use [Hostinger VPS deployment](HOSTINGER_DEPLOYMENT.md) for the production
environment-variable list, Supabase TLS connection, Nginx and systemd templates,
and gated GitHub Actions auto-deployment. The service is a single persistent
Node.js process; static/shared hosting alone cannot run its WebSocket backend.

On Hostinger's managed Node.js hosting, select the **Express** preset with entry
file `server/main.mjs` and build script `build`. The server binds
`process.env.PORT` and serves the Vite `dist/` build itself. Set
`RELAY_DATA_DIRECTORY` to a persistent path outside the deployed release; the
default `.data` directory lives inside each deployed version. Managed hosting
cannot hold a certificate file, so paste the Supabase CA certificate text into
`DATABASE_SSL_CA`; a single line with `\n` or spaces instead of newlines works.

## Android device testing

See [GitHub push and Android APK builds](ANDROID_BUILD.md) for creating the
separate Hidden-chat repository, configuring a controlled HTTPS test URL and
signing secrets, and downloading the signed Capacitor APK from GitHub Actions.
The APK is a remote-URL test shell; Actions does not host the backend.

## Supabase migration

Start with [Phase 1: Supabase setup](SUPABASE_SETUP.md). The backend supports
Supabase PostgreSQL through `DATABASE_URL` while preserving the existing login,
REST and WebSocket protocols. SQLite remains available for local development.
The frontend starts empty, not with sample conversations. Development demo
seeding requires `RELAY_SEED_DEMO=true`; production refuses demo seeding and
SQLite. Database migrations do not move local attachment bytes or change live
location retention.

## Development

Run `npm install` once, then `npm run dev`. The app uses Vite on port 5173 and the API/WebSocket server on port 4174. The backend watcher is scoped to `server/` so changes in dependencies do not bounce active API/WebSocket connections. Set `PORT` or `HOST` to override the API bind address.

## Public tunnel testing

For temporary cross-network testing, install and authenticate the Ngrok CLI, then run `npm run tunnel:ngrok`. The launcher starts one HTTPS tunnel to Vite on port 5173, reads its generated origin from the local Ngrok agent API, and starts the app with that exact host/origin allowed. Vite proxies REST requests and WebSocket upgrades to the local API on port 4174, so a separate public backend tunnel is not needed. The launcher prints the public HTTPS URL and stops the tunnel when it exits.

Public tunneling exposes this demo to the internet. Use test accounts only, keep passwords and private data out of it, and stop the tunnel when finished. Do not set Vite's `allowedHosts` to `true` or use wildcard CORS. For a reserved tunnel domain or another tunnel provider, set `VITE_ALLOWED_HOSTS` to its exact hostname and add its exact HTTPS origin to the comma-separated `RELAY_ALLOWED_ORIGINS` before starting `npm run dev`.

## WebRTC calls

The server returns public STUN servers for ICE candidate discovery. Networks with symmetric or restrictive NAT/firewalls (most mobile data connections) need a TURN relay; without one, calls between such devices will not connect. The simplest setup is `RELAY_TURN_URL` with a comma-separated list of ports/transports for the same relay, so clients can fall back from UDP to TCP to TLS on 443:

```powershell
$env:RELAY_TURN_URL='turn:turn.example.net:3478?transport=udp,turn:turn.example.net:3478?transport=tcp,turns:turn.example.net:443?transport=tcp'
$env:RELAY_TURN_USERNAME='temporary-user'
$env:RELAY_TURN_CREDENTIAL='temporary-credential'
npm run dev
```

For several relays, pass ICE server objects as JSON in `RELAY_ICE_SERVERS` instead (or as well). TURN entries without a username and credential are dropped, because browsers reject a peer connection that contains one.

```powershell
$env:RELAY_ICE_SERVERS='[{"urls":["turn:turn.example.net:3478","turns:turn.example.net:443?transport=tcp"],"username":"temporary-user","credential":"temporary-credential"}]'
```

Use short-lived TURN credentials in shared or deployed environments. The API returns this configuration only to authenticated sessions. Microphone and camera access requires HTTPS on LAN devices; localhost is treated as a secure context by browsers.

Real peer-connection tests run under `npm test` with the dev-only `@roamhq/wrtc` package; it is not part of the app bundle.

## Sharing large files

Files up to 100 GB can be shared. Anything above 8 MB is uploaded in resumable 8 MB chunks streamed straight to `.data/media` (an interrupted chunk resumes from the last byte on disk; abandoned uploads are discarded after 24 hours). Downloads use a short-lived link so the browser streams the file to disk with its own progress and range-based resume; files above 200 MB are never previewed in memory and videos stream instead. Make sure the server's disk has room for the files you expect, and raise your reverse proxy's request body limit to at least 8 MB if you put one in front of the API.

## Location and contact sharing

The location picker uses Leaflet with OpenStreetMap tiles, Nominatim for the address of the chosen spot and public Overpass instances for "Nearby places". These are keyless public services: the chosen coordinates are sent to them, they are rate-limited (nearby places may show as unavailable when the instances are busy), and the attribution shown in the UI is required. Live location is consent-based: the recipient must accept before either side's position is shared; positions are relayed over the WebSocket for the chosen duration and are never stored on the server. Contact cards share a Relay contact's name, handle and photo (no phone numbers).

## Sounds

Sound selections are stored locally in IndexedDB and are not uploaded to the server. MP3 and WAV files up to 10 MB are supported for incoming calls, outgoing ringback, messages, and alerts.
