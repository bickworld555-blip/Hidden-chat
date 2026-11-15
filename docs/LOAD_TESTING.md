# Load testing

`scripts/load/run.mjs` drives the realtime server the way the app does: real sign-ups, persistent WebSockets with the
app's subprotocols and keep-alive pings, `message:send` bursts with acknowledgement and delivery timing, and call
signaling (offer → answer → end). Run it before raising a rollout stage or after changing connection, presence,
message or call handling.

```
npm run load -- --users 2000 --duration 60 --ramp 30 --rate 6 --calls 200 --out load.json
```

| Option | Default | Meaning |
|---|---|---|
| `--users` | 200 | Accounts and sockets (paired: user 2k talks to 2k+1) |
| `--ramp` | 10 | Seconds over which the sockets connect |
| `--duration` | 30 | Seconds of steady traffic |
| `--rate` | 6 | Messages per user per minute |
| `--calls` | 20 | Call setups (offer → answer → end), spread over the first half |
| `--target` | (own server) | Another server; non-local targets also need `--allow-remote` and `--accounts` |
| `--accounts` / `--save-accounts` | | Reuse or store accounts (`[{ id, token }]`) |
| `--out` | | Write the JSON report |

## Where it runs

- **By default** it forks its own server (`scripts/load/server.mjs`): SQLite in a temporary folder, push and XMPP off,
  abuse limits and strict end-to-end checks off (the load comes from one address and sends readable test text). The
  server's own CPU time and peak memory are reported.
- **Staging PostgreSQL:** set `LOAD_DATABASE_URL` to a staging database. `DATABASE_URL` is ignored on purpose, so a
  shell configured for production cannot fill the production database with test accounts.
- **A remote staging server:** `--target https://staging… --allow-remote --accounts accounts.json`. Sign-ups are rate
  limited per address, so accounts must exist beforehand.
- **Production** is refused unless `--i-understand-this-is-production` is added as well. Only do that in an agreed
  window: Hostinger may treat a load test as abuse, and real users share the server.

## Reading the report

- `connections`: opened / failed / dropped during the run, and the time to `connection:ready`.
- `burst`: the first message of every pair, all sent at once. Shows how fast a backlog drains (first contact also
  creates the contact link, so it is the most expensive message).
- `messages`: steady-state `steadyAckMs` (send → server acknowledgement) and `steadyDeliveryMs` (send → receiver).
- `calls`: offer → answer time through the server, and failures.
- `serverErrors`: `error` events by message. Should be empty.
- `server`: CPU seconds and wall time from the first connection (sign-ups excluded), peak RSS. Local server only.

## Results

All local, on the development PC (Windows 10, Node 24), SQLite, clients and server on the same machine. These
results are a regression baseline, not a production capacity: production uses PostgreSQL over the network behind
Hostinger's proxy.

| Date | Commit | Users | Steady load | Connected | Connect p50 / p95 | Steady ack p50 / p95 / p99 | Call setup p50 / p95 | Burst (n) drain p99 | Server CPU / wall | Peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-15 | before | 2,000 | 200 msg/s, 200 calls | **828 / 2,000** | 2.5 s / 14 s | (unusable: sockets queued) | 1.6 s / 12 s | | | 275 MB |
| 2026-11-15 | after presence fix | 2,000 | 200 msg/s, 200 calls | 2,000 / 2,000 | 2 ms / 5 ms | 44 / 84 / 97 ms | 38 / 86 ms | 1,000 msgs: 6.5 s | 35 s / 109 s | 209 MB |

**What the first run found:** every new connection computed presence for everyone online, and every online/offline
change was sent to every connected socket (both grew with the square of the number of people online). A loop also
stopped at the first viewer who was not allowed to see a change, so later viewers missed it. Presence now goes only
to people linked with the person (a contact, or someone they have chatted with, either way).

**Not measured yet:** PostgreSQL (`LOAD_DATABASE_URL`), the production host's limits, media uploads, XMPP
(ejabberd) connections, and anything above 2,000 sockets from one client machine (use several client machines with
`--accounts` slices for more).
