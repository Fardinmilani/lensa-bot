// Vendored verbatim from lensa-crypto-dashboard (src/lib/risk.js) on 2026-08-18.
// Pure computation, no browser deps -- keep this file byte-identical to the
// dashboard's copy when you sync changes, so bot signals always match what
// the dashboard's Backtest/Decision Center pages would show.

// lib/risk.js
// Pure, transparent formulas. No predictions, no signals — just the math
// a trader would otherwise do by hand. Every function here is a known,
// textbook risk-management formula; nothing here guesses market direction.

/**
 * Position size based on fixed fractional risk.
 * "How many units can I buy if I'm only willing to risk X% of my account
 * on this trade, given my stop-loss distance?"
 */
export function positionSize({ accountSize, riskPercent, entryPrice, stopPrice }) {
  if (entryPrice <= 0 || stopPrice <= 0 || entryPrice === stopPrice) {
    return { error: "قیمت ورود و حد ضرر باید معتبر و متفاوت باشند." };
  }
  const riskAmount = accountSize * (riskPercent / 100);
  const perUnitRisk = Math.abs(entryPrice - stopPrice);
  const units = riskAmount / perUnitRisk;
  const positionValue = units * entryPrice;

  return {
    riskAmount,
    perUnitRisk,
    units,
    positionValue,
    positionPercentOfAccount: (positionValue / accountSize) * 100,
  };
}

/**
 * Average True Range — standard volatility measure used to set
 * stop-loss distances that respect the asset's recent volatility
 * rather than an arbitrary percentage.
 * @param {{high:number, low:number, close:number}[]} candles
 * @param {number} period default 14 (standard)
 */
export function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trueRanges.push(tr);
  }

  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

/**
 * Suggests a stop-loss distance using an ATR multiple — a common,
 * volatility-adjusted approach (vs. an arbitrary fixed %).
 */
export function atrStopSuggestion({ entryPrice, atr, multiplier = 2, direction = "long" }) {
  if (!atr) return null;
  const distance = atr * multiplier;
  const stopPrice = direction === "long" ? entryPrice - distance : entryPrice + distance;
  return { distance, stopPrice, multiplier };
}

/**
 * Risk-to-reward ratio for a planned trade.
 */
export function riskRewardRatio({ entryPrice, stopPrice, targetPrice }) {
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  if (risk === 0) return null;
  return reward / risk;
}

/**
 * Simple realized-volatility flag based on recent price series.
 * Returns a qualitative band, not a prediction of future moves.
 */
export function volatilityBand(prices) {
  if (prices.length < 2) return null;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualizedVolPercent = dailyVol * Math.sqrt(365) * 100;

  let band = "متوسط";
  if (annualizedVolPercent > 100) band = "بسیار بالا";
  else if (annualizedVolPercent > 70) band = "بالا";
  else if (annualizedVolPercent < 30) band = "پایین";

  return { annualizedVolPercent, band };
}
