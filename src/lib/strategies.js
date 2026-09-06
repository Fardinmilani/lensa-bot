// Vendored verbatim from lensa-crypto-dashboard (src/lib/strategies.js) on 2026-08-18.
// Pure computation, no browser deps -- keep this file byte-identical to the
// dashboard's copy when you sync changes, so bot signals always match what
// the dashboard's Backtest/Decision Center pages would show.

// lib/strategies.js
// Rule-based strategy definitions. These are textbook technical-analysis rules
// — deterministic functions of price history, not model predictions. The
// backtester applies them mechanically so results are reproducible/auditable.
//
// generateSignals(candles, params) — long signal: 1 = enter/hold long, 0 = flat.
//   Used as-is for Spot (which can only ever go long) and for the "Long only"
//   direction on futures.
//
// generateShortSignals(candles, params) — short signal: 1 = enter/hold short,
//   0 = flat. Optional; only meaningful for futures, where shorting is
//   possible. Each strategy below defines its own short rule as the
//   deliberate mirror-image of its long rule (e.g. "breaks below the lower
//   band" mirrors "breaks above the upper band") rather than a blind
//   inversion of the long signal — a strategy being flat is not the same
//   claim as a strategy actively expecting price to fall, so "not long" and
//   "should be short" are kept as distinct, separately-justified rules.
//   Strategies without a natural short counterpart (e.g. the Buy & Hold
//   benchmark) simply omit it.
//
// combineDirectionalSignals() below merges the two into a single -1/0/1
// position series according to the user's chosen direction mode.

import { monteCarlo } from "./forecast.js";

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = i < period - 1 ? null : prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const validFrom = macdLine.findIndex((v) => v != null);
  const compact = macdLine.slice(validFrom).map((v) => v ?? 0);
  const signalCompact = ema(compact, signal);
  const signalLine = new Array(values.length).fill(null);
  for (let i = 0; i < signalCompact.length; i++) {
    signalLine[validFrom + i] = signalCompact[i];
  }
  const hist = values.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sumSq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

export function roc(values, period = 10) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    out[i] = ((values[i] - values[i - period]) / values[i - period]) * 100;
  }
  return out;
}

/**
 * Average True Range, Wilder-smoothed (the standard definition — same
 * recursive smoothing style as the rsi() average gain/loss above, rather
 * than a plain SMA of true range). Used by Supertrend, Keltner Channel and
 * the ATR volatility-breakout strategy below as their volatility measure.
 */
export function atr(candles, period = 14) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
      continue;
    }
    const highLow = candles[i].high - candles[i].low;
    const highClose = Math.abs(candles[i].high - candles[i - 1].close);
    const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(highLow, highClose, lowClose);
  }
  const out = new Array(n).fill(null);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prevAtr = sum / period;
  out[period - 1] = prevAtr;
  for (let i = period; i < n; i++) {
    prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    out[i] = prevAtr;
  }
  return out;
}

/**
 * Rolling max/min over the *previous* `period` values (exclusive of the
 * current index), using a monotonic deque. This is the O(n) replacement for
 * repeatedly slicing the array and spreading into Math.max/Math.min at every
 * index, which is O(n * period) and allocates a short-lived array per index —
 * negligible on a few hundred candles, but a real bottleneck on tens of
 * thousands (e.g. low timeframes over a long lookback).
 * out[i] is null until i >= period (matching the "last N candles before i" window).
 */
export function rollingMaxExclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = []; // indices < current i, values decreasing front-to-back
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] < i - period) deque.shift();
    if (i >= period) out[i] = values[deque[0]];
    while (deque.length && values[deque[deque.length - 1]] <= values[i]) deque.pop();
    deque.push(i);
  }
  return out;
}

export function rollingMinExclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = []; // indices < current i, values increasing front-to-back
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] < i - period) deque.shift();
    if (i >= period) out[i] = values[deque[0]];
    while (deque.length && values[deque[deque.length - 1]] >= values[i]) deque.pop();
    deque.push(i);
  }
  return out;
}

/**
 * Same monotonic-deque technique as the "Exclusive" pair above, but the
 * window is [i - period + 1, i] — the current candle IS included. This is
 * the window definition Stochastic %K and Ichimoku's Tenkan/Kijun/Senkou-B
 * lines actually use ("highest high of the last N candles", today counts),
 * as opposed to Donchian's breakout rule which deliberately excludes today
 * (you can't "break" a level today's own candle contributed to).
 * out[i] is null until i >= period - 1.
 */
export function rollingMaxInclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] <= i - period) deque.shift();
    while (deque.length && values[deque[deque.length - 1]] <= values[i]) deque.pop();
    deque.push(i);
    if (i >= period - 1) out[i] = values[deque[0]];
  }
  return out;
}

export function rollingMinInclusive(values, period) {
  const out = new Array(values.length).fill(null);
  const deque = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length && deque[0] <= i - period) deque.shift();
    while (deque.length && values[deque[deque.length - 1]] >= values[i]) deque.pop();
    deque.push(i);
    if (i >= period - 1) out[i] = values[deque[0]];
  }
  return out;
}

/**
 * Stochastic %K (raw, unsmoothed) and %D (an SMA of %K). %K measures where
 * the current close sits within the last `kPeriod` candles' high/low range,
 * as a 0–100 percentage. Mirrors the macd() function's own "compact array"
 * trick above for the %D smoothing pass, since %K has a null run at the
 * start that a plain sma() call would otherwise treat as zeros.
 */
