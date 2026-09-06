-- lensa-signal-bot schema (Cloudflare D1 / SQLite)
--
-- Design note on `plans`: plans throttle USAGE (how often someone can ask
-- for a signal, how many open signals get tracked at once). They never
-- change which strategies get fit or how the decision is computed -- every
-- user gets the exact same backtest-and-decide pipeline. This was a
-- deliberate choice per your answer ("whatever you think is best, as long
-- as it doesn't lower signal quality").

CREATE TABLE IF NOT EXISTS admins (
  telegram_id INTEGER PRIMARY KEY,
  username    TEXT,
  added_by    INTEGER,                          -- telegram_id of the admin who added them; NULL for the bootstrap owner
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL UNIQUE,
  daily_signal_limit INTEGER,                   -- NULL = unlimited requests/day
  max_open_signals   INTEGER,                   -- NULL = unlimited concurrently-tracked open signals
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username    TEXT,
  plan_id     INTEGER NOT NULL DEFAULT 1 REFERENCES plans(id),
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  is_blocked  INTEGER NOT NULL DEFAULT 0
);

-- Holds the in-progress state of a user's /signal wizard (one row per user;
-- overwritten on each step, deleted on completion/cancel). Not a chat log --
-- just "where are they in the conversation right now".
CREATE TABLE IF NOT EXISTS sessions (
  telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
  step        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signal_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(telegram_id),
  symbol              TEXT NOT NULL,
  timeframe           TEXT NOT NULL,
  leverage            REAL NOT NULL,
  stop_loss_percent   REAL NOT NULL,
  take_profit_percent REAL NOT NULL,
  -- pending -> fitting (Workflow running) -> done | failed | no_profitable_strategy | flat
  -- (no_profitable_strategy: nothing beat 0% in backtest. flat: something did,
  -- but that strategy isn't in a long/short position on the latest candle.)
  status              TEXT NOT NULL DEFAULT 'pending',
  requested_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signals (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id               INTEGER NOT NULL REFERENCES signal_requests(id),
  user_id                  INTEGER NOT NULL REFERENCES users(telegram_id),
  symbol                   TEXT NOT NULL,
  timeframe                TEXT NOT NULL,
  leverage                 REAL NOT NULL,
  strategy_key             TEXT NOT NULL,
  strategy_label           TEXT NOT NULL,
  direction                TEXT NOT NULL,        -- 'long' | 'short'
  entry_price              REAL NOT NULL,
  stop_loss_price          REAL NOT NULL,
  take_profit_price        REAL NOT NULL,
  backtest_return_percent  REAL,
  backtest_win_rate        REAL,
  backtest_trade_count     INTEGER,
  backtest_sharpe          REAL,
  backtest_detail_json     TEXT,   -- extra stats (sortino, maxDD, profitFactor...) for the "جزئیات بیشتر" button
  status                   TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'hit_tp' | 'hit_sl' | 'expired'
  opened_at                TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at              TEXT,
  resolved_price           REAL
);

-- If you already ran the Phase 1 schema against a real D1 database, run
-- this once by hand (CREATE TABLE IF NOT EXISTS above won't add a column
-- to an existing table):
--   ALTER TABLE signals ADD COLUMN backtest_detail_json TEXT;

CREATE INDEX IF NOT EXISTS idx_signals_status        ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_user           ON signals(user_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_signal_requests_user   ON signal_requests(user_id, requested_at);

-- Seed plans. Tune the numbers freely -- this is just a sane starting point.
INSERT OR IGNORE INTO plans (id, name, daily_signal_limit, max_open_signals) VALUES
  (1, 'default',   5, 3),
  (2, 'unlimited', NULL, NULL);
