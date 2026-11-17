# TURN over TLS on port 443 (calls through strict firewalls)

**Done 2026-11-17.** What is running on the VPS now:
- DNS: `turn.p2pchat.tech` A record pointing at 201.18.220.213. `p2pchat.tech` itself points at Hostinger web hosting, not the VPS, so the old
  `turns:p2pchat.tech:5349` never reached coturn.
- Certificate: its own Let's Encrypt certificate for `turn.p2pchat.tech`, issued with webroot `/var/www/html` through nginx on
  port 80, so it renews. The deploy hook `/etc/letsencrypt/renewal-hooks/deploy/coturn.sh` copies it to coturn.
- nginx: package `libnginx-mod-stream` added. `/etc/nginx/hm-stream-443.conf` (included at the end of `nginx.conf`) routes `:443` and
  `[::]:443` by server name. coturn listens only on the public IP, so `turn.p2pchat.tech` goes to `201.18.220.213:5349`; everything
  else goes to `127.0.0.1:8443`, where `chat.hiddenmessenger.com` (XMPP) and `p2pchat.tech` now listen.
- Checked: XMPP over IPv4 and IPv6, the p2pchat.tech redirect, and a relay-only TURN allocation from the S23 over
  `turns:turn.p2pchat.tech:443` (relay candidate in 0.6 s).
- Backups: `/root/nginx-backup-20261117-184039.tgz` and `/root/coturn-hook.sh.bak-20261117-183921`.
- `RELAY_TURN_URL` must list `turns:turn.p2pchat.tech:443?transport=tcp` and `turns:turn.p2pchat.tech:5349?transport=tcp`, in place of
  `turns:p2pchat.tech:5349`. Set it in hPanel: the replace API would wipe the other variables.

The original plan follows.

Some corporate, hotel and public Wi-Fi networks allow only TCP 443. The relay already offers UDP/TCP 3478 and TLS 5349;
this adds `turns:turn.p2pchat.tech:443?transport=tcp`.

Port 443 on the VPS (201.18.220.213) is already used by nginx for p2pchat.tech (a redirect to hiddenmessenger.com), so
nginx shares it by the TLS server name (SNI). Traffic for `turn.p2pchat.tech` goes untouched to coturn's TLS port;
everything else goes to the existing web site. coturn terminates TLS itself, so the TURN credentials never pass through
nginx in clear text.

## Steps (VPS, as root)

1. **DNS:** add an `A` record `turn.p2pchat.tech → 201.18.220.213`.
2. **Certificate:** extend the Let's Encrypt certificate to the new name:
   `certbot certonly --nginx -d p2pchat.tech -d turn.p2pchat.tech --expand`
   The existing deploy hook (`/etc/letsencrypt/renewal-hooks/deploy/coturn.sh`) copies it to coturn.
3. **nginx:** move the HTTPS site off the public 443.
   - In the p2pchat.tech `server` block, change `listen 443 ssl;` to `listen 127.0.0.1:8443 ssl;`. Do the same for any `[::]:443` line.
   - Add [nginx-stream-443.conf](nginx-stream-443.conf) at the top level of `/etc/nginx/nginx.conf`, outside the `http {}` block.
   - On Ubuntu the module is `libnginx-mod-stream`.
4. **Check:** `nginx -t && systemctl reload nginx`.
   - `https://p2pchat.tech` must still redirect.
   - `openssl s_client -connect turn.p2pchat.tech:443 -servername turn.p2pchat.tech` must show coturn's certificate.
5. **App:** in hPanel, add the new URL to `RELAY_TURN_URL` (comma-separated, keep the others):
   `turn:p2pchat.tech:3478?transport=udp, turn:p2pchat.tech:3478?transport=tcp, turns:p2pchat.tech:5349?transport=tcp, turns:turn.p2pchat.tech:443?transport=tcp`

No app release is needed: phones read the relay list from `GET /api/v1/rtc-config` at each call.

## Rollback

1. Restore the backup of the nginx config.
2. Put `listen 443 ssl;` back.
3. Remove the URL from `RELAY_TURN_URL`.
