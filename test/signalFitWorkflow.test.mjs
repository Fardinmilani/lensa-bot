import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Shim } from "./d1-shim.mjs";
import * as db from "../src/db.js";
import { SignalFitWorkflow } from "../src/workflows/signalFitWorkflow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function freshEnv() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(schema);
  return { DB: createD1Shim(sqliteDb), TELEGRAM_BOT_TOKEN: "fake" };
}

/** Runs step callbacks immediately, in order -- no persistence/replay (that's Cloudflare's infra, not this repo's). */
function fakeStep() {
  const names = [];
  return {
    names,
    async do(name, callback) {
      names.push(name);
      return callback();
    },
  };
}

function binanceKlines(n, { trendPercentPerCandle = 0.6, seed = 42 } = {}) {
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows = [];
  let price = 50000;
  let t = Date.now() - n * 4 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    const noise = (rand() - 0.5) * 0.01;
    const open = price;
    const close = open * (1 + trendPercentPerCandle / 100 + noise);
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    rows.push([t, String(open), String(high), String(low), String(close), "100", t + 4 * 3600 * 1000 - 1, "0", 0, "0", "0", "0"]);
    price = close;
    t += 4 * 3600 * 1000;
  }
  return rows;
}

function mockNetwork({ candleRows, telegramCalls = [] }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.binance.com/api/v3/klines")) {
      return new Response(JSON.stringify(candleRows), { status: 200 });
    }
    if (u.includes("api.telegram.org")) {
      telegramCalls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error("unexpected fetch in test: " + u);
  };
  return () => (globalThis.fetch = original);
}

test("happy path: a strategy is picked, a signal is saved and sent (when the winning strategy is actually in-position)", async () => {
  // A profitable backtest doesn't guarantee the winning strategy is
  // long/short on the exact last candle -- it can legitimately be flat
  // there (see notify-flat). Rather than assume one fixed seed lands on
  // "signal", try a few and fully validate the first one that does; this
  // also exercises "flat" along the way instead of hiding it.
  let signalSeenAtLeastOnce = false;

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const env = freshEnv();
    await db.getOrCreateUser(env, 555, "fardin");
    const requestId = await db.createSignalRequest(env, {
      userId: 555,
      symbol: "BTCUSDT",
      timeframe: "4h",
      leverage: 5,
      stopLossPercent: 2,
      takeProfitPercent: 5,
    });

    const telegramCalls = [];
    const restore = mockNetwork({
      candleRows: binanceKlines(300, { trendPercentPerCandle: 0.6, seed }),
      telegramCalls,
    });
    let result;
    try {
      const wf = new SignalFitWorkflow({}, env);
      const step = fakeStep();
      result = await wf.run(
        {
          payload: {
            requestId,
            userId: 555,
            chatId: 555,
            symbol: "BTCUSDT",
            timeframe: "4h",
            leverage: 5,
            stopLossPercent: 2,
            takeProfitPercent: 5,
          },
        },
        step
      );

      assert.ok(step.names.includes("fetch-candles"));
      assert.ok(step.names.filter((n) => n.startsWith("fit-")).length >= 15, "should run a step per non-benchmark strategy");
      assert.ok(step.names.includes("pick-best"));

      assert.ok(
        ["signal", "flat", "no_profitable_strategy"].includes(result.outcome),
        `unexpected outcome: ${result.outcome}`
      );

      if (result.outcome !== "signal") continue; // legitimate outcome, but doesn't exercise save-and-notify -- try another seed

      signalSeenAtLeastOnce = true;
      assert.ok(step.names.includes("decide"));
      assert.ok(step.names.includes("save-and-notify"));

      const req = await env.DB.prepare("SELECT status FROM signal_requests WHERE id = ?").bind(requestId).first();
      assert.equal(req.status, "done");

      const signal = await db.getSignalById(env, result.signalId);
      assert.equal(signal.symbol, "BTCUSDT");
      assert.ok(["long", "short"].includes(signal.direction));
      assert.equal(typeof signal.strategy_label, "string");
      assert.doesNotMatch(signal.strategy_label, /\[object Object\]/, "strategy.label is a {en,fa} object - must be unwrapped before storing/sending");
      assert.ok(signal.entry_price > 0);
      if (signal.direction === "long") {
        assert.ok(signal.stop_loss_price < signal.entry_price, "long stop-loss must sit below entry");
        assert.ok(signal.take_profit_price > signal.entry_price, "long take-profit must sit above entry");
      } else {
        assert.ok(signal.stop_loss_price > signal.entry_price, "short stop-loss must sit above entry");
        assert.ok(signal.take_profit_price < signal.entry_price, "short take-profit must sit below entry");
      }

      const sent = telegramCalls.find((c) => c.url.includes("sendMessage"));
      assert.ok(sent, "should have sent the signal message");
      assert.match(sent.body.text, /BTCUSDT/);
      assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data, `detail:${result.signalId}`);
      break;
    } finally {
      restore();
    }
  }

  assert.ok(signalSeenAtLeastOnce, "none of the tried seeds reached the 'signal' branch -- widen the seed list");
});

test("candle fetch failure marks the request failed and notifies the user, without running any fit steps", async () => {
  const env = freshEnv();
  await db.getOrCreateUser(env, 555, "fardin");
  const requestId = await db.createSignalRequest(env, {
    userId: 555,
    symbol: "NOTREAL",
    timeframe: "4h",
    leverage: 5,
    stopLossPercent: 2,
    takeProfitPercent: 5,
  });

  const telegramCalls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("klines")) return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
    if (u.includes("telegram")) {
      telegramCalls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + u);
  };
  try {
    const wf = new SignalFitWorkflow({}, env);
    const step = fakeStep();
    const result = await wf.run(
      { payload: { requestId, userId: 555, chatId: 555, symbol: "NOTREAL", timeframe: "4h", leverage: 5, stopLossPercent: 2, takeProfitPercent: 5 } },
      step
    );

    assert.equal(result.outcome, "fetch_failed");
    assert.ok(!step.names.some((n) => n.startsWith("fit-")), "must not attempt any strategy fit without candles");

    const req = await env.DB.prepare("SELECT status FROM signal_requests WHERE id = ?").bind(requestId).first();
    assert.equal(req.status, "failed");

    const sent = telegramCalls.find((c) => c.body?.text?.includes("NOTREAL"));
    assert.ok(sent, "user should be told the fetch failed");
  } finally {
    globalThis.fetch = original;
  }
});
