import { test } from "node:test";
import assert from "node:assert/strict";
import { STRATEGIES } from "../src/lib/strategies.js";
import { runAllStrategies } from "../src/lib/backtest.js";
import { fitOneStrategy, pickBest } from "../src/lib/singleStrategyFit.js";

function genCandles(n, seed = 1, startPrice = 50000) {
  let s = seed;
  const rand = () => {
    // deterministic PRNG (mulberry32) so this test is reproducible
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const candles = [];
  let price = startPrice;
  let t = Math.floor(Date.now() / 1000) - n * 4 * 3600;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * 0.02;
    const open = price;
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + rand() * 0.005);
    const low = Math.min(open, close) * (1 - rand() * 0.005);
    candles.push({ time: t, open, high, low, close, volume: rand() * 1000 });
    price = close;
    t += 4 * 3600;
  }
  return candles;
}

const strategyEntries = Object.entries(STRATEGIES).filter(([, s]) => s.category !== "benchmark");

test("fitOneStrategy summed over all strategies matches runAllStrategies row-for-row", () => {
  const candles = genCandles(400);
  const leverage = 5;
  const direction = "both";
  const riskParams = { stopLossPercent: 2, takeProfitPercent: 5 };

  const combined = runAllStrategies({ candles, strategies: STRATEGIES, leverage, direction, riskParams });

  const perStrategyRows = strategyEntries.map(([key, strategy]) =>
    fitOneStrategy({ candles, key, strategy, leverage, direction, riskParams })
  );

  assert.equal(perStrategyRows.length, combined.rows.length);

  const byKeyFromCombined = Object.fromEntries(combined.rows.map((r) => [r.key, r]));
  for (const row of perStrategyRows) {
    const reference = byKeyFromCombined[row.key];
    assert.ok(reference, `strategy ${row.key} should exist in runAllStrategies output too`);
    assert.equal(
      row.result.totalReturnPercent.toFixed(8),
      reference.result.totalReturnPercent.toFixed(8),
      `totalReturnPercent mismatch for ${row.key}`
    );
    assert.equal(row.result.tradeCount, reference.result.tradeCount, `tradeCount mismatch for ${row.key}`);
  }
});

test("pickBest agrees with runAllStrategies' summary.best when profitable, and is null when nothing is profitable", () => {
  const candles = genCandles(400, 7);
  const combined = runAllStrategies({
    candles,
    strategies: STRATEGIES,
    leverage: 3,
    direction: "both",
    riskParams: { stopLossPercent: 2, takeProfitPercent: 5 },
  });
  const perStrategyRows = strategyEntries.map(([key, strategy]) =>
    fitOneStrategy({
      candles,
      key,
      strategy,
      leverage: 3,
      direction: "both",
      riskParams: { stopLossPercent: 2, takeProfitPercent: 5 },
    })
  );
  const best = pickBest(perStrategyRows);

  if (combined.summary.best && combined.summary.best.result.totalReturnPercent > 0) {
    assert.equal(best.key, combined.summary.best.key);
  } else {
    assert.equal(best, null);
  }
});

test("pickBest returns null on an all-losing set instead of picking 'least bad'", () => {
  const losingRows = [
    { key: "a", result: { totalReturnPercent: -5 } },
    { key: "b", result: { totalReturnPercent: -1 } },
  ];
  assert.equal(pickBest(losingRows), null);
});
