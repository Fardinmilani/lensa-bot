// All D1 access lives here so commands/* stay free of SQL. Every function
// takes `env` (env.DB is the D1 binding configured in wrangler.toml).

const operationalSchemaPromises = new WeakMap();
const OPERATIONAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS signal_fit_runs (
    request_id INTEGER PRIMARY KEY REFERENCES signal_requests(id),
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    config_json TEXT NOT NULL,
    results_json TEXT NOT NULL,
    selected_basis TEXT,
    selected_strategy_key TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_selection',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS signal_metadata (
    signal_id INTEGER PRIMARY KEY REFERENCES signals(id),
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL DEFAULT '4h',
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, symbol)
  )`,
  `CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    symbol TEXT NOT NULL,
    condition TEXT NOT NULL,
    level REAL NOT NULL,
    last_price REAL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    triggered_at TEXT,
    triggered_price REAL
  )`,
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    symbol TEXT,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signal_fit_runs_user ON signal_fit_runs(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(status, symbol)",
  "CREATE INDEX IF NOT EXISTS idx_journal_user ON journal_entries(user_id, created_at)",
];

/** Self-heals additive production tables when a deploy happens before the D1 migration. */
export async function ensureOperationalSchema(env) {
  if (!env?.DB || (typeof env.DB !== "object" && typeof env.DB !== "function")) throw new Error("D1 binding is unavailable.");
  const existing = operationalSchemaPromises.get(env.DB);
  if (existing) return existing;
  const pending = (async () => {
    await env.DB.batch(OPERATIONAL_SCHEMA.map((sql) => env.DB.prepare(sql)));
    const { results: signalColumns } = await env.DB.prepare("PRAGMA table_info(signals)").all();
    if (!signalColumns.some((column) => column.name === "backtest_detail_json")) {
      try {
        await env.DB.prepare("ALTER TABLE signals ADD COLUMN backtest_detail_json TEXT").run();
      } catch (error) {
        // Two fresh Worker isolates can race on the first request after a
        // deploy. Treat the losing ALTER as success only if the other isolate
        // really added the column; otherwise preserve the original failure.
        const { results: refreshedColumns } = await env.DB.prepare("PRAGMA table_info(signals)").all();
        if (!refreshedColumns.some((column) => column.name === "backtest_detail_json")) throw error;
      }
    }
    return true;
  })()
    .catch((error) => {
      operationalSchemaPromises.delete(env.DB);
      throw error;
    });
  operationalSchemaPromises.set(env.DB, pending);
  return pending;
}

// --- Admins ------------------------------------------------------------

/**
 * The configured owner is permanent and self-healing: whenever they contact
 * the bot, make sure their admin row exists even if another admin removed it.
 */
export async function ensureBootstrapAdmin(env, telegramId, username) {
  if (!isOwner(env, telegramId)) return false;
  const { meta } = await env.DB.prepare("INSERT OR IGNORE INTO admins (telegram_id, username, added_by) VALUES (?, ?, NULL)")
    .bind(telegramId, username ?? null)
    .run();
  return meta.changes > 0;
}

export function isOwner(env, telegramId) {
  return Boolean(env.OWNER_TELEGRAM_ID) && String(telegramId) === String(env.OWNER_TELEGRAM_ID);
}

export async function isAdmin(env, telegramId) {
  const row = await env.DB.prepare("SELECT 1 FROM admins WHERE telegram_id = ?").bind(telegramId).first();
  return Boolean(row);
}

export async function addAdmin(env, telegramId, addedBy, username) {
  if (!isOwner(env, addedBy)) return false;
  await env.DB.prepare("INSERT OR IGNORE INTO admins (telegram_id, username, added_by) VALUES (?, ?, ?)")
    .bind(telegramId, username ?? null, addedBy)
    .run();
  return true;
}

export async function removeAdmin(env, telegramId, removedBy = null) {
  if (isOwner(env, telegramId)) return false;
  if (!isOwner(env, removedBy)) return false;
  const { meta } = await env.DB.prepare("DELETE FROM admins WHERE telegram_id = ?").bind(telegramId).run();
  return meta.changes > 0;
}

export async function listAdmins(env) {
  const { results } = await env.DB.prepare("SELECT telegram_id, username, added_at FROM admins ORDER BY added_at").all();
  return results;
}

/**
 * Small, newest-first user pages for the admin inline keyboards. The query
 * deliberately returns only fields needed by the picker and can exclude
 * current admins for the add-admin flow.
 */
export async function listUsersForAdminPicker(env, { excludeAdmins = false, limit = 10, offset = 0 } = {}) {
  const safeLimit = Math.min(10, Math.max(1, Math.trunc(Number(limit) || 10)));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const where = excludeAdmins ? "WHERE NOT EXISTS (SELECT 1 FROM admins a WHERE a.telegram_id = u.telegram_id)" : "";
  const { results } = await env.DB.prepare(
    `SELECT u.telegram_id, u.username, u.joined_at
     FROM users u
     ${where}
     ORDER BY u.joined_at DESC, u.telegram_id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(safeLimit, safeOffset)
    .all();
  return results;
}

