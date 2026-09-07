import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCandleQuality, assertUsableCandles } from "../src/dataQuality.js";

function candles(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000 + index * 3600,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10,
  }));
}

test("candle quality reports clean chronological data as excellent", () => {
  const rows = candles();
  const result = assessCandleQuality(rows, "1h", rows.at(-1).time + 3600);
  assert.equal(result.score, 100);
  assert.equal(result.invalid, 0);
  assert.equal(result.missing, 0);
});

test("unusable OHLC data is rejected before analysis", () => {
  const rows = candles();
  rows[10].high = rows[10].low - 1;
  assert.throws(() => assertUsableCandles(rows, "1h"), /کیفیت داده/);
});
