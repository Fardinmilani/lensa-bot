// Vendored verbatim from lensa-crypto-dashboard (src/lib/forecast.js) on 2026-08-18.
// Pure computation, no browser deps. Needed by strategies.js (monteCarloProbability).
// Keep byte-identical to the dashboard's copy when syncing.

// lib/forecast.js
// Probabilistic projection toolkit. NOTHING here predicts a single "right"
// price. Everything is a distribution of *possible* outcomes derived from the
// asset's own historical volatility — the honest way to talk about uncertainty.
//
// Techniques:
//   - Monte Carlo simulation (historical-bootstrap + parametric GBM)
//   - Per-step percentile cone (range projection over time)
//   - "Touch" probabilities (chance price reaches a level along the path)
//   - Probability-zoned outcome bands
//   - Probability-weighted risk/reward setups
//
// All of this is for education/analysis. It is not financial advice and the
// future can always fall outside any simulated range.

// Deterministic RNG so the same inputs yield the same simulation (reproducible).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box–Muller for parametric normal draws.
function randNormal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function std(a, m = mean(a)) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Run a Monte Carlo projection of price over `horizon` future periods.
 * @returns rich object with cone bands, final distribution, helpers.
 */
export function monteCarlo({
  closes,
  horizon = 30,
  sims = 2000,
  method = "bootstrap", // "bootstrap" | "blockBootstrap" | "gbm"
  driftMode = "historical", // "historical" | "zero"
  blockSize = 5,
  seed = 12345,
}) {
  const safeHorizon = Math.round(Number(horizon));
  const safeSims = Math.round(Number(sims));
  if (!Number.isFinite(safeHorizon) || safeHorizon < 1 || safeHorizon > 2000) {
    return { error: "افق شبیه‌سازی باید بین ۱ تا ۲۰۰۰ کندل باشد." };
  }
  if (!Number.isFinite(safeSims) || safeSims < 100 || safeSims > 20000) {
    return { error: "تعداد مسیرهای شبیه‌سازی باید بین ۱۰۰ تا ۲۰۰۰۰ باشد." };
  }
  const rets = logReturns(closes);
  if (rets.length < 5 || closes.length < 6) {
    return { error: "داده‌ی کافی برای شبیه‌سازی موجود نیست." };
  }
  const current = closes[closes.length - 1];
  const mu = driftMode === "zero" ? 0 : mean(rets);
  const sigma = std(rets);
  const rng = mulberry32(seed);
  const meanRet = mean(rets);
  // A block length longer than the available history degenerates to
  // ordinary single-point bootstrap (every "block" just wraps around).
  const safeBlockSize = Math.max(1, Math.min(Math.round(Number(blockSize)) || 5, rets.length));

  // Per-step collection for the percentile cone.
  const stepVals = Array.from({ length: safeHorizon }, () => new Array(safeSims));
  const paths = Array.from({ length: safeSims }, () => new Array(safeHorizon));
  const finals = new Array(safeSims);
  const maxes = new Array(safeSims);
  const mins = new Array(safeSims);

  for (let s = 0; s < safeSims; s++) {
    let price = current;
    let hi = current;
    let lo = current;
    // For blockBootstrap: draw a random starting index in the historical
    // return series, then consume `safeBlockSize` consecutive returns from
    // that point before drawing a fresh random start. Resampling
    // contiguous runs (instead of single, independent points) preserves
    // whatever autocorrelation/volatility-clustering existed historically
    // — e.g. a calm stretch tends to be followed by more calm, a violent
    // stretch by more violence — which plain single-point bootstrap
    // destroys by construction (every step becomes independent).
    let blockStart = 0;
    let blockPos = 0;
    for (let h = 0; h < safeHorizon; h++) {
      let r;
      if (method === "gbm") {
        r = mu + sigma * randNormal(rng);
      } else if (method === "blockBootstrap") {
        if (blockPos === 0) {
          const maxStart = Math.max(0, rets.length - safeBlockSize);
          blockStart = Math.floor(rng() * (maxStart + 1));
        }
        r = rets[Math.min(rets.length - 1, blockStart + blockPos)];
        if (driftMode === "zero") r -= meanRet;
        blockPos = (blockPos + 1) % safeBlockSize;
      } else {
        r = rets[Math.floor(rng() * rets.length)];
        if (driftMode === "zero") r -= meanRet; // de-mean bootstrap when drift is off
      }
      price *= Math.exp(r);
      if (price > hi) hi = price;
      if (price < lo) lo = price;
      stepVals[h][s] = price;
      paths[s][h] = price;
    }
    finals[s] = price;
    maxes[s] = hi;
    mins[s] = lo;
  }

  const cone = stepVals.map((arr, i) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      step: i + 1,
      p5: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    };
  });

  const sortedFinal = [...finals].sort((a, b) => a - b);
  const dist = {
    current,
    p5: percentile(sortedFinal, 0.05),
    p25: percentile(sortedFinal, 0.25),
    p50: percentile(sortedFinal, 0.5),
    p75: percentile(sortedFinal, 0.75),
    p95: percentile(sortedFinal, 0.95),
    expected: mean(finals),
  };

  const probAboveCurrent = finals.filter((p) => p > current).length / finals.length;
  const expectedReturnPct = (dist.expected / current - 1) * 100;
  // Median is the typical scenario and is robust to the long upper tail of
  // multiplicative price paths — we surface it as the headline number.
  const medianReturnPct = (dist.p50 / current - 1) * 100;
  const var5Pct = (dist.p5 / current - 1) * 100; // worst 5% outcome
  const upside95Pct = (dist.p95 / current - 1) * 100;

  return {
    current,
    horizon: safeHorizon,
    sims: safeSims,
    method,
    blockSize: method === "blockBootstrap" ? safeBlockSize : undefined,
    sigmaPerPeriod: sigma,
    cone,
    dist,
    finals,
    paths,
    maxes,
    mins,
    probAboveCurrent,
    probProfit: probAboveCurrent, // backwards-compatible alias
    expectedReturnPct,
    medianReturnPct,
    var5Pct,
    upside95Pct,
  };
}

