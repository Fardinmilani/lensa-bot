import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return db;
}

test("schema.sql executes without error", () => {
  assert.doesNotThrow(() => freshDb());
});

test("seed plans are present with expected shape", () => {
  const db = freshDb();
  const rows = db.prepare("SELECT id, name, daily_signal_limit, max_open_signals FROM plans ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "default");
  assert.equal(rows[0].daily_signal_limit, 5);
  assert.equal(rows[1].name, "unlimited");
  assert.equal(rows[1].daily_signal_limit, null);
});

test("users default to plan_id 1 when not specified", () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (telegram_id, username) VALUES (?, ?)").run(111, "fardin");
  const row = db.prepare("SELECT plan_id FROM users WHERE telegram_id = 111").get();
  assert.equal(row.plan_id, 1);
});

test("signals table accepts a full row and status defaults to open", () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (telegram_id) VALUES (?)").run(111);
  db.prepare(
    `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(111, "BTCUSDT", "4h", 5, 2, 5);
  const reqId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

  db.prepare(
    `INSERT INTO signals (request_id, user_id, symbol, timeframe, leverage, strategy_key, strategy_label,
       direction, entry_price, stop_loss_price, take_profit_price, backtest_return_percent, backtest_win_rate,
       backtest_trade_count, backtest_sharpe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(reqId, 111, "BTCUSDT", "4h", 5, "supertrend", "Supertrend", "long", 65000, 63700, 68250, 12.4, 0.58, 14, 1.1);

  const row = db.prepare("SELECT status FROM signals WHERE request_id = ?").get(reqId);
  assert.equal(row.status, "open");
});
