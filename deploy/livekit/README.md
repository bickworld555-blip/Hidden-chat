# LiveKit SFU for group calls (3+ people)

The app already routes group calls of three or more people through an SFU when the server advertises one:
- `server/sfu.mjs` issues LiveKit room tokens.
- `GroupRelayCall.jsx` joins with end-to-end encryption, simulcast 180p/360p/full, RED and DTX.

Without an SFU, calls stay on the phone-to-phone mesh, which is capped at 4 people. Enabling it only needs a LiveKit
server and three environment variables in hPanel. No app release is needed.

## Option A: LiveKit Cloud (fastest)

1. Create a project at cloud.livekit.io. Choose the region closest to your users, such as Singapore or Mumbai for Bangladesh.
2. In hPanel › Node.js › Environment, set:
   - `LIVEKIT_URL` = the project's `wss://…livekit.cloud` URL
   - `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (the secret is at least 32 characters)
3. Restart the app. `GET /api/v1/calls/topology` now lists the SFU. Groups of 3+ show "Voice/Video call (everyone)".

Cost scales with participant-minutes. The free tier is enough for testing.

## Option B: your own server

You need a VPS close to your users with at least 2 vCPUs, good bandwidth, and open UDP. Don't use the current KVM1 VPS: it measured
about 0.19 MB/s to Dhaka, which is too slow for media.

1. Install Docker. Then copy [livekit.yaml](livekit.yaml) to `/opt/livekit/livekit.yaml`, set its `keys:` entry, and
   point a DNS name (for example `sfu.hiddenmessenger.com`) at the VPS.
2. Open these ports in the firewall:
   - 443/TCP (TLS signalling, via Caddy or nginx with a certificate);
   - 7881/TCP (media over TCP);
   - 50000–60000/UDP (media).
3. Run:
   `docker run -d --name livekit --restart unless-stopped --network host -v /opt/livekit/livekit.yaml:/livekit.yaml livekit/livekit-server --config /livekit.yaml`
4. Put a TLS reverse proxy in front of port 7880 for `wss://sfu.hiddenmessenger.com`.
5. Set `SFU_URL=wss://sfu.hiddenmessenger.com`, plus `SFU_API_KEY` and `SFU_API_SECRET` matching `keys:`, in hPanel.

## Check

Run a group call with 3 phones. On each phone, Call telemetry (`GET /api/admin/v1/call-telemetry`) should show one
upload per phone. In the LiveKit dashboard, each participant should publish 3 video layers.