function stochasticKD(candles, kPeriod, dPeriod) {
  const highs = candles.map((x) => x.high);
  const lows = candles.map((x) => x.low);
  const closes = candles.map((x) => x.close);
  const hh = rollingMaxInclusive(highs, kPeriod);
  const ll = rollingMinInclusive(lows, kPeriod);
  const k = closes.map((c, i) => {
    if (hh[i] == null || ll[i] == null) return null;
    const range = hh[i] - ll[i];
    return range > 0 ? (100 * (c - ll[i])) / range : 50;
  });
  const validFrom = k.findIndex((v) => v != null);
  if (validFrom === -1) return { k, d: new Array(k.length).fill(null) };
  const compact = k.slice(validFrom).map((v) => v ?? 0);
  const dCompact = sma(compact, dPeriod);
  const d = new Array(k.length).fill(null);
  for (let i = 0; i < dCompact.length; i++) d[validFrom + i] = dCompact[i];
  return { k, d };
}

/**
 * Supertrend direction: 1 while price holds above the ATR trailing band
 * (uptrend), -1 while below (downtrend), null until ATR has enough history.
 * Standard formulation: a "basic" band is (hl2 ± mult·ATR) every candle,
 * a "final" band only ever tightens toward price (never loosens) while the
 * trend holds, and the trend flips the instant price closes through it —
 * at which point the final band on the *other* side becomes the new active
 * line. See e.g. Olivier Seban's original description of the indicator.
 */
function supertrendDirection(candles, p) {
  const n = candles.length;
  const atrVals = atr(candles, p.atrPeriod);
  const dir = new Array(n).fill(null);
  let prevFinalUpper = null;
  let prevFinalLower = null;
  let prevDir = null;

  for (let i = 0; i < n; i++) {
    if (atrVals[i] == null) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + p.atrMult * atrVals[i];
    const basicLower = mid - p.atrMult * atrVals[i];

    let finalUpper;
    let finalLower;
    if (prevFinalUpper == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      const prevClose = candles[i - 1].close;
      finalUpper = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
      finalLower = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;
    }

    let curDir;
    if (prevDir == null) curDir = candles[i].close >= finalLower ? 1 : -1;
    else if (prevDir === 1) curDir = candles[i].close < finalLower ? -1 : 1;
    else curDir = candles[i].close > finalUpper ? 1 : -1;

    dir[i] = curDir;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDir = curDir;
  }
  return dir;
}

/**
 * Ichimoku's three "line" values, plus the two raw Senkou spans (computed
 * as of each candle, BEFORE the standard forward displacement is applied).
 * The cloud actually visible at candle i was computed `kijunPeriod` candles
 * earlier and displaced forward — callers must look up
 * senkouARaw[i - kijunPeriod] / senkouBRaw[i - kijunPeriod] to read "the
 * cloud at candle i" without any lookahead. Chikou span (the lagging plot)
 * is intentionally omitted — it's a visual confirmation aid, not part of
 * the entry rule used here.
 */
function ichimokuLines(candles, p) {
  const highs = candles.map((x) => x.high);
  const lows = candles.map((x) => x.low);
  const tenkanHigh = rollingMaxInclusive(highs, p.tenkanPeriod);
  const tenkanLow = rollingMinInclusive(lows, p.tenkanPeriod);
  const kijunHigh = rollingMaxInclusive(highs, p.kijunPeriod);
  const kijunLow = rollingMinInclusive(lows, p.kijunPeriod);
  const senkouBHigh = rollingMaxInclusive(highs, p.senkouBPeriod);
  const senkouBLow = rollingMinInclusive(lows, p.senkouBPeriod);

  const n = candles.length;
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  const senkouARaw = new Array(n).fill(null);
  const senkouBRaw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (tenkanHigh[i] != null && tenkanLow[i] != null) tenkan[i] = (tenkanHigh[i] + tenkanLow[i]) / 2;
    if (kijunHigh[i] != null && kijunLow[i] != null) kijun[i] = (kijunHigh[i] + kijunLow[i]) / 2;
    if (tenkan[i] != null && kijun[i] != null) senkouARaw[i] = (tenkan[i] + kijun[i]) / 2;
    if (senkouBHigh[i] != null && senkouBLow[i] != null) senkouBRaw[i] = (senkouBHigh[i] + senkouBLow[i]) / 2;
  }
  return { tenkan, kijun, senkouARaw, senkouBRaw };
}

/**
 * Wilder's Parabolic SAR, direction only (1 = uptrend/long, -1 =
 * downtrend/short). Standard recursive algorithm: the SAR steps toward the
 * trend's extreme point (EP) each candle by an acceleration factor (AF)
 * that grows every time a new extreme is made, and the trend flips the
 * instant price crosses the SAR — at which point SAR resets to the prior
 * EP and AF resets to its starting value.
 */
function parabolicSarDirection(candles, p) {
  const n = candles.length;
  const dir = new Array(n).fill(null);
  if (n < 3) return dir;

  // Seed the trend from the first two candles; this only affects the
  // handful of bars before the recursion has settled into real data.
  let trend = candles[1].close >= candles[0].close ? "up" : "down";
  let ep = trend === "up" ? candles[1].high : candles[1].low;
  let sar = trend === "up" ? candles[0].low : candles[0].high;
  let af = p.afStart;
  dir[1] = trend === "up" ? 1 : -1;

  for (let i = 2; i < n; i++) {
    let nextSar = sar + af * (ep - sar);

    if (trend === "up") {
      // SAR can never sit above either of the last two candles' lows.
      nextSar = Math.min(nextSar, candles[i - 1].low, candles[i - 2].low);
      if (candles[i].low < nextSar) {
        trend = "down";
        nextSar = ep;
        ep = candles[i].low;
        af = p.afStart;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(af + p.afStep, p.afMax);
      }
    } else {
      nextSar = Math.max(nextSar, candles[i - 1].high, candles[i - 2].high);
      if (candles[i].high > nextSar) {
        trend = "up";
        nextSar = ep;
        ep = candles[i].high;
        af = p.afStart;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(af + p.afStep, p.afMax);
      }
    }

    sar = nextSar;
    dir[i] = trend === "up" ? 1 : -1;
  }
  return dir;
}

