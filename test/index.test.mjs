import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Shim } from "./d1-shim.mjs";
import worker from "../src/index.js";
import * as db from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function freshEnv() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec(schema);
  return {
    DB: createD1Shim(sqliteDb),
    OWNER_TELEGRAM_ID: "999",
    TELEGRAM_BOT_TOKEN: "fake-token",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
  };
}

/** Collects ctx.waitUntil() promises so we can await them before asserting. */
function makeCtx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    settle: () => Promise.all(promises),
  };
}

/** Intercepts outbound fetch() calls (i.e. every Telegram API call) instead of hitting the network. */
function mockTelegramFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function mockTelegramFetchWithKucoinCandles(count = 220) {
  const calls = [];
  const original = globalThis.fetch;
  const step = 4 * 60 * 60;
  const latest = Math.floor(Date.now() / 1000 / step) * step;
  const rows = Array.from({ length: count }, (_, index) => {
    const time = latest - index * step;
    const base = 30000 + (count - index) * 18 + Math.sin(index / 5) * 240;
    const open = base - 30;
    const close = base + 30;
    return [String(time), String(open), String(close), String(base + 110), String(base - 110), String(100 + index), String((100 + index) * close)];
  });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("api.kucoin.com/api/v1/market/candles")) {
      return new Response(JSON.stringify({ code: "200000", data: rows }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    calls.push({ url: target, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function webhookRequest(update, secret = "test-secret") {
  return new Request("https://example.com/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  });
}

function makeMessage(text, { id = 999, username = "fardin" } = {}) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      from: { id, is_bot: false, first_name: "Test", username },
      chat: { id, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function makeCallback(data, { id = 999 } = {}) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    callback_query: {
      id: `callback-${Math.floor(Math.random() * 1e6)}`,
      from: { id, is_bot: false, first_name: "Test", username: id === 999 ? "fardin" : `user${id}` },
      message: { message_id: 1, chat: { id, type: "private" } },
      data,
    },
  };
}

test("GET requests get a plain liveness response, no side effects", async () => {
  const env = freshEnv();
  const res = await worker.fetch(new Request("https://example.com/", { method: "GET" }), env, makeCtx());
  assert.equal(res.status, 200);
});

test("wrong/missing webhook secret is rejected with 403", async () => {
  const env = freshEnv();
  const res = await worker.fetch(webhookRequest(makeMessage("/start"), "wrong-secret"), env, makeCtx());
  assert.equal(res.status, 403);
});

test("/start bootstraps the owner as admin and replies via sendMessage", async () => {
  const env = freshEnv();
  const ctx = makeCtx();
  const tg = mockTelegramFetch();
  try {
    const res = await worker.fetch(webhookRequest(makeMessage("/start")), env, ctx);
    assert.equal(res.status, 200);
    await ctx.settle();

    const sendCalls = tg.calls.filter((c) => c.url.includes("/sendMessage"));
    assert.equal(sendCalls.length, 1);
    assert.match(sendCalls[0].body.text, /خوش اومدی/);
    assert.ok(
      sendCalls[0].body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "menu:admin"),
      "the owner's first /start response should already contain the admin button"
    );
  } finally {
    tg.restore();
  }
});

test("owner (999) is auto-admin; a stranger running /stats gets refused", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    // Owner's first message bootstraps them as admin.
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start", { id: 999 })), env, ctx);
    await ctx.settle();

    // A different user tries an admin command.
    ctx = makeCtx();
    tg.calls.length = 0;
    await worker.fetch(webhookRequest(makeMessage("/stats", { id: 111, username: "stranger" })), env, ctx);
    await ctx.settle();
    const refusal = tg.calls.find((c) => c.url.includes("sendMessage"));
    assert.match(refusal.body.text, /فقط برای ادمین/);

    // The owner runs the same command and it goes through (no signals yet -> "هنوز هیچ سیگنالی").
    ctx = makeCtx();
    tg.calls.length = 0;
    await worker.fetch(webhookRequest(makeMessage("/stats", { id: 999 })), env, ctx);
    await ctx.settle();
    const ok = tg.calls.find((c) => c.url.includes("sendMessage"));
    assert.match(ok.body.text, /هنوز هیچ سیگنالی/);
  } finally {
    tg.restore();
  }
});

test("/addadmin by the owner actually grants admin rights to the target", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start", { id: 999 })), env, ctx);
    await ctx.settle();

    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/addadmin 222 newadmin", { id: 999 })), env, ctx);
    await ctx.settle();

    const row = await env.DB.prepare("SELECT 1 FROM admins WHERE telegram_id = 222").first();
    assert.ok(row, "target id should now be in the admins table");
  } finally {
    tg.restore();
  }
});

