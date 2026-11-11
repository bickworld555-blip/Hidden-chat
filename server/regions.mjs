// Approximate country for aggregate statistics (the admin console's world map). The app reports its device time
// zone (for example "Asia/Dhaka"); the server keeps only the country code it implies (BD). No IP address, city
// or precise location is used or stored, and the admin console only ever sees per-country totals.
import { createRequire } from 'node:module';
import countriesAndTimezones from 'countries-and-timezones';

const require = createRequire(import.meta.url);
const isoCountries = require('i18n-iso-countries');
isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const DAY = 24 * 60 * 60 * 1000;

/** ISO 3166-1 alpha-2 country for an IANA time zone, or null (UTC, Etc/…, unknown). */
export function countryForTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timeZone)) return null;
  return countriesAndTimezones.getCountryForTimezone(timeZone)?.id ?? null;
}

export const countryName = (code) => isoCountries.getName(code, 'en', { select: 'official' }) ?? isoCountries.getName(code, 'en') ?? code;
export const countryNumeric = (code) => isoCountries.alpha2ToNumeric(code) ?? null;

export function ensureRegionSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!columns.has('country')) db.exec('ALTER TABLE users ADD COLUMN country TEXT');
  if (!columns.has('country_updated_at')) db.exec('ALTER TABLE users ADD COLUMN country_updated_at INTEGER');
}

export function registerRegions({ app, db, requireSession, requireAdmin, now = () => Date.now() }) {
  // The app sends its time zone after sign-in (at most once a day). Unknown zones clear nothing.
  app.post('/api/v1/me/region', requireSession, async (request, response) => {
    const country = countryForTimeZone(request.body?.timeZone);
    if (country) await db.prepare('UPDATE users SET country = ?, country_updated_at = ? WHERE id = ?').run(country, now(), request.session.user_id);
    response.json({ country });
  });

  // Per-country totals for the world map: accounts, and accounts active in the last 7 days. Counts only; no
  // account is listed. Accounts without a known country are counted as "unknown".
  app.get('/api/admin/v1/geo', requireAdmin, async (request, response) => {
    const since = now() - 7 * DAY;
    const rows = await db.prepare(`SELECT users.country AS "code", count(*) AS "users",
        count(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id AND s.last_active_at >= ?) THEN users.id END) AS "active"
      FROM users WHERE users.deleted_at IS NULL GROUP BY users.country`).all(since);
    let unknown = { users: 0, active: 0 };
    const countries = [];
    for (const row of rows) {
      const users = Number(row.users);
      const active = Number(row.active);
      if (!row.code) { unknown = { users: unknown.users + users, active: unknown.active + active }; continue; }
      countries.push({ code: row.code, numeric: countryNumeric(row.code), name: countryName(row.code), users, active });
    }
    countries.sort((a, b) => b.active - a.active || b.users - a.users);
    response.json({ countries, unknown, since });
  });
}
