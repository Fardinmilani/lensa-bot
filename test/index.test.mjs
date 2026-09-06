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