export async function getUserForAdminPicker(env, telegramId, { excludeAdmin = false } = {}) {
  const adminClause = excludeAdmin ? "AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.telegram_id = u.telegram_id)" : "";
  return env.DB.prepare(
    `SELECT u.telegram_id, u.username
     FROM users u
     WHERE u.telegram_id = ? ${adminClause}`
  )
    .bind(telegramId)
    .first();
}

// --- Users & plans -------------------------------------------------------

export async function getOrCreateUser(env, telegramId, username) {
  await env.DB.prepare("INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)")
    .bind(telegramId, username ?? null)
    .run();
  // Keep username fresh in case it changed since last time.
  await env.DB.prepare("UPDATE users SET username = ? WHERE telegram_id = ? AND (username IS NULL OR username != ?)")
    .bind(username ?? null, telegramId, username ?? null)
    .run();
  return getUserWithPlan(env, telegramId);
}

export async function getUserWithPlan(env, telegramId) {
  return env.DB.prepare(
    `SELECT u.telegram_id, u.username, u.is_blocked, p.id AS plan_id, p.name AS plan_name,
            p.daily_signal_limit, p.max_open_signals
     FROM users u JOIN plans p ON p.id = u.plan_id
     WHERE u.telegram_id = ?`
  )
    .bind(telegramId)
    .first();
}

export async function listPlans(env) {
  const { results } = await env.DB.prepare("SELECT id, name, daily_signal_limit, max_open_signals FROM plans ORDER BY id").all();
  return results;
}

/** Returns false if the plan name doesn't exist, true on success. */
export async function setUserPlanByName(env, telegramId, planName) {
  const plan = await env.DB.prepare("SELECT id FROM plans WHERE name = ?").bind(planName).first();
  if (!plan) return false;
  await env.DB.prepare("UPDATE users SET plan_id = ? WHERE telegram_id = ?").bind(plan.id, telegramId).run();
  return true;
}

// --- Usage limits (Phase 2 will call these before starting a fit) --------

/** Signal requests created since UTC midnight. NB: UTC day boundary, not Tehran's. */
export async function countSignalRequestsToday(env, telegramId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM signal_requests
     WHERE user_id = ? AND requested_at >= datetime('now', 'start of day')`
  )
    .bind(telegramId)
    .first();
  return row.count;
}

export async function countOpenSignals(env, telegramId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM signals WHERE user_id = ? AND status = 'open'")
    .bind(telegramId)
    .first();
  return row.count;
}

/** Checks a user's plan limits and returns { allowed, reason? }. */
export async function checkRateLimit(env, telegramId) {
  const user = await getUserWithPlan(env, telegramId);
  if (user.daily_signal_limit != null) {
    const used = await countSignalRequestsToday(env, telegramId);
    if (used >= user.daily_signal_limit) {
      return { allowed: false, reason: "daily_limit", limit: user.daily_signal_limit, used };
    }
  }
  if (user.max_open_signals != null) {
    const open = await countOpenSignals(env, telegramId);
    if (open >= user.max_open_signals) {
      return { allowed: false, reason: "open_limit", limit: user.max_open_signals, open };
    }
  }
  return { allowed: true };
}

// --- /signal wizard session state -----------------------------------------

export async function getSession(env, telegramId) {
  const row = await env.DB.prepare("SELECT step, data FROM sessions WHERE telegram_id = ?").bind(telegramId).first();
  if (!row) return null;
  return { step: row.step, data: JSON.parse(row.data) };
}

export async function setSession(env, telegramId, step, data) {
  await env.DB.prepare(
    `INSERT INTO sessions (telegram_id, step, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET step = excluded.step, data = excluded.data, updated_at = excluded.updated_at`
  )
    .bind(telegramId, step, JSON.stringify(data))
    .run();
}

export async function clearSession(env, telegramId) {
  await env.DB.prepare("DELETE FROM sessions WHERE telegram_id = ?").bind(telegramId).run();
}

// --- signal_requests / signals ---------------------------------------------

export async function createSignalRequest(env, { userId, symbol, timeframe, leverage, stopLossPercent, takeProfitPercent }) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent, status)
     VALUES (?, ?, ?, ?, ?, ?, 'fitting')`
  )
    .bind(userId, symbol, timeframe, leverage, stopLossPercent, takeProfitPercent)
    .run();
  return meta.last_row_id;
}