test("/admin exposes button flows for adding admins and changing plans", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start", { id: 999 })), env, ctx);
    await ctx.settle();

    for (const user of [
      { id: 222, username: "alice" },
      { id: 333, username: "bob" },
    ]) {
      ctx = makeCtx();
      await worker.fetch(webhookRequest(makeMessage("/start", user)), env, ctx);
      await ctx.settle();
    }

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/admin")), env, ctx);
    await ctx.settle();
    const menu = tg.calls.find((call) => call.url.includes("/sendMessage"));
    assert.ok(menu.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:addlist:0"));

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:addlist:0")), env, ctx);
    await ctx.settle();
    const addPicker = tg.calls.find((call) => call.url.includes("/editMessageText"));
    assert.ok(addPicker.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:addpick:222"));

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:addpick:222")), env, ctx);
    await ctx.settle();
    assert.equal(await dbIsAdmin(env, 222), true);

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:planlist:0")), env, ctx);
    await ctx.settle();
    const planPicker = tg.calls.find((call) => call.url.includes("/editMessageText"));
    assert.ok(planPicker.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:planuser:333"));

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:planuser:333")), env, ctx);
    await ctx.settle();
    const planButtons = tg.calls.find((call) => call.url.includes("/editMessageText"));
    assert.ok(planButtons.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:planpick:333:unlimited"));

    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:planpick:333:unlimited")), env, ctx);
    await ctx.settle();
    const user = await env.DB.prepare("SELECT plan_id FROM users WHERE telegram_id = 333").first();
    assert.equal(user.plan_id, 2);
  } finally {
    tg.restore();
  }
});

test("admin can add a user manually even when the known-user picker is empty", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start", { id: 999 })), env, ctx);
    await ctx.settle();

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:addlist:0")), env, ctx);
    await ctx.settle();
    const picker = tg.calls.find((call) => call.url.includes("/editMessageText"));
    assert.ok(picker.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:addmanual"));

    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:addmanual")), env, ctx);
    await ctx.settle();
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("444 @manual_user", { id: 999 })), env, ctx);
    await ctx.settle();
    assert.equal(await dbIsAdmin(env, 444), true);
  } finally {
    tg.restore();
  }
});

test("signal wizard is button-driven and asks for the backtest window", async () => {
  const env = freshEnv();
  const workflowCalls = [];
  env.SIGNAL_FIT_WORKFLOW = { create: async (input) => workflowCalls.push(input) };
  const tg = mockTelegramFetchWithKucoinCandles(400);
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start")), env, ctx);
    await ctx.settle();

    const tap = async (data) => {
      const callbackCtx = makeCtx();
      await worker.fetch(webhookRequest(makeCallback(data)), env, callbackCtx);
      await callbackCtx.settle();
    };

    tg.calls.length = 0;
    await tap("menu:signal");
    assert.ok(tg.calls.some((call) => call.body?.reply_markup?.inline_keyboard.flat().some((button) => button.callback_data === "wz:symbol:BTCUSDT")));
    await tap("wz:custom:symbol");
    assert.ok(tg.calls.at(-1).body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "wz:back"));
    await tap("wz:back");
    await tap("wz:symbol:BTCUSDT");
    await tap("wz:market:futures");
    await tap("wz:tf:1d");
    const daysPrompt = tg.calls.at(-1);
    assert.ok(daysPrompt.body.text.includes("چند روز اخیر"));
    assert.ok(daysPrompt.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "wz:days:365"));
    await tap("wz:days:365");
    assert.ok(tg.calls.at(-1).body.text.includes("منبع داده"));
    await tap("wz:back");
    assert.ok(tg.calls.at(-1).body.text.includes("چند روز اخیر"));
    await tap("wz:days:365");
    await tap("wz:source:kucoin");
    await tap("wz:dir:both");
    await tap("wz:lev:5");
    await tap("wz:fee:0.1");
    await tap("wz:fill:nextOpen");
    await tap("wz:exit:roi");
    await tap("wz:sl:10");
    await tap("wz:tp:50");
    await tap("wz:account:0");
    assert.equal(workflowCalls.length, 1);
    assert.equal(workflowCalls[0].params.operation, "fit");
    assert.equal(workflowCalls[0].params.symbol, "BTCUSDT");
    assert.equal(workflowCalls[0].params.timeframe, "1d");
    assert.equal(workflowCalls[0].params.backtestDays, 365);
    assert.equal(workflowCalls[0].params.marketType, "futures");
    assert.equal(workflowCalls[0].params.leverage, 5);
    assert.equal(workflowCalls[0].params.dataSource, "kucoin");
  } finally {
    tg.restore();
  }
});

