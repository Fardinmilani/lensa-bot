import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createD1Shim } from "./d1-shim.mjs";
import worker from "../src/index.js";

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
    const addPicker = tg.calls.find((call) => call.url.includes("/sendMessage"));
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
    const planPicker = tg.calls.find((call) => call.url.includes("/sendMessage"));
    assert.ok(planPicker.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "adm:planuser:333"));

    tg.calls.length = 0;
    ctx = makeCtx();
    await worker.fetch(webhookRequest(makeCallback("adm:planuser:333")), env, ctx);
    await ctx.settle();
    const planButtons = tg.calls.find((call) => call.url.includes("/sendMessage"));
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

test("signal wizard is button-driven and asks for the backtest window", async () => {
  const env = freshEnv();
  const workflowCalls = [];
  env.SIGNAL_FIT_WORKFLOW = { create: async (input) => workflowCalls.push(input) };
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

    tg.calls.length = 0;
    await tap("menu:signal");
    assert.ok(tg.calls.some((call) => call.body?.reply_markup?.inline_keyboard.flat().some((button) => button.callback_data === "wz:symbol:BTCUSDT")));
    await tap("wz:symbol:BTCUSDT");
    await tap("wz:tf:1d");
    await tap("wz:lev:5");
    await tap("wz:sl:2");
    await tap("wz:tp:5");

    const daysPrompt = tg.calls.at(-1);
    assert.ok(daysPrompt.body.text.includes("چند روز اخیر"));
    assert.ok(daysPrompt.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "wz:days:365"));

    await tap("wz:days:365");
    assert.equal(workflowCalls.length, 1);
    assert.equal(workflowCalls[0].params.symbol, "BTCUSDT");
    assert.equal(workflowCalls[0].params.timeframe, "1d");
    assert.equal(workflowCalls[0].params.backtestDays, 365);
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
