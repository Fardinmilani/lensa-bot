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
}) {
  const isFutures = leverage > 1 || direction !== "long";
  const signals = isFutures
    ? combineDirectionalSignals(strategy, candles, strategy.params, direction)
    : strategy.generateSignals(candles, strategy.params);
  const result = isFutures
    ? runLeveragedBacktest({ candles, signals, feePercent, leverage, riskParams, sizing, fillTiming })
    : runBacktest({ candles, signals, feePercent, riskParams, sizing, fillTiming });

  return { key, label: strategy.label, category: strategy.category, params: strategy.params, result };
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
