import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Shim } from "./d1-shim.mjs";
import * as db from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function freshEnv(ownerTelegramId = "999") {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(schema);
  return { DB: createD1Shim(sqliteDb), OWNER_TELEGRAM_ID: ownerTelegramId };
}

test("ensureBootstrapAdmin promotes the configured owner on first contact", async () => {
  const env = freshEnv("999");
  const promoted = await db.ensureBootstrapAdmin(env, 999, "fardin");
  assert.equal(promoted, true);
  assert.equal(await db.isAdmin(env, 999), true);
});

test("ensureBootstrapAdmin ignores non-owner ids", async () => {
  const env = freshEnv("999");
  const promoted = await db.ensureBootstrapAdmin(env, 111, "someone_else");
  assert.equal(promoted, false);
  assert.equal(await db.isAdmin(env, 111), false);
});

test("ensureBootstrapAdmin is a no-op once any admin exists", async () => {
  const env = freshEnv("999");
  await db.addAdmin(env, 111, null, "first_admin");
  const promoted = await db.ensureBootstrapAdmin(env, 999, "fardin");
  assert.equal(promoted, false, "owner should NOT be auto-added once the admin table is non-empty");
  assert.equal(await db.isAdmin(env, 999), false);
});

test("addAdmin / removeAdmin / listAdmins round-trip", async () => {
  const env = freshEnv();
  await db.addAdmin(env, 111, 999, "alice");
  await db.addAdmin(env, 222, 999, "bob");
  assert.equal(await db.isAdmin(env, 111), true);

  const admins = await db.listAdmins(env);
  assert.equal(admins.length, 2);

  const removed = await db.removeAdmin(env, 111);
  assert.equal(removed, true, "removeAdmin should report true when a row was actually deleted");
  assert.equal(await db.isAdmin(env, 111), false);

  const removedAgain = await db.removeAdmin(env, 111);
  assert.equal(removedAgain, false, "removing an id that isn't an admin should report false, not throw");
});

test("getOrCreateUser defaults to the 'default' plan and is idempotent", async () => {
  const env = freshEnv();
  const first = await db.getOrCreateUser(env, 555, "newuser");
  assert.equal(first.plan_name, "default");
  assert.equal(first.daily_signal_limit, 5);

  const second = await db.getOrCreateUser(env, 555, "newuser");
  assert.equal(second.telegram_id, first.telegram_id, "should not create a duplicate row");
});

test("setUserPlanByName moves a user to 'unlimited' and unknown plan names fail cleanly", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  assert.equal(await db.setUserPlanByName(env, 555, "unlimited"), true);
  const user = await db.getUserWithPlan(env, 555);
  assert.equal(user.plan_name, "unlimited");
  assert.equal(user.daily_signal_limit, null);

  assert.equal(await db.setUserPlanByName(env, 555, "does_not_exist"), false);
});

test("checkRateLimit blocks once the default plan's daily limit is reached", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  for (let i = 0; i < 5; i++) {
    await env.DB.prepare(
      `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent)
       VALUES (?, 'BTCUSDT', '4h', 5, 2, 5)`
    )
      .bind(555)
      .run();
  }
  const result = await db.checkRateLimit(env, 555);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "daily_limit");
});

test("checkRateLimit allows unlimited-plan users past the default cap", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  await db.setUserPlanByName(env, 555, "unlimited");
  for (let i = 0; i < 20; i++) {
    await env.DB.prepare(
      `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent)
       VALUES (?, 'BTCUSDT', '4h', 5, 2, 5)`
    )
      .bind(555)
      .run();
  }
  const result = await db.checkRateLimit(env, 555);
  assert.equal(result.allowed, true);
});

test("checkRateLimit blocks once max_open_signals is reached even under the daily cap", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u"); // default plan: max_open_signals = 3
  for (let i = 0; i < 3; i++) {
    const req = await env.DB.prepare(
      `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent)
       VALUES (?, 'BTCUSDT', '4h', 5, 2, 5)`
    )
      .bind(555)
      .run();
    await env.DB.prepare(
      `INSERT INTO signals (request_id, user_id, symbol, timeframe, leverage, strategy_key, strategy_label,
         direction, entry_price, stop_loss_price, take_profit_price)
       VALUES (?, ?, 'BTCUSDT', '4h', 5, 'supertrend', 'Supertrend', 'long', 100, 98, 105)`
    )
      .bind(req.meta.last_row_id, 555)
      .run();
  }
  const result = await db.checkRateLimit(env, 555);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "open_limit");
});

