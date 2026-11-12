// Short-lived caches in this server process for what nearly every message and request asks the database again:
// sessions, account rows, block lists, device lists, per-chat settings, group members. The server is one Node
// process holding every socket, so its memory is the authority between writes. Each value lives ttlMs (60 s) at most
// and is dropped at once when a write touches its table (invalidateOnWrite below), so a sign-out, a block or a new
// device takes effect immediately rather than within the minute.

/**
 * A map whose entries expire after ttlMs, holding at most max (the least recently used goes first). remember(key,
 * load) returns the cached value or loads, stores and returns it; a load that was in flight while the cache was
 * cleared is returned but not stored, so a value read before a write never outlives it.
 */
export function createTtlCache({ ttlMs = 60_000, max = 20_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  let generation = 0;
  const cache = {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) { entries.delete(key); return undefined; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    async remember(key, load) {
      const entry = entries.get(key);
      if (entry && entry.expires > now()) return cache.get(key);
      const started = generation;
      const value = await load();
      if (started === generation) cache.set(key, value);
      return value;
    },
    delete(key) { entries.delete(key); },
    clear() { generation += 1; entries.clear(); },
    get size() { return entries.size; },
  };
  return cache;
}

const WRITE = '(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:relay\\.)?';
const STATEMENT_CALLS = new Set(['run', 'get', 'all', 'iterate']);

/**
 * The database, with every write to a watched table clearing that table's caches, before the write and again once it
 * has finished (a read racing the write cannot put the old value back). `tables`: { name: { caches, ignore } }, where
 * `ignore` lists bookkeeping writes that change nothing cached (a session's last-active time). Works for node:sqlite
 * and for the Postgres wrapper (server/database.mjs), whose statements return promises.
 */
export function invalidateOnWrite(db, tables) {
  const rules = Object.entries(tables).map(([table, { caches, ignore = [] }]) => ({ pattern: new RegExp(`${WRITE}${table}\\b`, 'i'), caches, ignore }));
  const cachesFor = (sql) => {
    const hit = new Set();
    for (const rule of rules) {
      if (rule.pattern.test(sql) && !rule.ignore.some((pattern) => pattern.test(sql))) for (const cache of rule.caches) hit.add(cache);
    }
    return [...hit];
  };
  const clearAll = (caches) => { for (const cache of caches) cache.clear(); };
  const watch = (statement, caches) => new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!STATEMENT_CALLS.has(property)) return value.bind(target);
      return (...args) => {
        clearAll(caches);
        const result = value.apply(target, args);
        if (result && typeof result.then === 'function') return result.finally(() => clearAll(caches));
        clearAll(caches);
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'prepare') {
        return (sql) => {
          const statement = value.call(target, sql);
          const caches = cachesFor(String(sql));
          return caches.length ? watch(statement, caches) : statement;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Message rate limits counted in this process's memory (no database write per message). Same interface as the
 * shared limiter in server/abuse.mjs: hit(key, rules) → the wait in ms when a limit is exceeded, else 0. A restart
 * starts the counts afresh; sign-ups, rarer and the spam guard that must survive restarts, stay on the shared one.
 */
export function createMemoryRateLimiter({ now = () => Date.now(), max = 100_000 } = {}) {
  const windows = new Map(); // `${key}|${windowMs}` → { start, count }
  return {
    async hit(key, rules) {
      const at = now();
      let wait = 0;
      for (const { limit, windowMs } of rules) {
        const start = Math.floor(at / windowMs) * windowMs;
        const slot = `${key}|${windowMs}`;
        const current = windows.get(slot);
        const entry = current && current.start === start ? current : { start, windowMs, count: 0 };
        entry.count += 1;
        windows.delete(slot);
        windows.set(slot, entry);
        if (entry.count > limit) wait = Math.max(wait, start + windowMs - at);
      }
      while (windows.size > max) windows.delete(windows.keys().next().value);
      return wait;
    },
    /** Drops windows that have ended (run with the server's other housekeeping). */
    sweep() {
      const at = now();
      for (const [slot, entry] of windows) if (entry.start + entry.windowMs <= at) windows.delete(slot);
    },
    get size() { return windows.size; },
  };
}
