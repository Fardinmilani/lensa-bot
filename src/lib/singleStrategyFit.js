// Mirrors runAllStrategies' per-strategy computation in backtest.js exactly
// (see that file's runAllStrategies for the reference implementation) but
// for ONE strategy at a time, so it can run inside a single Workflow step
// and stay under the Workers free-plan 10ms CPU budget. Keeping this in
// lockstep with runAllStrategies means a signal the bot gives always
// matches what the dashboard's own "Run all strategies" view would show
// for the same inputs -- see test/consistency.test.mjs.

import { combineDirectionalSignals } from "./strategies.js";
import { runBacktest, runLeveragedBacktest } from "./backtest.js";

export function fitOneStrategy({
  candles,
  key,
  strategy,
  feePercent = 0.1,
  leverage = 1,
  direction = "long",
  riskParams = null,
  sizing = null,
  fillTiming = "close",
  params = strategy.params,
}) {
  const isFutures = leverage > 1 || direction !== "long";
  const signals = isFutures
    ? combineDirectionalSignals(strategy, candles, params, direction)
    : strategy.generateSignals(candles, params);
  const result = isFutures
    ? runLeveragedBacktest({ candles, signals, feePercent, leverage, riskParams, sizing, fillTiming })
    : runBacktest({ candles, signals, feePercent, riskParams, sizing, fillTiming });

  return { key, label: strategy.label, description: strategy.description, category: strategy.category, params, result };
}

function fitScore(result) {
  if (!result || result.tradeCount < 3) return -Infinity;
  const riskAdjusted = Number.isFinite(result.sharpe) ? result.sharpe : (result.totalReturnPercent || 0) / 50;
  return riskAdjusted - ((result.maxDrawdownPercent || 0) / 100) * 1.5;
}

function candidateParams(defaultParams, maxCandidates) {
  const rows = [{ ...defaultParams }];
  for (const [name, value] of Object.entries(defaultParams)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const lower = name.toLowerCase();
    const percentLike = lower.includes("oversold") || lower.includes("overbought") || lower.includes("floor") || lower.includes("cap");
    const values = percentLike
      ? [value - 10, value - 5, value + 5, value + 10].map((v) => Math.max(1, Math.min(99, Math.round(v))))
      : [value * 0.6, value * 0.8, value * 1.2, value * 1.5].map((v) => Number.isInteger(value) ? Math.max(2, Math.round(v)) : Math.round(v * 100) / 100);
    for (const candidate of [...new Set(values)]) {
      rows.push({ ...defaultParams, [name]: candidate });
      if (rows.length >= maxCandidates) return rows;
    }
  }
  return rows;
}

/**
 * Bounded deterministic parameter fit for one Workflow step. It uses the
 * same scoring idea as the dashboard optimizer, while keeping the search
 * small enough that every strategy can be evaluated separately on Workers.
 */
export function fitOneStrategyOptimized(args, maxCandidates = 16) {
  const candidates = candidateParams(args.strategy.params || {}, maxCandidates);
  const useHoldout = args.candles.length >= 240;
  const split = useHoldout ? Math.floor(args.candles.length * 0.7) : args.candles.length;
  const trainingCandles = args.candles.slice(0, split);
  const testCandles = useHoldout ? args.candles.slice(split) : [];
  let best = null;
  let baseline = null;
  let testedCount = 0;
  for (const params of candidates) {
    try {
      const row = fitOneStrategy({ ...args, candles: trainingCandles, params });
      testedCount++;
      if (!baseline) baseline = row;
      if (!best || fitScore(row.result) > fitScore(best.result)) best = row;
    } catch {
      // Some parameter relationships are invalid after varying one side;
      // skip only that candidate, not the entire strategy.
    }
  }
  if (!best) throw new Error(`هیچ پارامتر معتبری برای ${args.key} فیت نشد.`);
  const finalRow = fitOneStrategy({ ...args, params: best.params });
  let validation = { available: false };
  if (useHoldout) {
    const fittedTest = fitOneStrategy({ ...args, candles: testCandles, params: best.params });
    const defaultTest = fitOneStrategy({ ...args, candles: testCandles, params: args.strategy.params });
    validation = {
      available: true,
      trainCandles: trainingCandles.length,
      testCandles: testCandles.length,
      fittedReturnPercent: fittedTest.result.totalReturnPercent,
      defaultReturnPercent: defaultTest.result.totalReturnPercent,
      passed: fittedTest.result.totalReturnPercent >= defaultTest.result.totalReturnPercent,
    };
  }
  return {
    ...finalRow,
    fit: {
      testedCount,
      improved: Boolean(baseline && JSON.stringify(best.params) !== JSON.stringify(baseline.params)),
      baselineReturnPercent: fitOneStrategy({ ...args, params: args.strategy.params }).result.totalReturnPercent,
      validation,
    },
  };
}

/**
 * strategy.label in the vendored strategies.js is a bilingual
 * `{ en, fa }` object (the dashboard is bilingual), not a plain string --
 * this bot is Persian-only, so pick .fa. Falls back gracefully for any
 * strategy whose label ever turns out to already be a plain string.
 */
export function labelText(label) {
  if (typeof label === "string") return label;
  return label?.fa ?? label?.en ?? String(label);
}

/**
 * Given fit rows (one per strategy, any order), returns the one that is
 * simultaneously highest-return AND positive -- or null if even the best
 * one lost money, in which case no signal should be issued this round.
 */
export function pickBest(rows) {
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);
  return sorted[0].result.totalReturnPercent > 0 ? sorted[0] : null;
}
