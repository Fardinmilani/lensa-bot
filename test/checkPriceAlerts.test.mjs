import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createD1Shim } from "./d1-shim.mjs";
import * as db from "../src/db.js";
import { checkPriceAlerts } from "../src/cron/checkPriceAlerts.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

test("price alert cron triggers a crossing once and persists its result", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const env = { DB: createD1Shim(sqlite), TELEGRAM_BOT_TOKEN: "fake" };
  await db.getOrCreateUser(env, 555, "user");
  const id = await db.createPriceAlert(env, { userId: 555, symbol: "BTCUSDT", condition: "above", level: 105, lastPrice: 100 });
  const telegram = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.includes("orderbook/level1")) return new Response(JSON.stringify({ code: "200000", data: { price: "106" } }), { status: 200 });
    if (value.includes("api.telegram.org")) {
      telegram.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    assert.deepEqual(await checkPriceAlerts(env), { checked: 1, triggered: 1 });
    const alert = (await db.listPriceAlerts(env, 555))[0];
    assert.equal(alert.id, id);
    assert.equal(alert.status, "triggered");
    assert.equal(telegram.length, 1);
    assert.deepEqual(await checkPriceAlerts(env), { checked: 0, triggered: 0 });
  } finally {
    globalThis.fetch = original;
  }
});
