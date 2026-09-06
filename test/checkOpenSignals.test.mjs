import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Shim } from "./d1-shim.mjs";
import * as db from "../src/db.js";
import { checkOpenSignals } from "../src/cron/checkOpenSignals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function freshEnv() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(schema);
  return { DB: createD1Shim(sqliteDb), TELEGRAM_BOT_TOKEN: "fake" };
}

function mockBinancePrices(priceMap) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/sendMessage")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    // single-symbol shape
    const single = u.match(/symbol=([A-Z0-9]+)/);
    if (single) return new Response(JSON.stringify({ symbol: single[1], price: String(priceMap[single[1]]) }), { status: 200 });
    // batched shape
    const symbols = Object.keys(priceMap).map((s) => ({ symbol: s, price: String(priceMap[s]) }));
    return new Response(JSON.stringify(symbols), { status: 200 });
  };
  return () => (globalThis.fetch = original);
}

async function seedSignal(env, { symbol = "BTCUSDT", direction = "long", entry = 100, sl = 98, tp = 105 } = {}) {
  await db.getOrCreateUser(env, 555, "u");
  const reqId = await db.createSignalRequest(env, {
    userId: 555,
    symbol,
    timeframe: "4h",
    leverage: 5,
    stopLossPercent: 2,
    takeProfitPercent: 5,
  });
  return db.saveSignal(env, {
    requestId: reqId,
    userId: 555,
    symbol,
    timeframe: "4h",
    leverage: 5,
    strategyKey: "supertrend",
    strategyLabel: "Supertrend",
    direction,
    entryPrice: entry,
    stopLossPrice: sl,
    takeProfitPrice: tp,
  });
}

test("no open signals -> early return, no network calls", async () => {
  const env = freshEnv();
  const restore = mockBinancePrices({});
  try {
    const result = await checkOpenSignals(env);
    assert.deepEqual(result, { checked: 0, resolved: 0 });
  } finally {
    restore();
  }
});

test("long signal resolves hit_tp when price rises past take_profit_price", async () => {
  const env = freshEnv();
  const id = await seedSignal(env, { direction: "long", entry: 100, sl: 98, tp: 105 });
  const restore = mockBinancePrices({ BTCUSDT: 106 });
  try {
    const result = await checkOpenSignals(env);
    assert.equal(result.resolved, 1);
    const signal = await db.getSignalById(env, id);
    assert.equal(signal.status, "hit_tp");
    assert.equal(signal.resolved_price, 106);
  } finally {
    restore();
  }
});

test("long signal resolves hit_sl when price falls past stop_loss_price", async () => {
  const env = freshEnv();
  const id = await seedSignal(env, { direction: "long", entry: 100, sl: 98, tp: 105 });
  const restore = mockBinancePrices({ BTCUSDT: 97 });
  try {
    await checkOpenSignals(env);
    const signal = await db.getSignalById(env, id);
    assert.equal(signal.status, "hit_sl");
  } finally {
    restore();
  }
});

test("short signal: price falling hits take-profit, price rising hits stop-loss (inverted vs long)", async () => {
  const env = freshEnv();
  const tpId = await seedSignal(env, { symbol: "ETHUSDT", direction: "short", entry: 100, sl: 102, tp: 95 });
  const slId = await seedSignal(env, { symbol: "SOLUSDT", direction: "short", entry: 100, sl: 102, tp: 95 });
  const restore = mockBinancePrices({ ETHUSDT: 94, SOLUSDT: 103 });
  try {
    await checkOpenSignals(env);
    assert.equal((await db.getSignalById(env, tpId)).status, "hit_tp");
    assert.equal((await db.getSignalById(env, slId)).status, "hit_sl");
  } finally {
    restore();
  }
});

test("signal between SL and TP stays open", async () => {
  const env = freshEnv();
  const id = await seedSignal(env, { direction: "long", entry: 100, sl: 98, tp: 105 });
  const restore = mockBinancePrices({ BTCUSDT: 101 });
  try {
    const result = await checkOpenSignals(env);
    assert.equal(result.resolved, 0);
    assert.equal((await db.getSignalById(env, id)).status, "open");
  } finally {
    restore();
  }
});

test("multiple open signals on the same symbol only need one price for both", async () => {
  const env = freshEnv();
  const a = await seedSignal(env, { symbol: "BTCUSDT", direction: "long", entry: 100, sl: 98, tp: 105 });
  const b = await seedSignal(env, { symbol: "BTCUSDT", direction: "long", entry: 90, sl: 88, tp: 95 });
  const restore = mockBinancePrices({ BTCUSDT: 106 });
  try {
    const result = await checkOpenSignals(env);
    assert.equal(result.resolved, 2); // both cross their (different) take-profits at 106
    assert.equal((await db.getSignalById(env, a)).status, "hit_tp");
    assert.equal((await db.getSignalById(env, b)).status, "hit_tp");
  } finally {
    restore();
  }
});