test("fitted strategies are ranked by the user's criterion and finalized only after strategy selection", async () => {
  const env = freshEnv();
  const workflowCalls = [];
  env.SIGNAL_FIT_WORKFLOW = { create: async (input) => workflowCalls.push(input) };
  const tg = mockTelegramFetch();
  try {
    await db.getOrCreateUser(env, 999, "fardin");
    const requestId = await db.createSignalRequest(env, {
      userId: 999, symbol: "BTCUSDT", timeframe: "4h", leverage: 5, stopLossPercent: 10, takeProfitPercent: 50,
    });
    const base = { category: "trend", params: { period: 10 }, fit: { testedCount: 9, improved: true } };
    await db.saveSignalFitRun(env, {
      requestId,
      userId: 999,
      config: { requestId, userId: 999, chatId: 999, symbol: "BTCUSDT", timeframe: "4h", marketType: "futures", leverage: 5 },
      results: [
        { ...base, key: "smaCrossover", label: { fa: "استراتژی بازده" }, result: { totalReturnPercent: 40, sharpe: 0.5, winRate: 45, maxDrawdownPercent: 20, profitFactor: 1.2 } },
        { ...base, key: "emaCrossover", label: { fa: "استراتژی شارپ" }, result: { totalReturnPercent: 20, sharpe: 1.8, winRate: 60, maxDrawdownPercent: 8, profitFactor: 1.8 } },
      ],
    });

    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback(`fit:basis:${requestId}:sharpe`)), env, ctx);
    await ctx.settle();
    const ranking = tg.calls.find((call) => call.url.includes("editMessageText") || call.url.includes("sendMessage"));
    const buttons = ranking.body.reply_markup.inline_keyboard.flat();
    assert.match(buttons[0].text, /استراتژی شارپ/);

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback(`fit:strategy:${requestId}:emaCrossover`)), env, ctx);
    await ctx.settle();
    assert.equal(workflowCalls.length, 1);
    assert.equal(workflowCalls[0].params.operation, "finalize");
    assert.equal(workflowCalls[0].params.strategyKey, "emaCrossover");
  } finally {
    tg.restore();
  }
});

test("signal detail buttons cannot expose another user's signal", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    await db.getOrCreateUser(env, 999, "owner");
    const requestId = await db.createSignalRequest(env, {
      userId: 999, symbol: "BTCUSDT", timeframe: "4h", leverage: 1, stopLossPercent: 5, takeProfitPercent: 10,
    });
    const signalId = await db.saveSignal(env, {
      requestId, userId: 999, symbol: "BTCUSDT", timeframe: "4h", leverage: 1,
      strategyKey: "emaCrossover", strategyLabel: "EMA", direction: "long",
      entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110,
    });
    const ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback(`detail:${signalId}`, { id: 222 })), env, ctx);
    await ctx.settle();
    const sent = tg.calls.find((call) => call.url.includes("sendMessage"));
    assert.match(sent.body.text, /پیدا نشد/);
    assert.doesNotMatch(sent.body.text, /جزئیات/);
  } finally {
    tg.restore();
  }
});

