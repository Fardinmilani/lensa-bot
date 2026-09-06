// Mimics the subset of the Cloudflare D1 client API that src/db.js uses,
// backed by node:sqlite. Lets db.js run unmodified in plain Node tests --
// no wrangler, no real D1 -- while still matching D1's actual result shapes
// ({ meta: { changes, last_row_id } } from .run(), null from .first() on a
// miss, etc.) closely enough to catch shape mismatches before deploy.

function makeStatement(sqliteDb, sql, boundArgs) {
  return {
    bind(...args) {
      return makeStatement(sqliteDb, sql, args);
    },
    async run() {
      const info = sqliteDb.prepare(sql).run(...boundArgs);
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
      };
    },
    async all() {
      const results = sqliteDb.prepare(sql).all(...boundArgs);
      return { success: true, results };
    },
    async first(column) {
      const row = sqliteDb.prepare(sql).get(...boundArgs);
      if (row === undefined) return null;
      return column ? row[column] : row;
    },
  };
}

export function createD1Shim(sqliteDb) {
  return {
    prepare: (sql) => makeStatement(sqliteDb, sql, []),
    async batch(statements) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}