test("session get/set/clear round-trips through the wizard steps", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u"); // sessions.telegram_id has a real FK to users
  assert.equal(await db.getSession(env, 555), null);

  await db.setSession(env, 555, "symbol", {});
  assert.deepEqual(await db.getSession(env, 555), { step: "symbol", data: {} });

  await db.setSession(env, 555, "timeframe", { symbol: "BTCUSDT" });
  assert.deepEqual(await db.getSession(env, 555), { step: "timeframe", data: { symbol: "BTCUSDT" } });

  await db.clearSession(env, 555);
  assert.equal(await db.getSession(env, 555), null);
});

test("createSignalRequest -> saveSignal -> getSignalById round-trip with real ids", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  const requestId = await db.createSignalRequest(env, {
    userId: 555,
    symbol: "BTCUSDT",
    timeframe: "4h",
    leverage: 5,
    stopLossPercent: 2,
    takeProfitPercent: 5,
  });
  assert.ok(requestId > 0);

  const signalId = await db.saveSignal(env, {
    requestId,
    userId: 555,
    symbol: "BTCUSDT",
    timeframe: "4h",
    leverage: 5,
    strategyKey: "supertrend",
    strategyLabel: "Supertrend",
    direction: "long",
    entryPrice: 65000,
    stopLossPrice: 63700,
    takeProfitPrice: 68250,
    backtestReturnPercent: 12.4,
    backtestWinRate: 58,
    backtestTradeCount: 14,
    backtestSharpe: 1.1,
    backtestDetailJson: JSON.stringify({ sortino: 1.4 }),
  });

  const signal = await db.getSignalById(env, signalId);
  assert.equal(signal.status, "open");
  assert.equal(signal.direction, "long");
  assert.equal(JSON.parse(signal.backtest_detail_json).sortino, 1.4);

  await db.updateSignalRequestStatus(env, requestId, "done");
  const req = await env.DB.prepare("SELECT status FROM signal_requests WHERE id = ?").bind(requestId).first();
  assert.equal(req.status, "done");
});

test("getOpenSignals + resolveSignalsBatch closes multiple signals in one call", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  const ids = [];
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const reqId = await db.createSignalRequest(env, {
      userId: 555,
      symbol,
      timeframe: "4h",
      leverage: 5,
      stopLossPercent: 2,
      takeProfitPercent: 5,
    });
    const id = await db.saveSignal(env, {
      requestId: reqId,
      userId: 555,
      symbol,
      timeframe: "4h",
      leverage: 5,
      strategyKey: "supertrend",
      strategyLabel: "Supertrend",
      direction: "long",
      entryPrice: 100,
      stopLossPrice: 98,
      takeProfitPrice: 105,
    });
    ids.push(id);
  }

  const open = await db.getOpenSignals(env);
  assert.equal(open.length, 3);

  await db.resolveSignalsBatch(env, [
    { id: ids[0], status: "hit_tp", resolvedPrice: 105.2 },
    { id: ids[1], status: "hit_sl", resolvedPrice: 97.8 },
    // ids[2] left open on purpose
  ]);

  const stillOpen = await db.getOpenSignals(env);
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0].id, ids[2]);

  const resolved0 = await db.getSignalById(env, ids[0]);
  assert.equal(resolved0.status, "hit_tp");
  assert.equal(resolved0.resolved_price, 105.2);
  assert.ok(resolved0.resolved_at);
});

test("getStats computes win rate from resolved signals only", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "u");
  const outcomes = ["hit_tp", "hit_tp", "hit_tp", "hit_sl", "open"];
  for (const status of outcomes) {
    const req = await env.DB.prepare(
      `INSERT INTO signal_requests (user_id, symbol, timeframe, leverage, stop_loss_percent, take_profit_percent)
       VALUES (?, 'BTCUSDT', '4h', 5, 2, 5)`
    )
      .bind(555)
      .run();
    await env.DB.prepare(
      `INSERT INTO signals (request_id, user_id, symbol, timeframe, leverage, strategy_key, strategy_label,
         direction, entry_price, stop_loss_price, take_profit_price, status)
       VALUES (?, ?, 'BTCUSDT', '4h', 5, 'supertrend', 'Supertrend', 'long', 100, 98, 105, ?)`
    )
      .bind(req.meta.last_row_id, 555, status)
      .run();
  }
  const stats = await db.getStats(env);
  assert.equal(stats.total, 5);
  assert.equal(stats.hit_tp, 3);
  assert.equal(stats.hit_sl, 1);
  assert.equal(stats.open_count, 1);
  assert.equal(stats.winRate, 75); // 3 / (3+1) * 100
});