test("every top-level, analysis-hub and automation-hub button produces a Telegram response", async () => {
  const env = freshEnv();
  env.SIGNAL_FIT_WORKFLOW = { create: async () => {} };
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start")), env, ctx);
    await ctx.settle();

    const callbacks = [
      "menu:home", "menu:signal", "menu:market", "menu:decision", "menu:forecast",
      "menu:backtest", "menu:risk", "menu:automation", "menu:news", "menu:about",
      "menu:myplan", "menu:plans", "menu:help", "menu:cancel", "menu:admin",
      "ana:hub", "ana:start:market", "ana:start:decision", "ana:start:forecast",
      "ana:start:backtest", "ana:start:risk_position", "ana:start:risk_atr", "ana:start:risk_rr",
      "auto:hub", "auto:watch", "auto:scan", "auto:alerts", "auto:alertadd",
      "auto:journal", "auto:journaladd", "auto:signals",
    ];

    for (const data of callbacks) {
      tg.calls.length = 0;
      ctx = makeCtx();
      await worker.fetch(webhookRequest(makeCallback(data)), env, ctx);
      await ctx.settle();
      assert.ok(tg.calls.some((call) => call.url.includes("answerCallbackQuery")), `${data} must acknowledge the click`);
      assert.ok(
        tg.calls.some((call) => call.url.includes("sendMessage") || call.url.includes("editMessageText")),
        `${data} must update or send a visible message`
      );
      assert.equal(tg.calls.some((call) => call.body?.text?.includes("اجرای این گزینه کامل نشد")), false, `${data} must not hit the global error fallback`);
    }
  } finally {
    tg.restore();
  }
});

test("automation add/delete button flows persist watchlist, alerts and journal", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start")), env, ctx);
    await ctx.settle();
    const tap = async (data) => {
      const callbackCtx = makeCtx();
      await worker.fetch(webhookRequest(makeCallback(data)), env, callbackCtx);
      await callbackCtx.settle();
    };
    const type = async (text) => {
      const messageCtx = makeCtx();
      await worker.fetch(webhookRequest(makeMessage(text)), env, messageCtx);
      await messageCtx.settle();
    };

    await tap("auto:watchadd");
    await tap("auto:watchpick:BTCUSDT");
    await tap("auto:back:watchsymbol");
    assert.ok(tg.calls.at(-1).body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "auto:watchpick:BTCUSDT"));
    await tap("auto:watchpick:BTCUSDT");
    await tap("auto:watchtf:4h");
    assert.equal((await db.listWatchlist(env, 999))[0].symbol, "BTCUSDT");

    await tap("auto:alertadd");
    await tap("auto:alertpick:ETHUSDT");
    await tap("auto:alertcondition:above");
    await type("5000");
    const alert = (await db.listPriceAlerts(env, 999))[0];
    assert.equal(alert.symbol, "ETHUSDT");
    assert.equal(alert.condition, "above");
    assert.equal(alert.level, 5000);

    await tap("auto:journaladd");
    await tap("auto:journalpick:none");
    await type("بررسی سناریوی ورود بعد از تأیید روند");
    const entry = (await db.listJournalEntries(env, 999))[0];
    assert.match(entry.note, /تأیید روند/);

    await tap(`auto:watchdel:BTCUSDT`);
    await tap(`auto:alertdel:${alert.id}`);
    await tap(`auto:journaldel:${entry.id}`);
    assert.equal((await db.listWatchlist(env, 999)).length, 0);
    assert.equal((await db.listPriceAlerts(env, 999)).length, 0);
    assert.equal((await db.listJournalEntries(env, 999)).length, 0);
  } finally {
    tg.restore();
  }
});

