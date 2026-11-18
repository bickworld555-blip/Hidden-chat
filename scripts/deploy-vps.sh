#!/usr/bin/env bash
set -euo pipefail

sha="${1:?Pass the validated GitHub commit SHA}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid release SHA" >&2; exit 1; }
release="/opt/relay/releases/$sha"
archive="$HOME/relay-$sha.tgz"
test -f "$archive"
# Production env: one relay.env, or hostinger.env (hPanel export) overridden by vps.env,
# matching the EnvironmentFile order in relay.service. Later files win.
env_args=()
if [[ -r /etc/relay/relay.env ]]; then
    env_args=(--env-file=/etc/relay/relay.env)
elif [[ -r /etc/relay/hostinger.env && -r /etc/relay/vps.env ]]; then
    env_args=(--env-file=/etc/relay/hostinger.env --env-file=/etc/relay/vps.env)
else
    echo "Missing /etc/relay/relay.env (or hostinger.env + vps.env)" >&2
    exit 1
fi
test -d /var/lib/relay
test ! -e "$release"
previous=""
if [[ -L /opt/relay/current ]]; then
    previous="$(readlink -f /opt/relay/current)"
elif [[ -e /opt/relay/current ]]; then
    echo "Current release must be a symlink, not an existing directory/file" >&2
    exit 1
fi
if [[ -n "$previous" && ! "$previous" =~ ^/opt/relay/releases/[0-9a-f]{40}$ ]]; then
    echo "Current release does not belong to /opt/relay/releases" >&2
    exit 1
fi

mkdir -m 755 "$release"
tar --no-same-owner -xzf "$archive" -C "$release"
cd "$release"
npm ci --omit=dev
node "${env_args[@]}" scripts/migrate-postgres.mjs
port="$(node "${env_args[@]}" --input-type=module -e 'console.log(process.env.PORT ?? 4174)')"
[[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 && port <= 65535 )) || { echo "Invalid production PORT" >&2; exit 1; }

ln -s "$release" /opt/relay/current.next
mv -Tf /opt/relay/current.next /opt/relay/current
if sudo -n systemctl restart relay && curl --fail --silent --show-error \
    --retry 20 --retry-connrefused --retry-all-errors --retry-delay 1 --max-time 5 \
    "http://127.0.0.1:$port/api/v1/ready"; then
    rm -- "$archive"
    # Keep the newest releases (~300 MB each); never remove the live or previous one.
    keep="${RELAY_KEEP_RELEASES:-3}"
    for old in $(ls -1dt /opt/relay/releases/*/ | tail -n +"$((keep + 1))"); do
        old="${old%/}"
        [[ "$old" =~ ^/opt/relay/releases/[0-9a-f]{40}$ ]] || continue
        [[ "$old" == "$release" || "$old" == "$previous" ]] && continue
        rm -rf -- "$old"
    done
    echo "Relay release $sha is ready. Verify the public HTTPS site and WebSocket separately."
else
    echo "Deployment failed readiness; inspect journalctl -u relay." >&2
    if [[ -n "$previous" ]]; then
        ln -s "$previous" /opt/relay/current.next
        mv -Tf /opt/relay/current.next /opt/relay/current
        sudo -n systemctl restart relay
        echo "Restored previous application release; database migrations are not rolled back." >&2
    else
        echo "No previous release is available for rollback." >&2
    fi
    exit 1
fi
