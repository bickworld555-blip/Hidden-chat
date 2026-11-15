# coturn on the VPS (TURN relay for calls)

coturn 4.6 on 201.18.220.213 (`/etc/turnserver.conf`, TLS name p2pchat.tech): UDP/TCP 3478, TLS 5349, relay ports
49152–65535. The Node API hands every signed-in user the relay in `GET /api/v1/rtc-config`.

## Credentials: one TURN identity per user

- `use-auth-secret` + `static-auth-secret=<secret>`: the TURN REST scheme. The API gives each user the username
  `<expiry>:<userId>` (valid 24 h) and the password `base64(HMAC-SHA1(secret, username))` (server/index.mjs).
- The secret is derived, not configured twice: `hex(HMAC-SHA256(key, "hm-turn-rest-v1"))` with `key` = the
  base64url-decoded `XMPP_JWT_SECRET` (the "k" of `/etc/ejabberd/jwt.jwk` on the VPS). Rotating the JWT key rotates it.
- `user-quota=40` (allocations per user), `total-quota=3000`.

Why: with one shared user (`hmturn`) and `user-quota=12`, a couple of calls used the whole app's quota. After a
Wi-Fi ↔ mobile data switch the ICE restart needs new allocations while the old ones linger; coturn answered
`486 Allocation Quota Reached` (152 times in 12 hours), and on mobile networks — where a direct path rarely
exists — the call froze. Measured on the S23 on 2026-11-15.

With `static-auth-secret` set, coturn no longer accepts the static `user=` entry. The API keeps sending the shared
credentials after the personal ones (`RELAY_TURN_USERNAME`/`RELAY_TURN_CREDENTIAL`) only so the switch-over had no
gap; they can be removed from the environment.

`denied-peer-ip` refuses private and reserved ranges (403 on CreatePermission for a LAN candidate is expected).