export async function updateSignalRequestStatus(env, requestId, status) {
  await env.DB.prepare("UPDATE signal_requests SET status = ? WHERE id = ?").bind(status, requestId).run();
}

export async function saveSignalFitRun(env, { requestId, userId, config, results }) {
  await env.DB.prepare(
    `INSERT INTO signal_fit_runs (request_id, user_id, config_json, results_json, status, updated_at)
     VALUES (?, ?, ?, ?, 'awaiting_selection', datetime('now'))
     ON CONFLICT(request_id) DO UPDATE SET
       config_json = excluded.config_json,
       results_json = excluded.results_json,
       selected_basis = NULL,
       selected_strategy_key = NULL,
       status = 'awaiting_selection',
       updated_at = datetime('now')`
  )
    .bind(requestId, userId, JSON.stringify(config), JSON.stringify(results))
    .run();
}

export async function getSignalFitRun(env, requestId) {
  const row = await env.DB.prepare(
    `SELECT request_id, user_id, config_json, results_json, selected_basis,
            selected_strategy_key, status, created_at, updated_at
     FROM signal_fit_runs WHERE request_id = ?`
  ).bind(requestId).first();
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config_json), results: JSON.parse(row.results_json) };
}

export async function chooseSignalFitBasis(env, requestId, userId, basis) {
  const { meta } = await env.DB.prepare(
    `UPDATE signal_fit_runs SET selected_basis = ?, updated_at = datetime('now')
     WHERE request_id = ? AND user_id = ? AND status = 'awaiting_selection'`
  ).bind(basis, requestId, userId).run();
  return meta.changes > 0;
}

export async function chooseSignalFitStrategy(env, requestId, userId, strategyKey) {
  const { meta } = await env.DB.prepare(
    `UPDATE signal_fit_runs
     SET selected_strategy_key = ?, status = 'finalizing', updated_at = datetime('now')
     WHERE request_id = ? AND user_id = ? AND status = 'awaiting_selection'`
  ).bind(strategyKey, requestId, userId).run();
  return meta.changes > 0;
}

export async function finishSignalFitRun(env, requestId, status) {
  await env.DB.prepare(
    "UPDATE signal_fit_runs SET status = ?, updated_at = datetime('now') WHERE request_id = ?"
  ).bind(status, requestId).run();
}

export async function saveSignalMetadata(env, signalId, metadata) {
  await env.DB.prepare(
    `INSERT INTO signal_metadata (signal_id, metadata_json) VALUES (?, ?)
     ON CONFLICT(signal_id) DO UPDATE SET metadata_json = excluded.metadata_json`
  ).bind(signalId, JSON.stringify(metadata ?? {})).run();
}

export async function getSignalMetadata(env, signalId) {
  const row = await env.DB.prepare("SELECT metadata_json FROM signal_metadata WHERE signal_id = ?").bind(signalId).first();
  return row ? JSON.parse(row.metadata_json) : null;
}

// --- Operational automation: watchlist, alerts and journal ----------------

export async function addWatchlistSymbol(env, userId, symbol, timeframe = "4h") {
  await env.DB.prepare(
    `INSERT INTO watchlist (user_id, symbol, timeframe) VALUES (?, ?, ?)
     ON CONFLICT(user_id, symbol) DO UPDATE SET timeframe = excluded.timeframe`
  ).bind(userId, symbol, timeframe).run();
}

export async function removeWatchlistSymbol(env, userId, symbol) {
  const { meta } = await env.DB.prepare("DELETE FROM watchlist WHERE user_id = ? AND symbol = ?").bind(userId, symbol).run();
  return meta.changes > 0;
}

export async function listWatchlist(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT symbol, timeframe, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at DESC LIMIT 20"
  ).bind(userId).all();
  return results;
}

export async function createPriceAlert(env, { userId, symbol, condition, level, lastPrice = null }) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO price_alerts (user_id, symbol, condition, level, last_price)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, symbol, condition, level, lastPrice).run();
  return meta.last_row_id;
}

