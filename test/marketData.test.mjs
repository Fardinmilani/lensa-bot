import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSymbol, fetchCandles, fetchCurrentPrice, MarketDataError } from "../src/marketData.js";

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

test("fetchCandles converts Binance's ms timestamps to seconds and parses numeric strings", async () => {
  // Real Binance kline row shape: [openTime, open, high, low, close, volume, closeTime, ...]
  const restore = mockFetchOnce(200, [
    [1735689600000, "50000.00", "50500.00", "49800.00", "50200.00", "123.456", 1735703999999, "0", 0, "0", "0", "0"],
    [1735704000000, "50200.00", "50900.00", "50100.00", "50700.00", "98.765", 1735718399999, "0", 0, "0", "0", "0"],
  ]);
  try {
    const candles = await fetchCandles("BTCUSDT", "4h", 2);
    assert.equal(candles.length, 2);
    assert.equal(candles[0].time, 1735689600); // ms / 1000, not left in ms
    assert.equal(candles[0].open, 50000);
    assert.equal(candles[0].close, 50200);
    assert.equal(candles[1].time, 1735704000);
    assert.equal(typeof candles[0].volume, "number");
  } finally {
    restore();
  }
});

test("fetchCandles rejects an unsupported timeframe before making a network call", async () => {
  await assert.rejects(() => fetchCandles("BTCUSDT", "7h", 300), MarketDataError);
});

test("fetchCandles surfaces Binance's own error message on a bad symbol", async () => {
  const restore = mockFetchOnce(400, { code: -1121, msg: "Invalid symbol." });
  try {
    await assert.rejects(() => fetchCandles("NOTREAL", "4h", 300), /Invalid symbol/);
  } finally {
    restore();
  }
});

test("fetchCurrentPrice parses the price as a number", async () => {
  const restore = mockFetchOnce(200, { symbol: "BTCUSDT", price: "67123.45" });
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
