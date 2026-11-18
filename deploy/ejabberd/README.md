# ejabberd on the VPS (chat.hiddenmessenger.com)

The XMPP core of the BEAM/XMPP move. ejabberd 24.12 (Ubuntu 26.04 package) listens on 127.0.0.1:5280 only; nginx
terminates TLS and exposes `/xmpp-websocket` and `/api/` (admin API, admin login required).

- `/etc/ejabberd/ejabberd.yml`: hosts `chat.hiddenmessenger.com`; `auth_method: [jwt, internal]` with
  `/etc/ejabberd/jwt.jwk` (the key behind `XMPP_JWT_SECRET`); no mod_mam, mod_muc, mod_register, mod_stun or
  server-to-server; mod_offline, mod_stream_mgmt, mod_ping, mod_client_state, mod_http_api.

  `mod_stream_mgmt`: `resume_timeout: 60`, `resend_on_timeout: if_offline` (changed from 300 on 2026-11-15). A phone that
  loses its network leaves a resumable session; messages for it wait there and reach offline storage (and so the
  `mod_hm` wake-up push) only when the timeout ends. 60 s bounds that delay; direct messages also get a wake-up
  sooner through POST /api/v1/xmpp/nudge when no delivery receipt comes back (src/xmpp/session.js).
- `mod_hm.erl` (this folder): offline wake-up hook and group fan-out. Built and loaded with:

  ```bash
  E=/usr/lib/x86_64-linux-gnu/ejabberd-24.12-4
  erlc -I $E/include -pa $E/ebin -o /opt/hm-ejabberd/ebin mod_hm.erl
  # /etc/ejabberd/ejabberdctl.cfg: ERL_OPTIONS="... -pa /opt/hm-ejabberd/ebin"
  ```

  Load a new build without dropping connections: copy the `.beam` into `/opt/hm-ejabberd/ebin`, then
  `ejabberdctl update mod_hm`; after a change to the options, `ejabberdctl reload_config`.

  The wake-up hook is retried for about half a minute (1, 2, 4, 8, 16 s) when the API answers 5xx, 408 or 429 or cannot
  be reached (it restarts on every deploy); each attempt is signed with the current time. ejabberd logs
  `mod_hm: wake-up hook accepted for … on attempt N` after a retry, and `… given up` if every attempt failed.

  ```yaml
  modules:
    mod_hm:
      hook_url: "http://127.0.0.1:4174/api/v1/xmpp/offline"   # the API on this machine: no TLS or DNS round trip
      check_url: "http://127.0.0.1:4174/api/v1/xmpp/allow"
      hook_key: "<the k value of /etc/ejabberd/jwt.jwk>"
  ```

- The Node API's admin user (`api_permissions` "node api") may run, besides the account commands, `hm_clear_verdicts`
  and `hm_receipt` (mod_hm: a delivery receipt on behalf of a phone that confirmed its wake-up push, POST
  /api/v1/xmpp/woke; the offline hook carries the stored direct message's stanza id for it).
- Device accounts are created and removed by the Node API (`server/xmpp.mjs`); devices sign in with its tokens.