// Minimum bars of price history before the first Monte Carlo re-simulation
// is attempted — anything shorter doesn't give the bootstrap a meaningful
// return distribution to draw from.
const MC_MIN_HISTORY = 30;

// Caches the per-bar Monte Carlo probability-of-higher-price series, keyed
// by the candles array's own identity (a WeakMap, so entries are freed once
// the candles array itself is no longer referenced) plus a signature of the
// params that affect the simulation. combineDirectionalSignals() calls
// generateSignals and generateShortSignals as two separate passes over the
// same candles/params when direction is "both" — without this cache, each
// pass would independently re-run the full (expensive) Monte Carlo
// simulation across the whole candle range.
const mcProbCache = new WeakMap();

function monteCarloProbSeries(candles, p) {
  const sig = JSON.stringify({
    horizon: p.horizon,
    sims: p.sims,
    blockSize: p.blockSize,
    lookback: p.lookback,
    recalcEvery: p.recalcEvery,
    seed: p.seed,
  });
  const cached = mcProbCache.get(candles);
  if (cached && cached.sig === sig) return cached.series;

  const c = candles.map((x) => x.close);
  const series = new Array(c.length).fill(null);
  const recalcEvery = Math.max(1, Math.round(p.recalcEvery) || 1);
  let lastComputedAt = -Infinity;
  let lastProb = null;

  for (let i = 0; i < c.length; i++) {
    if (i < MC_MIN_HISTORY) continue;
    if (lastProb == null || i - lastComputedAt >= recalcEvery) {
      // Only data up to and including bar i feeds the simulation — this is
      // the same walk-forward discipline the rest of the app applies
      // elsewhere (see optimize.js's walkForwardValidate), so the strategy
      // never "sees" candles it wouldn't have had in real time.
      const start = p.lookback > 0 ? Math.max(0, i + 1 - p.lookback) : 0;
      const windowCloses = c.slice(start, i + 1);
      const mc = monteCarlo({
        closes: windowCloses,
        horizon: p.horizon,
        sims: p.sims,
        method: "blockBootstrap",
        blockSize: p.blockSize,
        seed: p.seed,
      });
      if (!mc.error) {
        lastProb = mc.probAboveCurrent;
        lastComputedAt = i;
      }
    }
    series[i] = lastProb;
  }

  mcProbCache.set(candles, { sig, series });
  return series;
}

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

