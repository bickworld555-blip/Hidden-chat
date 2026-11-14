# ejabberd on the VPS (chat.hiddenmessenger.com)

The XMPP core of the BEAM/XMPP move. ejabberd 24.12 (Ubuntu 26.04 package) listens on 127.0.0.1:5280 only; nginx
terminates TLS and exposes `/xmpp-websocket` and `/api/` (admin API, admin login required).

- `/etc/ejabberd/ejabberd.yml`: hosts `chat.hiddenmessenger.com`; `auth_method: [jwt, internal]` with
  `/etc/ejabberd/jwt.jwk` (the key behind `XMPP_JWT_SECRET`); no mod_mam, mod_muc, mod_register, mod_stun or
  server-to-server; mod_offline, mod_stream_mgmt, mod_ping, mod_client_state, mod_http_api.
- `mod_hm.erl` (this folder): offline wake-up hook and group fan-out. Built and loaded with:

  ```bash
  E=/usr/lib/x86_64-linux-gnu/ejabberd-24.12-4
  erlc -I $E/include -pa $E/ebin -o /opt/hm-ejabberd/ebin mod_hm.erl
  # /etc/ejabberd/ejabberdctl.cfg: ERL_OPTIONS="... -pa /opt/hm-ejabberd/ebin"
  ```

  ```yaml
  modules:
    mod_hm:
      hook_url: "https://hiddenmessenger.com/api/v1/xmpp/offline"
      hook_key: "<the k value of /etc/ejabberd/jwt.jwk>"
  ```

- Device accounts are created and removed by the Node API (`server/xmpp.mjs`); devices sign in with its tokens.