export function probabilityPriceMap(mc) {
  if (!mc || mc.error) return [];
  return [
    { key: "p10", probability: 10, price: finalPercentile(mc, 0.1), side: "atOrBelow" },
    { key: "p25", probability: 25, price: mc.dist.p25, side: "atOrBelow" },
    { key: "p50", probability: 50, price: mc.dist.p50, side: "atOrBelow" },
    { key: "p75", probability: 25, price: mc.dist.p75, side: "above" },
    { key: "p90", probability: 10, price: finalPercentile(mc, 0.9), side: "above" },
  ];
}

function finalPercentile(mc, p) {
  const sorted = [...mc.finals].sort((a, b) => a - b);
  return percentile(sorted, p);
}

/** Probability the price touches `level` at any point along the horizon. */
export function touchProbability(mc, level, direction) {
  if (!mc || mc.error) return null;
  const arr = direction === "up" ? mc.maxes : mc.mins;
  let count = 0;
  for (const v of arr) {
    if (direction === "up" ? v >= level : v <= level) count++;
  }
  return count / arr.length;
}

export function firstTouchProbabilities(mc, { target, stop, side = "Long" }) {
  if (!mc || mc.error || !Array.isArray(mc.paths)) return null;
  let targetFirst = 0;
  let stopFirst = 0;
  for (const path of mc.paths) {
    let resolved = false;
    for (const price of path) {
      if (side === "Long") {
        if (price >= target) {
          targetFirst++;
          resolved = true;
          break;
        }
        if (price <= stop) {
          stopFirst++;
          resolved = true;
          break;
        }
      } else {
        if (price <= target) {
          targetFirst++;
          resolved = true;
          break;
        }
        if (price >= stop) {
          stopFirst++;
          resolved = true;
          break;
        }
      }
    }
    if (!resolved) {
      /* unresolved paths count toward neither side */
    }
  }
  return {
    targetBeforeStop: targetFirst / mc.paths.length,
    stopBeforeTarget: stopFirst / mc.paths.length,
  };
}

/** Probability the FINAL price lands inside [low, high]. */
export function rangeProbability(mc, low, high) {
  if (!mc || mc.error) return null;
  let count = 0;
  for (const v of mc.finals) if (v >= low && v <= high) count++;
  return count / mc.finals.length;
}

/**
 * Build contiguous outcome zones across the final-price distribution and the
 * probability mass landing in each — the "where could it end up" heatmap.
 */
export function outcomeZones(mc, bands = 7) {
  if (!mc || mc.error) return [];
  const lo = mc.dist.p5;
  const hi = mc.dist.p95;
  if (!(hi > lo)) return [];
  const width = (hi - lo) / bands;
  const zones = [];
  for (let i = 0; i < bands; i++) {
    const from = lo + i * width;
    const to = i === bands - 1 ? Infinity : lo + (i + 1) * width;
    const fromInclusive = i === 0 ? -Infinity : from;
    let count = 0;
    for (const v of mc.finals) if (v >= fromInclusive && v < to) count++;
    zones.push({
      from: i === 0 ? mc.dist.p5 * 0.9 : from,
      to: i === bands - 1 ? mc.dist.p95 * 1.1 : to,
      mid: from + width / 2,
      probability: count / mc.finals.length,
      changePct: (((from + width / 2) / mc.current) - 1) * 100,
    });
  }
  return zones;
}

/**
 * Volatility-scaled trade setups with probability-weighted R:R.
 * Targets/stops are placed at multiples of the horizon volatility (sigma·√h).
 */
export function tradeSetups(mc, multiples = [1, 1.5, 2, 3]) {
  if (!mc || mc.error) return [];
  const { current, sigmaPerPeriod, horizon } = mc;
  const sigmaH = sigmaPerPeriod * Math.sqrt(horizon);
  return multiples.map((k) => {
    const target = current * Math.exp(k * sigmaH);
    const stop = current * Math.exp(-k * sigmaH);
    const pTarget = touchProbability(mc, target, "up");
    const pStop = touchProbability(mc, stop, "down");
    const reward = target - current;
    const risk = current - stop;
    const rr = risk > 0 ? reward / risk : null;
    // Expected value per unit risked, using touch probabilities (rough proxy).
    const ev = rr != null ? pTarget * rr - pStop * 1 : null;
    return {
      k,
      target,
      stop,
      targetPct: (target / current - 1) * 100,
      stopPct: (stop / current - 1) * 100,
      pTarget,
      pStop,
      rr,
      ev,
    };
  });
}

/** Annualized realized volatility (from per-period sigma + periods/year). */
export function annualizedVol(closes, periodsPerYear) {
  const sigma = std(logReturns(closes));
  return sigma * Math.sqrt(periodsPerYear) * 100;
}