export const STRATEGIES = {
  smaCrossover: {
    label: { en: "SMA Crossover", fa: "تقاطع میانگین متحرک (SMA)" },
    category: "trend",
    description: {
      en: "Goes long when the short-term moving average rises above the long-term one; exits on the reverse cross.",
      fa: "وقتی میانگین متحرک کوتاه‌مدت از بلندمدت بالاتر می‌رود لانگ باز می‌شود؛ در تقاطع معکوس بسته می‌شود.",
    },
    params: { fastPeriod: 10, slowPeriod: 30 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] > slow[i] ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] < slow[i] ? 1 : 0));
    },
  },

  emaCrossover: {
    label: { en: "EMA Crossover (faster)", fa: "تقاطع EMA (واکنش سریع‌تر)" },
    category: "trend",
    description: {
      en: "A faster-reacting moving-average cross using EMAs, which weight recent prices more — suited to lower timeframes.",
      fa: "نسخه‌ی واکنش‌سریع‌تر تقاطع میانگین؛ از EMA استفاده می‌کند که به قیمت‌های اخیر وزن بیشتری می‌دهد — مناسب تایم‌فریم پایین‌تر.",
    },
    params: { fastPeriod: 9, slowPeriod: 21 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] > slow[i] ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] < slow[i] ? 1 : 0));
    },
  },

  smaCrossover1226: {
    label: { en: "SMA 12/26 Crossover", fa: "تقاطع SMA ۱۲/۲۶" },
    category: "trend",
    description: {
      en: "The same SMA Crossover logic, fixed to the 12/26 pair — MACD's own fast/slow periods applied directly to price instead of to EMAs, for a steadier (more lagged) version of the same signal.",
      fa: "همان منطق تقاطع SMA، با پریودهای ثابت ۱۲/۲۶ — همان دوره‌های سریع/کند MACD، این‌بار مستقیم روی قیمت به‌جای EMA؛ سیگنالی پایدارتر (با تأخیر بیشتر).",
    },
    params: { fastPeriod: 12, slowPeriod: 26 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] > slow[i] ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = sma(c, p.fastPeriod);
      const slow = sma(c, p.slowPeriod);
      return c.map((_, i) => (fast[i] != null && slow[i] != null && fast[i] < slow[i] ? 1 : 0));
    },
  },

  rsiThreshold: {
    label: { en: "RSI Threshold (mean-reversion)", fa: "آستانه RSI (بازگشت به میانگین)" },
    category: "reversion",
    description: {
      en: "Enters when RSI drops below oversold and exits at overbought — a mean-reversion approach.",
      fa: "وقتی RSI زیر اشباع فروش می‌رود وارد می‌شود و در اشباع خرید خارج می‌شود — استراتژی بازگشت به میانگین.",
    },
    params: { period: 14, oversold: 30, overbought: 70 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.period);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null) continue;
        if (!inPos && r[i] < p.oversold) inPos = true;
        else if (inPos && r[i] > p.overbought) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.period);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null) continue;
        if (!inPos && r[i] > p.overbought) inPos = true;
        else if (inPos && r[i] < p.oversold) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  macdCross: {
    label: { en: "MACD Crossover", fa: "تقاطع MACD" },
    category: "momentum",
    description: {
      en: "Goes long when the MACD line crosses above its signal line, and flat on the reverse cross.",
      fa: "وقتی خط MACD از خط سیگنال بالاتر می‌رود لانگ، و در تقاطع معکوس فلت می‌شود.",
    },
    params: { fast: 12, slow: 26, signal: 9 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      return c.map((_, i) =>
        macdLine[i] != null && signalLine[i] != null && macdLine[i] > signalLine[i] ? 1 : 0
      );
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      return c.map((_, i) =>
        macdLine[i] != null && signalLine[i] != null && macdLine[i] < signalLine[i] ? 1 : 0
      );
    },
  },

  stochasticOscillator: {
    label: { en: "Stochastic Oscillator", fa: "نوسان‌گر استوکاستیک" },
    category: "momentum",
    description: {
      en: "The classic Lane stochastic: %K measures where the close sits within its recent high/low range, %D is a short SMA of %K. Enters long on a %K/%D cross up out of oversold, exits on a cross down out of overbought.",
      fa: "استوکاستیک کلاسیک لین: %K موقعیت قیمت بسته را در بازه‌ی سقف/کف اخیر نشان می‌دهد، %D میانگین کوتاه %K است. ورود لانگ با تقاطع صعودی %K/%D در ناحیه‌ی اشباع فروش، خروج با تقاطع نزولی در ناحیه‌ی اشباع خرید.",
    },
    params: { kPeriod: 14, dPeriod: 3, oversold: 20, overbought: 80 },
    generateSignals(candles, p) {
      const { k, d } = stochasticKD(candles, p.kPeriod, p.dPeriod);
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 1; i < candles.length; i++) {
        if (k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) {
          out[i] = inPos ? 1 : 0;
          continue;
        }
        const crossUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
        const crossDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
        if (!inPos && crossUp && k[i - 1] < p.oversold) inPos = true;
        else if (inPos && crossDown && k[i - 1] > p.overbought) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const { k, d } = stochasticKD(candles, p.kPeriod, p.dPeriod);
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 1; i < candles.length; i++) {
        if (k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) {
          out[i] = inPos ? 1 : 0;
          continue;
        }
        const crossDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
        const crossUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
        if (!inPos && crossDown && k[i - 1] > p.overbought) inPos = true;
        else if (inPos && crossUp && k[i - 1] < p.oversold) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  bollingerReversion: {
    label: { en: "Bollinger Reversion", fa: "بازگشت باند بولینگر" },
    category: "reversion",
    description: {
      en: "Enters when price closes below the lower band (oversold) and exits when it returns to the middle band.",
      fa: "وقتی قیمت زیر باند پایین بسته می‌شود (فروش افراطی) وارد می‌شود و در رسیدن به خط میانی خارج می‌شود.",
    },
    params: { period: 20, mult: 2 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, lower } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (lower[i] == null) continue;
        if (!inPos && c[i] < lower[i]) inPos = true;
        else if (inPos && c[i] >= mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, upper } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (upper[i] == null) continue;
        if (!inPos && c[i] > upper[i]) inPos = true;
        else if (inPos && c[i] <= mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  connorsRsi2: {
    label: { en: "Connors RSI(2) Mean Reversion", fa: "بازگشت به میانگین RSI(2) کانرز" },
    category: "reversion",
    description: {
      en: "Larry Connors' short-term mean-reversion rule from \"Short Term Trading Strategies That Work\": buy a sharp, short dip (a very fast RSI(2) below oversold) only while price is above a long-term trend filter — buying dips inside an uptrend, never a falling knife. Exits once RSI(2) recovers.",
      fa: "قانون بازگشت به میانگین کوتاه‌مدت لری کانرز از کتاب «استراتژی‌های معاملاتی کوتاه‌مدتی که کار می‌کنند»: خرید یک افت تند و کوتاه (RSI(2) بسیار سریع زیر اشباع فروش) فقط وقتی قیمت بالای فیلتر روند بلندمدت باشد — خرید افت داخل روند صعودی، نه چاقوی در حال سقوط. با بازگشت RSI(2) خروج می‌کند.",
    },
    params: { rsiPeriod: 2, oversold: 10, exitRsi: 70, trendPeriod: 200 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.rsiPeriod);
      const trend = sma(c, p.trendPeriod);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null || trend[i] == null) continue;
        if (!inPos && r[i] < p.oversold && c[i] > trend[i]) inPos = true;
        else if (inPos && r[i] > p.exitRsi) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = rsi(c, p.rsiPeriod);
      const trend = sma(c, p.trendPeriod);
      const overboughtMirror = 100 - p.oversold;
      const exitMirror = 100 - p.exitRsi;
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (r[i] == null || trend[i] == null) continue;
        if (!inPos && r[i] > overboughtMirror && c[i] < trend[i]) inPos = true;
        else if (inPos && r[i] < exitMirror) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  bollingerBreakout: {
    label: { en: "Bollinger Breakout", fa: "شکست باند بولینگر" },
    category: "trend",
    description: {
      en: "Enters an uptrend when price closes above the upper band and exits when it falls back below the middle band.",
      fa: "وقتی قیمت بالای باند بالایی بسته می‌شود وارد روند صعودی و وقتی زیر خط میانی برگردد خارج می‌شود.",
    },
    params: { period: 20, mult: 2 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, upper } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (upper[i] == null) continue;
        if (!inPos && c[i] > upper[i]) inPos = true;
        else if (inPos && c[i] < mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { mid, lower } = bollinger(c, p.period, p.mult);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (lower[i] == null) continue;
        if (!inPos && c[i] < lower[i]) inPos = true;
        else if (inPos && c[i] > mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  donchianBreakout: {
    label: { en: "Donchian Channel Breakout", fa: "شکست کانال دونچیان" },
    category: "trend",
    description: {
      en: "A classic trend-following system: breaking the highest high of the last N candles is entry; breaking the low is exit.",
      fa: "سیستم کلاسیک پیرو روند: شکست بالاترین سقف N کندل اخیر ورود، و شکست کف خروج است.",
    },
    params: { entryPeriod: 20, exitPeriod: 10 },
    generateSignals(candles, p) {
      const highs = candles.map((x) => x.high);
      const lows = candles.map((x) => x.low);
      const highN = rollingMaxExclusive(highs, p.entryPeriod);
      const lowM = rollingMinExclusive(lows, p.exitPeriod);
      // Original semantics: the exit window was Math.max(0, i - exitPeriod),
      // i.e. a growing window from the start of the array whenever
      // exitPeriod hadn't fully elapsed yet. rollingMinExclusive only starts
      // producing values once i >= exitPeriod, so backfill the early indices
      // (only reachable when exitPeriod > entryPeriod, since the main loop
      // below never looks at lowM before i = entryPeriod otherwise).
      let growingMin = Infinity;
      for (let i = 0; i < candles.length && i < p.exitPeriod; i++) {
        if (i > 0) growingMin = Math.min(growingMin, lows[i - 1]);
        lowM[i] = growingMin === Infinity ? lows[0] : growingMin;
      }
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 0; i < candles.length; i++) {
        if (i < p.entryPeriod) continue;
        if (!inPos && candles[i].close > highN[i]) inPos = true;
        else if (inPos && candles[i].close < lowM[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const highs = candles.map((x) => x.high);
      const lows = candles.map((x) => x.low);
      const lowN = rollingMinExclusive(lows, p.entryPeriod);
      const highM = rollingMaxExclusive(highs, p.exitPeriod);
      let growingMax = -Infinity;
      for (let i = 0; i < candles.length && i < p.exitPeriod; i++) {
        if (i > 0) growingMax = Math.max(growingMax, highs[i - 1]);
        highM[i] = growingMax === -Infinity ? highs[0] : growingMax;
      }
      const out = new Array(candles.length).fill(0);
      let inPos = false;
      for (let i = 0; i < candles.length; i++) {
        if (i < p.entryPeriod) continue;
        if (!inPos && candles[i].close < lowN[i]) inPos = true;
        else if (inPos && candles[i].close > highM[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  supertrend: {
    label: { en: "Supertrend", fa: "سوپرترند" },
    category: "trend",
    description: {
      en: "A volatility-adaptive trailing stop-and-reverse line built from ATR: long while price holds above the line, short while below. Extremely popular on crypto trading platforms/bots for its clean visual trend flips.",
      fa: "یک خط ایست‌ضرر/معکوس‌شونده وفق‌پذیر با نوسان که از ATR ساخته می‌شود: تا وقتی قیمت بالای خط بماند لانگ، زیر خط شورت. در پلتفرم‌ها/بات‌های معاملاتی کریپتو به‌خاطر تغییر روند بصری تمیزش بسیار محبوب است.",
    },
    params: { atrPeriod: 10, atrMult: 3 },
    generateSignals(candles, p) {
      const dir = supertrendDirection(candles, p);
      return dir.map((d) => (d === 1 ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const dir = supertrendDirection(candles, p);
      return dir.map((d) => (d === -1 ? 1 : 0));
    },
  },

  keltnerBreakout: {
    label: { en: "Keltner Channel Breakout", fa: "شکست کانال کلتنر" },
    category: "trend",
    description: {
      en: "Like Bollinger Breakout, but the channel is built from an EMA midline plus/minus an ATR multiple instead of a SMA plus/minus standard deviation — ATR reacts to volatility gaps and true range rather than just close-to-close spread.",
      fa: "مثل شکست بولینگر، ولی کانال از یک خط میانی EMA به‌علاوه/منهای ضریبی از ATR ساخته می‌شود، نه SMA به‌علاوه/منهای انحراف معیار — ATR به شکاف‌های نوسانی و دامنه‌ی واقعی واکنش نشان می‌دهد، نه فقط اختلاف قیمت بسته‌شدن‌ها.",
    },
    params: { emaPeriod: 20, atrPeriod: 10, atrMult: 2 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const mid = ema(c, p.emaPeriod);
      const atrVals = atr(candles, p.atrPeriod);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (mid[i] == null || atrVals[i] == null) continue;
        const upper = mid[i] + p.atrMult * atrVals[i];
        if (!inPos && c[i] > upper) inPos = true;
        else if (inPos && c[i] < mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const mid = ema(c, p.emaPeriod);
      const atrVals = atr(candles, p.atrPeriod);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 0; i < c.length; i++) {
        if (mid[i] == null || atrVals[i] == null) continue;
        const lower = mid[i] - p.atrMult * atrVals[i];
        if (!inPos && c[i] < lower) inPos = true;
        else if (inPos && c[i] > mid[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  ichimokuCloud: {
    label: { en: "Ichimoku Cloud (Tenkan/Kijun + Kumo filter)", fa: "ابر ایچیموکو (تقاطع تنکان/کیجون + فیلتر کومو)" },
    category: "trend",
    description: {
      en: "A simplified version of the Japanese Ichimoku system: long when the Tenkan-sen crosses above the Kijun-sen while price trades above the Kumo (cloud), short on the mirrored condition below the cloud. The cloud itself is read exactly as it would appear on the chart, using only data available as of each candle.",
      fa: "نسخه‌ی ساده‌شده‌ی سیستم ژاپنی ایچیموکو: لانگ وقتی تنکان‌سن از کیجون‌سن بالاتر برود و قیمت بالای ابر (کومو) باشد، شورت در حالت آینه‌ای زیر ابر. ابر دقیقاً همان‌طور خوانده می‌شود که روی چارت دیده می‌شود، فقط با داده‌ی در دسترس تا همان کندل.",
    },
    params: { tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52 },
    generateSignals(candles, p) {
      const { tenkan, kijun, senkouARaw, senkouBRaw } = ichimokuLines(candles, p);
      const out = new Array(candles.length).fill(0);
      for (let i = 0; i < candles.length; i++) {
        const cloudIdx = i - p.kijunPeriod;
        if (cloudIdx < 0 || tenkan[i] == null || kijun[i] == null) continue;
        const a = senkouARaw[cloudIdx];
        const b = senkouBRaw[cloudIdx];
        if (a == null || b == null) continue;
        const cloudBottom = Math.min(a, b);
        out[i] = tenkan[i] > kijun[i] && candles[i].close > cloudBottom ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const { tenkan, kijun, senkouARaw, senkouBRaw } = ichimokuLines(candles, p);
      const out = new Array(candles.length).fill(0);
      for (let i = 0; i < candles.length; i++) {
        const cloudIdx = i - p.kijunPeriod;
        if (cloudIdx < 0 || tenkan[i] == null || kijun[i] == null) continue;
        const a = senkouARaw[cloudIdx];
        const b = senkouBRaw[cloudIdx];
        if (a == null || b == null) continue;
        const cloudTop = Math.max(a, b);
        out[i] = tenkan[i] < kijun[i] && candles[i].close < cloudTop ? 1 : 0;
      }
      return out;
    },
  },

  parabolicSar: {
    label: { en: "Parabolic SAR", fa: "سار سهموی (Parabolic SAR)" },
    category: "trend",
    description: {
      en: "Wilder's original stop-and-reverse system: a trailing dot that accelerates toward price as a trend matures, and flips side the moment price crosses it — the flip itself is the entry/exit signal.",
      fa: "سیستم اصلی توقف-و-معکوس وایلدر: نقطه‌ای پیرو که هرچه روند بالغ‌تر شود سریع‌تر به قیمت نزدیک می‌شود و به‌محض عبور قیمت از آن طرف عوض می‌کند — همین تغییر طرف، سیگنال ورود/خروج است.",
    },
    params: { afStart: 0.02, afStep: 0.02, afMax: 0.2 },
    generateSignals(candles, p) {
      const dir = parabolicSarDirection(candles, p);
      return dir.map((d) => (d === 1 ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const dir = parabolicSarDirection(candles, p);
      return dir.map((d) => (d === -1 ? 1 : 0));
    },
  },

  momentum: {
    label: { en: "Momentum (Rate of Change)", fa: "مومنتوم (نرخ تغییر)" },
    category: "momentum",
    description: {
      en: "Stays long while the return over the last N candles is positive and above a threshold — simple trend-following.",
      fa: "اگر بازده N کندل اخیر مثبت و بالای آستانه باشد لانگ می‌ماند؛ سادگیِ پیرو روند.",
    },
    params: { period: 14, threshold: 0 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = roc(c, p.period);
      return c.map((_, i) => (r[i] != null && r[i] > p.threshold ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const r = roc(c, p.period);
      return c.map((_, i) => (r[i] != null && r[i] < -p.threshold ? 1 : 0));
    },
  },

  atrVolatilityBreakout: {
    label: { en: "ATR Volatility Breakout", fa: "شکست نوسانی ATR" },
    category: "momentum",
    description: {
      en: "A volatility-normalized version of a bar-to-bar breakout: goes long the instant one candle moves further than a multiple of ATR from the previous close, flips flat/short on the opposite move. Reacts only to genuine expansions in range, not to the fixed-percentage moves plain Momentum uses.",
      fa: "نسخه‌ی نوسان‌نرمال‌شده‌ی یک شکست کندل‌به‌کندل: به‌محض این‌که یک کندل بیش از چند برابر ATR از بسته‌شدن قبلی حرکت کند لانگ می‌شود، با حرکت معکوس فلت/شورت می‌شود. فقط به انبساط واقعی دامنه واکنش نشان می‌دهد، نه حرکت درصدی ثابتی که مومنتوم ساده استفاده می‌کند.",
    },
    params: { atrPeriod: 14, atrMult: 1 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const atrVals = atr(candles, p.atrPeriod);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 1; i < c.length; i++) {
        if (atrVals[i] == null) continue;
        const move = c[i] - c[i - 1];
        if (!inPos && move > p.atrMult * atrVals[i]) inPos = true;
        else if (inPos && move < -p.atrMult * atrVals[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const atrVals = atr(candles, p.atrPeriod);
      const out = new Array(c.length).fill(0);
      let inPos = false;
      for (let i = 1; i < c.length; i++) {
        if (atrVals[i] == null) continue;
        const move = c[i] - c[i - 1];
        if (!inPos && move < -p.atrMult * atrVals[i]) inPos = true;
        else if (inPos && move > p.atrMult * atrVals[i]) inPos = false;
        out[i] = inPos ? 1 : 0;
      }
      return out;
    },
  },

  /* --------------------- Hybrid / combined --------------------- */

  trendMomentumHybrid: {
    label: { en: "Hybrid: Trend + Momentum", fa: "ترکیبی: روند + مومنتوم" },
    category: "hybrid",
    description: {
      en: "Goes long only when the trend is up (fast EMA above slow) AND RSI confirms (above 50). The dual filter removes weak signals.",
      fa: "فقط زمانی لانگ می‌شود که هم روند صعودی باشد (EMA سریع بالای کند) و هم RSI تأیید کند (بالای ۵۰). فیلتر دوگانه سیگنال‌های ضعیف را حذف می‌کند.",
    },
    params: { fastPeriod: 9, slowPeriod: 21, rsiPeriod: 14, rsiFloor: 50 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (fast[i] == null || slow[i] == null || r[i] == null) return 0;
        return fast[i] > slow[i] && r[i] > p.rsiFloor ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const fast = ema(c, p.fastPeriod);
      const slow = ema(c, p.slowPeriod);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (fast[i] == null || slow[i] == null || r[i] == null) return 0;
        return fast[i] < slow[i] && r[i] < p.rsiFloor ? 1 : 0;
      });
    },
  },

  macdRsiHybrid: {
    label: { en: "Hybrid: MACD + RSI confirmation", fa: "ترکیبی: MACD + تأیید RSI" },
    category: "hybrid",
    description: {
      en: "A bullish MACD cross as the trigger, confirmed by RSI not being in oversold territory — fewer premature entries.",
      fa: "تقاطع صعودی MACD به‌عنوان ماشه، با تأیید RSI که در ناحیه‌ی فروش افراطی نباشد — کاهش ورودهای زودهنگام.",
    },
    params: { fast: 12, slow: 26, signal: 9, rsiPeriod: 14, rsiFloor: 45 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (macdLine[i] == null || signalLine[i] == null || r[i] == null) return 0;
        return macdLine[i] > signalLine[i] && r[i] > p.rsiFloor ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const { macdLine, signalLine } = macd(c, p.fast, p.slow, p.signal);
      const r = rsi(c, p.rsiPeriod);
      const rsiCeiling = 100 - p.rsiFloor;
      return c.map((_, i) => {
        if (macdLine[i] == null || signalLine[i] == null || r[i] == null) return 0;
        return macdLine[i] < signalLine[i] && r[i] < rsiCeiling ? 1 : 0;
      });
    },
  },

  tripleConfluence: {
    label: { en: "Hybrid: Triple Confluence", fa: "ترکیبی: هم‌گرایی سه‌گانه" },
    category: "hybrid",
    description: {
      en: "Enters only when three conditions align: trend (price above a long SMA), momentum (positive MACD) and a mid-range RSI. Conservative but high-quality.",
      fa: "ورود فقط با هم‌راستایی سه شرط: روند (قیمت بالای SMA بلند)، مومنتوم (MACD مثبت) و RSI میانه. محافظه‌کارانه ولی باکیفیت.",
    },
    params: { trendPeriod: 50, rsiPeriod: 14, rsiFloor: 48, rsiCap: 78 },
    generateSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const trend = sma(c, p.trendPeriod);
      const { hist } = macd(c, 12, 26, 9);
      const r = rsi(c, p.rsiPeriod);
      return c.map((_, i) => {
        if (trend[i] == null || hist[i] == null || r[i] == null) return 0;
        const trendOk = c[i] > trend[i];
        const momoOk = hist[i] > 0;
        const rsiOk = r[i] > p.rsiFloor && r[i] < p.rsiCap;
        return trendOk && momoOk && rsiOk ? 1 : 0;
      });
    },
    generateShortSignals(candles, p) {
      const c = candles.map((x) => x.close);
      const trend = sma(c, p.trendPeriod);
      const { hist } = macd(c, 12, 26, 9);
      const r = rsi(c, p.rsiPeriod);
      const rsiFloorMirror = 100 - p.rsiCap;
      const rsiCapMirror = 100 - p.rsiFloor;
      return c.map((_, i) => {
        if (trend[i] == null || hist[i] == null || r[i] == null) return 0;
        const trendOk = c[i] < trend[i];
        const momoOk = hist[i] < 0;
        const rsiOk = r[i] > rsiFloorMirror && r[i] < rsiCapMirror;
        return trendOk && momoOk && rsiOk ? 1 : 0;
      });
    },
  },

  /* --------------------- Quant / simulation-based --------------------- */

  monteCarloProbability: {
    label: { en: "Monte Carlo Probability", fa: "استراتژی احتمال مونت‌کارلو" },
    category: "quant",
    description: {
      en: "Turns this app's own Monte Carlo forecaster (the exact monteCarlo() engine behind the Forecast page — block-bootstrapped historical returns) into a trading rule instead of just a projection. At each recalculation point it re-simulates forward using only price data available up to that candle, then goes long while the simulated probability of a higher price clears a threshold, flat/short otherwise.",
      fa: "موتور مونت‌کارلوی همین ابزار (دقیقاً همان monteCarlo() که پشت صفحه‌ی پیش‌بینی است — بازده‌های تاریخی با بلوک-بوت‌استرپ) را به‌جای صرفاً یک نمودار پیش‌بینی، به یک قانون معاملاتی تبدیل می‌کند. در هر نقطه‌ی بازمحاسبه فقط با داده‌ی قیمتِ در دسترس تا همان کندل به جلو شبیه‌سازی می‌کند، سپس تا وقتی احتمال شبیه‌سازی‌شده‌ی صعود از آستانه بگذرد لانگ می‌ماند، در غیر این‌صورت فلت/شورت.",
    },
    params: {
      horizon: 10,
      sims: 300,
      blockSize: 5,
      lookback: 150,
      recalcEvery: 10,
      longThreshold: 0.55,
      shortThreshold: 0.45,
      seed: 12345,
    },
    generateSignals(candles, p) {
      const prob = monteCarloProbSeries(candles, p);
      return candles.map((_, i) => (prob[i] != null && prob[i] > p.longThreshold ? 1 : 0));
    },
    generateShortSignals(candles, p) {
      const prob = monteCarloProbSeries(candles, p);
      return candles.map((_, i) => (prob[i] != null && prob[i] < p.shortThreshold ? 1 : 0));
    },
  },

  buyAndHold: {
    label: { en: "Buy & Hold (Benchmark)", fa: "خرید و نگهداری (Benchmark)" },
    category: "benchmark",
    description: {
      en: "The comparison line: buy at the first candle and hold until the end of the range.",
      fa: "خط مقایسه: از کندل اول خریداری و تا پایان بازه نگه‌داری می‌شود.",
    },
    params: {},
    generateSignals(candles) {
      return candles.map(() => 1);
    },
  },
};

// Direction modes available for futures (Spot can only ever be "long").
// "both" requires the strategy to define generateShortSignals; if it
// doesn't, combineDirectionalSignals below silently falls back to long-only
// for that strategy rather than throwing, since some strategies legitimately
// have no natural short counterpart (the Buy & Hold benchmark).
export const DIRECTION_MODES = ["long", "short", "both"];

/**
 * Merge a strategy's long/short signal channels into a single position
 * series using -1 (short), 0 (flat), 1 (long), according to `direction`.
 * When both a long and short condition would otherwise be active on the
 * same candle (only possible for strategies whose long/short rules aren't
 * perfectly complementary), long takes priority and the short is dropped,
 * since holding both directions at once nets to a smaller position than
 * either alone and isn't a real trading decision.
 */
export function combineDirectionalSignals(strategy, candles, params, direction = "long") {
  const longSignals = strategy.generateSignals(candles, params);
  if (direction === "long") return longSignals;

  const hasShort = typeof strategy.generateShortSignals === "function";
  if (!hasShort) {
    // No short rule defined for this strategy: "short" mode has nothing to
    // produce (flat throughout), and "both" degrades to long-only.
    return direction === "short" ? longSignals.map(() => 0) : longSignals;
  }

  const shortSignals = strategy.generateShortSignals(candles, params);
  if (direction === "short") return shortSignals.map((s) => (s ? -1 : 0));

  // direction === "both"
  return longSignals.map((longOn, i) => {
    if (longOn) return 1;
    if (shortSignals[i]) return -1;
    return 0;
  });
}

/**
 * Describe where a strategy's signal stands *right now*, on the most
 * recent candle, rather than only summarizing its past performance.
 * This is what lets a user answer "given this strategy, should I be in a
 * position today?" instead of only "how would this strategy have done
 * historically?" — the backtest equity curve alone doesn't answer that.
 *
 * Returns null if there isn't enough data to produce a signal at all.
 */
export function currentSignalState(strategy, candles, params, direction = "long") {
  if (!candles || candles.length < 2) return null;
  const positions = combineDirectionalSignals(strategy, candles, params, direction);
  const last = positions[positions.length - 1];
  const state = last === 1 ? "long" : last === -1 ? "short" : "flat";

  let changedAtIndex = positions.length - 1;
  for (let i = positions.length - 2; i >= 0; i--) {
    if (positions[i] !== last) break;
    changedAtIndex = i;
  }
  const barsInState = positions.length - changedAtIndex;
  const changedAtTime = candles[changedAtIndex]?.time ?? null;
  const lastCandleTime = candles[candles.length - 1]?.time ?? null;

  return { state, barsInState, changedAtTime, lastCandleTime, lastClose: candles[candles.length - 1]?.close ?? null };
}

// Bilingual labels for tunable parameters.
export const PARAM_LABELS = {
  fastPeriod: { en: "Fast period", fa: "دوره سریع" },
  slowPeriod: { en: "Slow period", fa: "دوره کند" },
  period: { en: "Period", fa: "دوره" },
  oversold: { en: "Oversold", fa: "اشباع فروش" },
  overbought: { en: "Overbought", fa: "اشباع خرید" },
  fast: { en: "Fast EMA", fa: "EMA سریع" },
  slow: { en: "Slow EMA", fa: "EMA کند" },
  signal: { en: "Signal line", fa: "خط سیگنال" },
  mult: { en: "Std-dev multiple", fa: "ضریب انحراف" },
  entryPeriod: { en: "Entry period", fa: "دوره ورود" },
  exitPeriod: { en: "Exit period", fa: "دوره خروج" },
  threshold: { en: "Threshold", fa: "آستانه" },
  rsiPeriod: { en: "RSI period", fa: "دوره RSI" },
  rsiFloor: { en: "RSI floor", fa: "کف RSI" },
  rsiCap: { en: "RSI cap", fa: "سقف RSI" },
  trendPeriod: { en: "Trend period", fa: "دوره روند" },
  exitRsi: { en: "RSI exit level", fa: "سطح خروج RSI" },
  kPeriod: { en: "%K period", fa: "دوره %K" },
  dPeriod: { en: "%D period", fa: "دوره %D" },
  atrPeriod: { en: "ATR period", fa: "دوره ATR" },
  atrMult: { en: "ATR multiplier", fa: "ضریب ATR" },
  emaPeriod: { en: "EMA period", fa: "دوره EMA" },
  tenkanPeriod: { en: "Tenkan period", fa: "دوره تنکان" },
  kijunPeriod: { en: "Kijun period", fa: "دوره کیجون" },
  senkouBPeriod: { en: "Senkou B period", fa: "دوره سنکو B" },
  afStart: { en: "SAR starting step", fa: "گام شروع SAR" },
  afStep: { en: "SAR step increment", fa: "افزایش گام SAR" },
  afMax: { en: "SAR max step", fa: "حداکثر گام SAR" },
  horizon: { en: "Forecast horizon (candles)", fa: "افق پیش‌بینی (کندل)" },
  sims: { en: "Simulation paths", fa: "تعداد مسیرهای شبیه‌سازی" },
  blockSize: { en: "Bootstrap block size", fa: "اندازه بلوک بوت‌استرپ" },
  lookback: { en: "History window (candles)", fa: "پنجره تاریخچه (کندل)" },
  recalcEvery: { en: "Recalculate every (candles)", fa: "بازمحاسبه هر (کندل)" },
  longThreshold: { en: "Long probability threshold", fa: "آستانه احتمال لانگ" },
  shortThreshold: { en: "Short probability threshold", fa: "آستانه احتمال شورت" },
  seed: { en: "Random seed", fa: "دانه‌ی تصادفی" },
};
