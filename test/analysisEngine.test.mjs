import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAtrRisk,
  formatBacktestAnalysis,
  formatDecisionAnalysis,
  formatForecastAnalysis,
  formatMarketAnalysis,
  formatPositionSize,
  formatRiskReward,
} from "../src/analysisEngine.js";

function sampleCandles(count = 420, timeframeSeconds = 4 * 60 * 60) {
  const latest = Math.floor(Date.now() / 1000 / timeframeSeconds) * timeframeSeconds;
  return Array.from({ length: count }, (_, index) => {
    const trend = 28000 + index * 22;
    const wave = Math.sin(index / 7) * 520 + Math.cos(index / 19) * 210;
    const close = trend + wave;
    const open = close - Math.sin(index / 3) * 90;
    return {
      time: latest - (count - 1 - index) * timeframeSeconds,
      open,
      high: Math.max(open, close) + 140,
      low: Math.min(open, close) - 140,
      close,
      volume: 1000 + (index % 23) * 35,
    };
  });
}

test("all analysis engines return complete readable output without invalid numeric placeholders", () => {
  const candles = sampleCandles();
  const common = { symbol: "BTCUSDT", timeframe: "4h", days: 70, candles };
  const outputs = [
    formatMarketAnalysis(common),
    formatForecastAnalysis({ ...common, horizon: 24, sims: 300, method: "bootstrap", driftMode: "zero", blockSize: 5 }),
    formatDecisionAnalysis({ ...common, marketType: "futures", leverage: 10, accountSize: 5000, riskPercent: 1, fee: 0.1, slippage: 0.05 }),
    formatBacktestAnalysis({ ...common, mode: "single", strategyKey: "emaCrossover", direction: "both", leverage: 10, fee: 0.1, fill: "nextOpen", exitMode: "roi", stopLossPercent: 10, takeProfitPercent: 50, accountSize: 5000, riskPercent: 1 }),
    formatAtrRisk({ ...common, direction: "long", atrPeriod: 14, atrMultiplier: 2 }),
    formatPositionSize({ accountSize: 5000, riskPercent: 1, entryPrice: 100, stopPrice: 95 }),
    formatRiskReward({ entryPrice: 100, stopPrice: 95, targetPrice: 115 }),
  ];

  for (const output of outputs) {
    assert.equal(typeof output, "string");
    assert.ok(output.length > 80);
    assert.doesNotMatch(output, /\b(?:NaN|undefined|null)\b/);
  }
});

