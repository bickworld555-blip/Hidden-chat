// Operations: alerts to a webhook (ALERT_WEBHOOK_URL: Slack, Discord, or anything that accepts a JSON POST) when the
// server starts, crashes, answers with a burst of server errors, or loses its database. Each kind of alert is sent at
// most once per 15 minutes. Without ALERT_WEBHOOK_URL nothing is sent. No user data is ever included.
// Uptime is watched from outside by .github/workflows/uptime.yml, which polls /api/v1/ready.

const QUIET_MS = 15 * 60 * 1000;
export const ERROR_BURST = Object.freeze({ count: 20, windowMs: 5 * 60 * 1000 });

export function alertWebhookFromEnv(env = process.env) {
  const value = typeof env.ALERT_WEBHOOK_URL === 'string' ? env.ALERT_WEBHOOK_URL.trim() : '';
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** send(kind, text): posts { text, content } (Slack and Discord field names) unless that kind was sent recently. */
export function createAlerts({ url, fetchImpl = globalThis.fetch, now = () => Date.now(), service = 'Hidden Messenger' } = {}) {
  const lastSent = new Map();
  return {
    enabled: Boolean(url),
    async send(kind, text) {
      if (!url) return false;
      const at = now();
      if (at - (lastSent.get(kind) ?? -Infinity) < QUIET_MS) return false;
      lastSent.set(kind, at);
      const message = `[${service}] ${text}`;
      try {
        const response = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message, content: message }), signal: AbortSignal.timeout(5000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

/** Express middleware counting 5xx answers; a burst sends one alert. */
export function serverErrorWatch(alerts, { now = () => Date.now(), burst = ERROR_BURST } = {}) {
  let times = [];
  return (request, response, next) => {
    response.on('finish', () => {
      if (response.statusCode < 500) return;
      const at = now();
      times = times.filter((time) => at - time < burst.windowMs);
      times.push(at);
      if (times.length >= burst.count) {
        alerts.send('errors', `${times.length} server errors in the last ${Math.round(burst.windowMs / 60000)} minutes (latest: ${response.statusCode} on ${request.method} ${request.route?.path ?? 'an API route'}).`).catch(() => {});
        times = [];
      }
    });
    next();
  };
}
