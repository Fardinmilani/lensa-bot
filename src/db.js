// All D1 access lives here so commands/* stay free of SQL. Every function
// takes `env` (env.DB is the D1 binding configured in wrangler.toml).

// --- Admins ------------------------------------------------------------

/**
 * Self-bootstrapping: the very first time the account named in
 * OWNER_TELEGRAM_ID (wrangler.toml) talks to the bot, and the admins table
 * is still empty, they're auto-promoted. After that this is a no-op --
 * admins are managed with /addadmin and /removeadmin from then on.
 */
export async function ensureBootstrapAdmin(env, telegramId, username) {
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM admins").first();
  if (count > 0) return false;
  if (String(telegramId) !== String(env.OWNER_TELEGRAM_ID)) return false;
  await env.DB.prepare("INSERT INTO admins (telegram_id, username, added_by) VALUES (?, ?, NULL)")
    .bind(telegramId, username ?? null)
    .run();
  return true;
}

export async function isAdmin(env, telegramId) {
  const row = await env.DB.prepare("SELECT 1 FROM admins WHERE telegram_id = ?").bind(telegramId).first();
  return Boolean(row);
}

export async function addAdmin(env, telegramId, addedBy, username) {
  await env.DB.prepare("INSERT OR IGNORE INTO admins (telegram_id, username, added_by) VALUES (?, ?, ?)")
    .bind(telegramId, username ?? null, addedBy)
    .run();
}

export async function removeAdmin(env, telegramId) {
  const { meta } = await env.DB.prepare("DELETE FROM admins WHERE telegram_id = ?").bind(telegramId).run();
  return meta.changes > 0;
}

export async function listAdmins(env) {
  const { results } = await env.DB.prepare("SELECT telegram_id, username, added_at FROM admins ORDER BY added_at").all();
  return results;
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