test("single-strategy backtest buttons execute only the selected strategy", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetchWithKucoinCandles();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start")), env, ctx);
    await ctx.settle();
    const tap = async (data) => {
      const callbackCtx = makeCtx();
      await worker.fetch(webhookRequest(makeCallback(data)), env, callbackCtx);
      await callbackCtx.settle();
    };

    await tap("ana:start:backtest");
    await tap("ana:set:symbol:BTCUSDT");
    await tap("ana:set:marketType:spot");
    await tap("ana:set:timeframe:4h");
    await tap("ana:set:days:30");
    await tap("ana:set:dataSource:kucoin");
    await tap("ana:back");
    assert.ok(tg.calls.at(-1).body.text.includes("منبع داده"));
    await tap("ana:set:dataSource:kucoin");
    await tap("ana:set:backtestMode:single");
    await tap("ana:set:strategyKey:emaCrossover");
    await tap("ana:set:fee:0.1");
    await tap("ana:set:fill:nextOpen");
    await tap("ana:set:exitMode:none");
    await tap("ana:set:accountSize:0");

    const report = tg.calls.find((call) => call.body?.text?.includes("بک‌تست کامل"));
    assert.ok(report, "the selected backtest must produce a final report");
    assert.match(report.body.text, /تقاطع EMA/);
    assert.doesNotMatch(report.body.text, /<b>2\./, "single mode must not silently run every strategy");
  } finally {
    tg.restore();
  }
});

test("secondary admins cannot add or remove admins through commands or stale buttons", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    let ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/start", { id: 999 })), env, ctx);
    await ctx.settle();
    await db.addAdmin(env, 222, 999, "secondary");

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/admin", { id: 222, username: "secondary" })), env, ctx);
    await ctx.settle();
    const menu = tg.calls.find((call) => call.url.includes("sendMessage"));
    const menuButtons = menu.body.reply_markup.inline_keyboard.flat();
    assert.equal(menuButtons.some((button) => button.callback_data === "adm:addlist:0"), false);

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:addlist:0", { id: 222 })), env, ctx);
    await ctx.settle();
    const deniedButton = tg.calls.find((call) => call.url.includes("answerCallbackQuery"));
    assert.equal(deniedButton.body.show_alert, true);
    assert.match(deniedButton.body.text, /مالک اصلی/);

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeMessage("/addadmin 333", { id: 222, username: "secondary" })), env, ctx);
    await ctx.settle();
    assert.equal(await dbIsAdmin(env, 333), false);
    assert.match(tg.calls.find((call) => call.url.includes("sendMessage")).body.text, /مالک اصلی/);

    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:removepick:999", { id: 999 })), env, ctx);
    await ctx.settle();
    assert.equal(await dbIsAdmin(env, 999), true, "the permanent owner must never be removable");
  } finally {
    tg.restore();
  }
});

test("callback failures always produce both an alert and a visible recovery message", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  env.DB = { prepare: () => { throw new Error("forced D1 outage"); } };
  try {
    const ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("menu:home")), env, ctx);
    await ctx.settle();
    const alert = tg.calls.find((call) => call.url.includes("answerCallbackQuery"));
    const recovery = tg.calls.find((call) => call.url.includes("sendMessage"));
    assert.equal(alert.body.show_alert, true);
    assert.match(recovery.body.text, /کامل نشد/);
  } finally {
    tg.restore();
  }
});

test("stale admin callbacks are rejected after the user loses admin access", async () => {
  const env = freshEnv();
  const tg = mockTelegramFetch();
  try {
    await dbAddAdmin(env, 222, 999, "alice");
    await dbRemoveAdmin(env, 222);
    const ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:menu", { id: 222 })), env, ctx);
    await ctx.settle();
    const answer = tg.calls.find((call) => call.url.includes("answerCallbackQuery"));
    assert.match(answer.body.text, /فقط برای ادمین/);
    assert.equal(tg.calls.filter((call) => call.url.includes("/sendMessage")).length, 0);
  } finally {
    tg.restore();
  }
});

async function dbIsAdmin(env, id) {
  const row = await env.DB.prepare("SELECT 1 FROM admins WHERE telegram_id = ?").bind(id).first();
  return Boolean(row);
}

async function dbAddAdmin(env, id, addedBy, username) {
  await env.DB.prepare("INSERT INTO admins (telegram_id, username, added_by) VALUES (?, ?, ?)").bind(id, username, addedBy).run();
}

async function dbRemoveAdmin(env, id) {
  await env.DB.prepare("DELETE FROM admins WHERE telegram_id = ?").bind(id).run();
}