export async function listPriceAlerts(env, userId, { activeOnly = false } = {}) {
  const where = activeOnly ? "AND status = 'active'" : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM price_alerts WHERE user_id = ? ${where} ORDER BY created_at DESC LIMIT 30`
  ).bind(userId).all();
  return results;
}

export async function getActivePriceAlerts(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM price_alerts WHERE status = 'active' ORDER BY created_at LIMIT 200"
  ).all();
  return results;
}

export async function deletePriceAlert(env, userId, alertId) {
  const { meta } = await env.DB.prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ?").bind(alertId, userId).run();
  return meta.changes > 0;
}

export async function updatePriceAlerts(env, updates) {
  if (!updates.length) return;
  const active = env.DB.prepare("UPDATE price_alerts SET last_price = ? WHERE id = ? AND status = 'active'");
  const triggered = env.DB.prepare(
    "UPDATE price_alerts SET status = 'triggered', last_price = ?, triggered_price = ?, triggered_at = datetime('now') WHERE id = ? AND status = 'active'"
  );
  await env.DB.batch(updates.map((item) => item.triggered
    ? triggered.bind(item.price, item.price, item.id)
    : active.bind(item.price, item.id)));
}

export async function addJournalEntry(env, { userId, symbol = null, note }) {
  const { meta } = await env.DB.prepare(
    "INSERT INTO journal_entries (user_id, symbol, note) VALUES (?, ?, ?)"
  ).bind(userId, symbol, note).run();
  return meta.last_row_id;
}

export async function listJournalEntries(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, symbol, note, created_at FROM journal_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  ).bind(userId).all();
  return results;
}

export async function deleteJournalEntry(env, userId, entryId) {
  const { meta } = await env.DB.prepare("DELETE FROM journal_entries WHERE id = ? AND user_id = ?").bind(entryId, userId).run();
  return meta.changes > 0;
}

export async function listUserSignals(env, userId, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM signals WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?`
  ).bind(userId, Math.min(50, Math.max(1, Number(limit) || 20))).all();
  return results;
}

export async function saveSignal(env, s) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO signals (
       request_id, user_id, symbol, timeframe, leverage, strategy_key, strategy_label, direction,
       entry_price, stop_loss_price, take_profit_price,
       backtest_return_percent, backtest_win_rate, backtest_trade_count, backtest_sharpe, backtest_detail_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      s.requestId,
      s.userId,
      s.symbol,
      s.timeframe,
      s.leverage,
      s.strategyKey,
      s.strategyLabel,
      s.direction,
      s.entryPrice,
      s.stopLossPrice,
      s.takeProfitPrice,
      s.backtestReturnPercent ?? null,
      s.backtestWinRate ?? null,
      s.backtestTradeCount ?? null,
      s.backtestSharpe ?? null,
      s.backtestDetailJson ?? null
    )
    .run();
  return meta.last_row_id;
}

export async function getSignalById(env, signalId) {
  return env.DB.prepare("SELECT * FROM signals WHERE id = ?").bind(signalId).first();
}

/** All currently-open signals, oldest first. Used once per cron tick. */
export async function getOpenSignals(env) {
  const { results } = await env.DB.prepare("SELECT * FROM signals WHERE status = 'open' ORDER BY opened_at").all();
  return results;
}

/**
 * Resolves many signals in ONE round trip via D1's batch() API, instead of
 * one UPDATE per signal -- keeps the cron handler's subrequest count flat
 * regardless of how many signals close out in the same tick.
 * `resolutions` = [{ id, status, resolvedPrice }]
 */
export async function resolveSignalsBatch(env, resolutions) {
  if (resolutions.length === 0) return;
  const stmt = env.DB.prepare(
    "UPDATE signals SET status = ?, resolved_at = datetime('now'), resolved_price = ? WHERE id = ?"
  );
  await env.DB.batch(resolutions.map((r) => stmt.bind(r.status, r.resolvedPrice, r.id)));
}

// --- Stats (used by /stats) ----------------------------------------------

export async function getStats(env) {
  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status = 'hit_tp' THEN 1 ELSE 0 END) AS hit_tp,
       SUM(CASE WHEN status = 'hit_sl' THEN 1 ELSE 0 END) AS hit_sl,
       SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired
     FROM signals`
  ).first();

  const resolved = (totals.hit_tp ?? 0) + (totals.hit_sl ?? 0);
  const winRate = resolved > 0 ? (totals.hit_tp / resolved) * 100 : null;

  const byStrategy = await env.DB.prepare(
    `SELECT strategy_label,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'hit_tp' THEN 1 ELSE 0 END) AS hit_tp,
            SUM(CASE WHEN status = 'hit_sl' THEN 1 ELSE 0 END) AS hit_sl
     FROM signals
     WHERE status IN ('hit_tp', 'hit_sl')
     GROUP BY strategy_label
     ORDER BY total DESC`
  ).all();

  return { ...totals, winRate, byStrategy: byStrategy.results };
}
