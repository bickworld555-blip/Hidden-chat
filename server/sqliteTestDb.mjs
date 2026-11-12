// Tests' stand-in for the Android app's SQLite: node:sqlite behind the Capacitor plugin's connection API.
import { DatabaseSync } from 'node:sqlite';

/** The plugin's connection API (query / run / execute / executeSet) over node:sqlite. */
export function pluginLikeConnection(db = new DatabaseSync(':memory:')) {
  const inTransaction = (transaction, work) => {
    if (!transaction) return work();
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    raw: db,
    query: async (sql, values = []) => ({ values: db.prepare(sql).all(...values) }),
    run: async (sql, values = []) => { const result = db.prepare(sql).run(...values); return { changes: { changes: Number(result.changes) } }; },
    execute: async (sql, transaction = true) => inTransaction(transaction, () => db.exec(sql)),
    executeSet: async (set, transaction = true) => inTransaction(transaction, () => { for (const { statement, values } of set) db.prepare(statement).run(...(values ?? [])); }),
  };
}
