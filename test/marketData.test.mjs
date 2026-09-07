import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSymbol, fetchCandles, fetchCurrentPrice, fetchCurrentPrices, MarketDataError } from "../src/marketData.js";

function mockFetchOnce(status, jsonBody) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(jsonBody), { status });
  return () => (globalThis.fetch = original);
}

test("normalizeSymbol appends USDT only when there's no known quote asset already", () => {
  assert.equal(normalizeSymbol("btc"), "BTCUSDT");
  assert.equal(normalizeSymbol("BTC"), "BTCUSDT");
  assert.equal(normalizeSymbol("btcusdt"), "BTCUSDT");
  assert.equal(normalizeSymbol("eth/usdt"), "ETHUSDT"); // punctuation stripped
  assert.equal(normalizeSymbol("solbusd"), "SOLBUSD");
});

test("fetchCandles parses KuCoin OHLC rows and keeps timestamps in seconds", async () => {
  // KuCoin row shape: [timestamp, open, close, high, low, volume, turnover]
  const restore = mockFetchOnce(200, { code: "200000", data: [
    ["1735704000", "50200.00", "50700.00", "50900.00", "50100.00", "98.765", "0"],
    ["1735689600", "50000.00", "50200.00", "50500.00", "49800.00", "123.456", "0"],
  ] });
  try {
    const candles = await fetchCandles("BTCUSDT", "4h", 2);
    assert.equal(candles.length, 2);
    assert.equal(candles[0].time, 1735689600);
    assert.equal(candles[0].open, 50000);
    assert.equal(candles[0].close, 50200);
    assert.equal(candles[0].high, 50500);
    assert.equal(candles[0].low, 49800);
    assert.equal(candles[1].time, 1735704000);
    assert.ok(candles[0].time < candles[1].time, "candles must be oldest-first for the backtester");
    assert.equal(typeof candles[0].volume, "number");
  } finally {
    restore();
  }
});

test("fetchCandles rejects an unsupported timeframe before making a network call", async () => {
  await assert.rejects(() => fetchCandles("BTCUSDT", "7h", 300), MarketDataError);
});

test("fetchCandles surfaces KuCoin's own error message on a bad symbol", async () => {
  const restore = mockFetchOnce(400, { code: "400100", msg: "Invalid symbol." });
  try {
    await assert.rejects(() => fetchCandles("NOTREAL", "4h", 300), /Invalid symbol/);
  } finally {
    restore();
  }
});

test("fetchCurrentPrice parses the price as a number", async () => {
  const restore = mockFetchOnce(200, { code: "200000", data: { price: "67123.45" } });
  try {
    const price = await fetchCurrentPrice("BTCUSDT");
    assert.equal(price, 67123.45);
    assert.equal(typeof price, "number");
  } finally {
    restore();
  }
});

test("fetchCandles turns an HTML/upstream response into a readable MarketDataError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!DOCTYPE html><html>temporarily unavailable</html>", {
    status: 503,
    headers: { "content-type": "text/html" },
  });
  try {
    await assert.rejects(
      () => fetchCandles("BTCUSDT", "4h", 300),
      (err) => err instanceof MarketDataError && /JSON معتبر نداد/.test(err.message) && !/Unexpected token/.test(err.message)
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchCandles falls back to Bitget when KuCoin is geo-blocked", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.kucoin.com")) return new Response("<!DOCTYPE html>blocked", { status: 403 });
    if (u.includes("api.bitget.com")) {
      return new Response(JSON.stringify({ code: "00000", data: [
        ["1735689600000", "100", "112", "99", "110", "10"],
        ["1735776000000", "110", "111", "103", "105", "11"],
        ["1735862400000", "105", "108", "102", "107", "12"],
      ] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const candles = await fetchCandles("BTCUSDT", "1d", 3);
    assert.equal(candles.length, 3);
    assert.equal(candles[0].open, 100);
    assert.equal(candles[1].close, 105);
    assert.equal(candles[2].volume, 12);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchCandles falls back when KuCoin returns HTML with HTTP 200", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.kucoin.com")) return new Response("<!DOCTYPE html>challenge", { status: 200 });
    if (u.includes("api.bitget.com")) return new Response(JSON.stringify({ code: "40017", msg: "blocked" }), { status: 503 });
    if (u.includes("api.coingecko.com/api/v3/coins/bitcoin/market_chart")) {
      return new Response(JSON.stringify({
        prices: [[1735689600000, 100], [1735776000000, 101], [1735862400000, 102]],
        total_volumes: [[1735689600000, 10], [1735776000000, 11], [1735862400000, 12]],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const candles = await fetchCandles("BTCUSDT", "1d", 3);
    assert.deepEqual(candles.map((c) => c.close), [100, 101, 102]);
  } finally {
    globalThis.fetch = original;
  }
});

test("current prices fall back to CoinGecko when KuCoin is geo-blocked", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.kucoin.com")) return new Response("<!DOCTYPE html>blocked", { status: 403 });
    if (u.includes("api.coingecko.com/api/v3/simple/price")) {
      return new Response(JSON.stringify({ bitcoin: { usd: 67123.45 }, ethereum: { usd: 3500 } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    assert.equal(await fetchCurrentPrice("BTCUSDT"), 67123.45);
    assert.deepEqual(await fetchCurrentPrices(["BTCUSDT", "ETHUSDT"]), { BTCUSDT: 67123.45, ETHUSDT: 3500 });
  } finally {
    globalThis.fetch = original;
  }
});
