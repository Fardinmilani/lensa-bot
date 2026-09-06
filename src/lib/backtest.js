// Vendored verbatim from lensa-crypto-dashboard (src/lib/backtest.js) on 2026-08-18.
// Pure computation, no browser deps -- keep this file byte-identical to the
// dashboard's copy when you sync changes, so bot signals always match what
// the dashboard's Backtest/Decision Center pages would show.

// lib/backtest.js
// Mechanical backtest engine. Takes a 0/1 long-flat signal array and historical
// candles, simulates equity including a fee/slippage assumption, and reports a
// full set of performance statistics.
//
// IMPORTANT: this measures how a *rule* would have performed on *past* data.
// Past performance of a rule is not a forecast of future performance.

import { combineDirectionalSignals } from "./strategies.js";

// ---------------------------------------------------------------------------
// Stop-loss / take-profit overlay
// ---------------------------------------------------------------------------
//
// Optional, off by default. When enabled, this scans each open trade for an
// intrabar breach of a max-loss or max-gain percentage (checked against the
// bar's low/high, not just its close, since a stop can be hit and recover
// within the same candle) and forces an exit at that bound — but only as a
// CEILING/FLOOR. If the strategy's own exit signal would have closed the
// trade earlier, at a smaller profit or loss than the configured bound,
// that earlier signal exit is respected as-is; this overlay never holds a
// position open longer than the strategy says to, it only ever closes it
// *sooner*, before price can run further in either direction.
//
// Implemented as a signal-array transform (rather than inside each engine's
// accounting loop) so the exact same logic applies uniformly to the spot
// engine (runBacktest, long-only) and the leveraged engine
// (runLeveragedBacktest, long/short with leverage): both engines already
// just replay whatever 0/1 or -1/0/1 signal they're given, so forcing an
// early flip to 0 here is equivalent to the strategy itself having signalled
// the exit on that bar.
//
// `riskParams`: { stopLossPercent, takeProfitPercent } — either or both may
// be omitted/null to disable that side independently. Percentages are
// always interpreted as a magnitude (e.g. stopLossPercent: 2 means "exit if
// the position is down 2%", not literally -2).
//
// Returns { signals, exitPrice }. `exitPrice[i]` holds the exact stop/target
// price on any bar where this overlay forced an exit, or null otherwise.
// This matters because a forced exit can happen mid-bar (the low/high
// pierced the bound while the close did not) — if the caller just used that
// bar's close price to fill the trade, a single large-range candle could
// report a P/L far beyond the configured stop-loss percentage, which is
// exactly backwards for a risk control. Filling at the configured bound
// instead (as a real stop/limit order would, ignoring slippage) is what
// keeps a trade's realized loss capped at stopLossPercent as configured.
export function applyRiskExits(candles, signals, riskParams) {
  const stopLossPercent = positiveOrNull(riskParams?.stopLossPercent);
  const takeProfitPercent = positiveOrNull(riskParams?.takeProfitPercent);
  if (stopLossPercent == null && takeProfitPercent == null) return { signals, exitPrice: new Array(signals.length).fill(null) };

  const out = signals.slice();
  const exitPrice = new Array(signals.length).fill(null);
  let side = 0; // 1 long, -1 short, 0 flat — sign of the signal that opened the current trade
  let entryPrice = null;
  // After a forced SL/TP exit, re-entry on the SAME side is blocked until
  // the raw strategy signal moves off that side — either back to flat, or
  // (for long/short strategies that flip directly between 1 and -1 with no
  // intermediate flat bar) straight into the opposite side. Without this,
  // a strategy whose signal stays continuously 1 would get flipped right
  // back into a fresh position on the very next bar, defeating the point
  // of having stopped out.
  //
  // NOTE: this used to wait specifically for the signal to hit literal 0.
  // That is wrong for direction: "both" strategies, which often never emit
  // an explicit 0 at all — they flip straight from 1 to -1 (see the flip
  // branch below). Waiting for a flat that never comes meant that, once a
  // single forced exit happened, every subsequent bar for the rest of the
  // backtest was suppressed, silently collapsing the trade count to one
  // whenever a stop-loss/take-profit was configured on such a strategy.
  let blockedSide = 0;

  for (let i = 0; i < candles.length; i++) {
    const rawSignal = Math.sign(signals[i] ?? 0);
    const { close, low, high } = candles[i];
    const hasRange = Number.isFinite(low) && Number.isFinite(high);

    if (blockedSide !== 0 && rawSignal === blockedSide) {
      out[i] = 0;
      continue;
    }
    blockedSide = 0; // signal moved off the stopped-out side; block lifted

    if (side !== 0) {
      // Percentage move of the open side from entry to each bound,
      // amplified by nothing here (leverage is applied later by whichever
      // engine consumes this signal; this overlay works in underlying-price
      // percentage terms, matching how stopLossPercent/takeProfitPercent are
      // presented to the user as "% move against/for the position").
      const worstPrice = hasRange ? (side === 1 ? low : high) : close;
      const bestPrice = hasRange ? (side === 1 ? high : low) : close;
      const worstMove = ((worstPrice - entryPrice) / entryPrice) * 100 * side; // negative = loss
      const bestMove = ((bestPrice - entryPrice) / entryPrice) * 100 * side; // positive = gain

      const stopHit = stopLossPercent != null && worstMove <= -stopLossPercent;
      const profitHit = takeProfitPercent != null && bestMove >= takeProfitPercent;

      if (stopHit || profitHit) {
        // Force flat on this bar. If both bounds are somehow crossed on the
        // same bar, the stop-loss takes priority (the more conservative,
        // capital-preserving assumption when intrabar order isn't known).
        // Fill at the exact configured bound rather than the bar's close.
        out[i] = 0;
        exitPrice[i] = stopHit
          ? entryPrice * (1 - (stopLossPercent / 100) * side)
          : entryPrice * (1 + (takeProfitPercent / 100) * side);
        // Only hold off re-entry if the strategy's own signal is still
        // "in position" (on the side that just got stopped out) on this
        // very bar — if it had already moved off that side on its own,
        // there's nothing to wait for.
        if (rawSignal === side) blockedSide = side;
        side = 0;
        entryPrice = null;
        continue; // a forced exit this bar can't also re-enter the same bar
      }
    }

    if (side === 0 && rawSignal !== 0) {
      side = rawSignal;
      entryPrice = close;
    } else if (side !== 0 && rawSignal === 0) {
      side = 0;
      entryPrice = null;
    } else if (side !== 0 && rawSignal !== side) {
      // direction flip (long -> short or vice versa) without an
      // intermediate flat bar
      side = rawSignal;
      entryPrice = close;
    }
  }

  return { signals: out, exitPrice };
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------
//
// Both engines default to committing the ENTIRE account to every trade
// ("all-in"), which is what they've always done — passing no `sizing` (or
// `sizing: null`) reproduces that behavior byte-for-byte. `sizing: {
// mode: "riskPercent", riskPercent }` instead sizes the position so that a
// stop-loss hit loses exactly `riskPercent`% of the account, the same
// fixed-fractional-risk formula already offered standalone in lib/risk.js's
// positionSize(). This requires a configured stop-loss distance to define
// "how much is lost per unit of price move" — with no stop-loss percent
// available, sizing silently falls back to all-in rather than guessing a
// distance, since risking a fixed % of capital against an undefined stop is
// not a well-posed question.
//
// Any capital not committed to the position sits out as idle cash and is
// still added into the equity curve each bar — it just isn't multiplied by
// the trade's outcome. This is the standard, realistic behavior of
// fixed-fractional sizing on a single-instrument backtest: unused capital
// doesn't vanish, it just isn't at risk.
function resolveEntryNotional(cash, sizing, riskParams) {
  if (!sizing || sizing.mode !== "riskPercent") return cash;
  const riskPercent = Number(sizing.riskPercent);
  const stopLossPercent = Number(riskParams?.stopLossPercent);
  if (!(riskPercent > 0) || !(stopLossPercent > 0)) return cash;
  const riskAmount = cash * (riskPercent / 100);
  const stopFraction = stopLossPercent / 100;
  const desiredNotional = riskAmount / stopFraction;
  return Math.max(0, Math.min(cash, desiredNotional));
}

// Leveraged variant: a `stopLossPercent` move in the UNDERLYING is amplified
// by `leverage` on the position's collateral (e.g. 5% underlying move at
// 10x leverage is a 50% loss of collateral), so less collateral is needed
// to risk the same dollar amount at higher leverage. Capped at 100% since a
// position can't lose more than the collateral backing it (liquidation).
function resolveEntryCollateral(cash, sizing, riskParams, lev) {
  if (!sizing || sizing.mode !== "riskPercent") return cash;
  const riskPercent = Number(sizing.riskPercent);
  const stopLossPercent = Number(riskParams?.stopLossPercent);
  if (!(riskPercent > 0) || !(stopLossPercent > 0)) return cash;
  const riskAmount = cash * (riskPercent / 100);
  const lossFraction = Math.min(1, (stopLossPercent / 100) * lev);
  if (!(lossFraction > 0)) return cash;
  const desiredCollateral = riskAmount / lossFraction;
  return Math.max(0, Math.min(cash, desiredCollateral));
}

// ---------------------------------------------------------------------------
// Fill timing
// ---------------------------------------------------------------------------
//
// Default ("close") reproduces the engines' original assumption: a signal
// computed from bar i's own close is filled at that exact same close, i.e.
// zero-latency execution. `fillTiming: "nextOpen"` is the more conservative,
// realistic alternative — a decision made from bar i's data can only
// actually be acted on at bar i+1's open at the earliest. The final bar has
// no "next" bar, so it falls back to that bar's own close.
function resolveFillPrices(candles, fillTiming) {
  if (fillTiming !== "nextOpen") return candles.map((c) => c.close);
  return candles.map((c, i) => {
    const next = candles[i + 1];
    return next && Number.isFinite(next.open) ? next.open : c.close;
  });
}

/**
 * Grid-searches a small set of stop-loss / take-profit combinations against
 * the given signals and returns the combination with the best Sharpe ratio
 * (falling back to total return when Sharpe can't be computed for any
 * candidate, e.g. too few trades). Used for the backtest page's "Auto-fit
 * SL/TP" option — runs entirely client-side, no extra network calls.
 */
export function autoFitRiskExits({ candles, signals, feePercent = 0.1, initialCapital = 10000, leverage = 1, sizing = null, fillTiming = "close" }) {
  const STOP_CANDIDATES = [1, 2, 3, 5, 8, 12];
  const TARGET_CANDIDATES = [2, 4, 6, 10, 15, 20, 30];
  const runOne = (riskParams) =>
    leverage > 1 || signals.some((s) => s < 0)
      ? runLeveragedBacktest({ candles, signals, feePercent, initialCapital, leverage, riskParams, sizing, fillTiming })
      : runBacktest({ candles, signals, feePercent, initialCapital, riskParams, sizing, fillTiming });

  let best = null;
  for (const stopLossPercent of STOP_CANDIDATES) {
    for (const takeProfitPercent of TARGET_CANDIDATES) {
      const result = runOne({ stopLossPercent, takeProfitPercent });
      const score = Number.isFinite(result.sharpe) ? result.sharpe : result.totalReturnPercent / 100;
      if (!best || score > best.score) {
        best = { stopLossPercent, takeProfitPercent, score, result };
      }
    }
  }
  return best;
}

export function runBacktest({
  candles,
  signals,
  feePercent = 0.1,
  initialCapital = 10000,
  riskParams = null,
  sizing = null,
  fillTiming = "close",
}) {
  if (candles.length !== signals.length) {
    throw new Error("candles و signals باید طول یکسان داشته باشند");
  }
  const { signals: effectiveSignals, exitPrice: forcedExitPrice } = riskParams
    ? applyRiskExits(candles, signals, riskParams)
    : { signals, exitPrice: null };

  const fillPrices = resolveFillPrices(candles, fillTiming);

  const equityCurve = [];
  const trades = [];
  let cash = initialCapital;
  let units = 0;
  let prevSignal = 0;
  let entryPrice = null;
  let entryTime = null;

  for (let i = 0; i < candles.length; i++) {
    const { time, close } = candles[i];
    const signal = effectiveSignals[i];
    // A forced SL/TP exit always fills at its own configured bound; absent
    // that, the fill uses fillTiming (see resolveFillPrices above).
    const fillPrice = forcedExitPrice?.[i] ?? fillPrices[i];

    if (prevSignal === 0 && signal === 1) {
      const notional = resolveEntryNotional(cash, sizing, riskParams);
      const fee = notional * (feePercent / 100);
      const investable = notional - fee;
      units = investable / fillPrice;
      cash -= notional;
      entryPrice = fillPrice;
      entryTime = time;
    } else if (prevSignal === 1 && signal === 0) {
      const proceeds = units * fillPrice;
      const fee = proceeds * (feePercent / 100);
      cash += proceeds - fee;
      const pnlPercent = ((fillPrice - entryPrice) / entryPrice) * 100;
      trades.push({ entryTime, exitTime: time, entryPrice, exitPrice: fillPrice, pnlPercent });
      units = 0;
      entryPrice = null;
      entryTime = null;
    }

    equityCurve.push({ time, equity: cash + units * close });
    prevSignal = signal;
  }

  if (units > 0) {
    const lastClose = candles[candles.length - 1].close;
    const pnlPercent = ((lastClose - entryPrice) / entryPrice) * 100;
    trades.push({
      entryTime,
      exitTime: candles[candles.length - 1].time,
      entryPrice,
      exitPrice: lastClose,
      pnlPercent,
      stillOpenAtEnd: true,
    });
    cash += units * lastClose;
  }

  const finalEquity = cash;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  // Max drawdown
  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  // Per-period returns of the equity curve → Sharpe / Sortino
  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  // Trade stats
  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : null;
  const avgWin = wins.length ? mean(wins.map((t) => t.pnlPercent)) : null;
  const avgLoss = losses.length ? mean(losses.map((t) => t.pnlPercent)) : null;
  const grossWin = wins.reduce((a, t) => a + t.pnlPercent, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null;
  const expectancy = trades.length ? mean(trades.map((t) => t.pnlPercent)) : null;
  const bestTrade = trades.length ? Math.max(...trades.map((t) => t.pnlPercent)) : null;
  const worstTrade = trades.length ? Math.min(...trades.map((t) => t.pnlPercent)) : null;

  const benchmarkReturnPercent =
    ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100;

  // Time exposed to the market (fraction of periods holding)
  const exposurePercent = (effectiveSignals.filter((s) => s === 1).length / effectiveSignals.length) * 100;

  return {
    equityCurve,
    trades,
    finalEquity,
    initialCapital,
    totalReturnPercent,
    maxDrawdownPercent,
    winRate,
    tradeCount: trades.length,
    benchmarkReturnPercent,
    sharpe,
    sortino,
    profitFactor,
    expectancy,
    avgWin,
    avgLoss,
    bestTrade,
    worstTrade,
    exposurePercent,
    riskParams: riskParams || null,
  };
}
// ---------------------------------------------------------------------------
// Leveraged / futures backtest
//
// runBacktest() above models a simple all-in/all-out spot position (1x,
// long-only — spot can't short). runLeveragedBacktest() is for futures: it
// accepts a position series of -1 (short) / 0 (flat) / 1 (long) — not just
// 0/1 — and marks the position to market on every bar so a leveraged
// position can be liquidated mid-trade, something an entry-vs-exit-price-
// only calculation would miss entirely. The full account balance is
// committed as collateral on entry (isolated margin against the whole
// account, not a fraction of it), and the position's notional exposure —
// and therefore its P&L — is the underlying percentage move amplified by
// `leverage`, with the sign flipped for a short (a short profits when price
// falls). If mark-to-market losses would amplify to a -100% (or worse) move
// on that collateral before the exit signal fires, the trade is force-closed
// at the bar where it crosses that line ("liquidated") — mirroring how a
// real isolated-margin futures position behaves, instead of pretending the
// account can ride out an unbounded drawdown.
export function runLeveragedBacktest({
  candles,
  signals,
  feePercent = 0.1,
  initialCapital = 10000,
  leverage = 1,
  riskParams = null,
  sizing = null,
  fillTiming = "close",
}) {
  if (candles.length !== signals.length) {
    throw new Error("candles و signals باید طول یکسان داشته باشند");
  }
  const { signals: effectiveSignals, exitPrice: forcedExitPrice } = riskParams
    ? applyRiskExits(candles, signals, riskParams)
    : { signals, exitPrice: null };
  const lev = Math.max(1, Number(leverage) || 1);
  const hasShorts = effectiveSignals.some((s) => s < 0);
  if (lev === 1 && !hasShorts) {
    return runBacktest({ candles, signals, feePercent, initialCapital, riskParams, sizing, fillTiming });
  }

  const fillPrices = resolveFillPrices(candles, fillTiming);

  const equityCurve = [];
  const trades = [];
  let cash = initialCapital;
  // collateral backing the open position (this account's "skin in the
  // game"). The position's notional exposure is `leverage × that
  // collateral`, so the entire available cash backs the trade while only
  // `equity` is actually at risk.
  let positionEquity = 0;
  let positionSide = 0; // 1 = long, -1 = short, 0 = flat
  let entryPrice = null;
  let entryTime = null;
  let liquidated = false;
  let prevDirection = 0;

  // Signed percentage move of the position, from entryPrice to atPrice,
  // already amplified by leverage. Positive = profit for the open side.
  function movePercent(atPrice) {
    const rawPercent = ((atPrice - entryPrice) / entryPrice) * 100 * positionSide;
    return rawPercent * lev;
  }

  function closePosition(exitPrice, exitTime, { isLiquidation = false } = {}) {
    const rawPnlPercent = movePercent(exitPrice);
    // Collateral can't go below zero: a liquidation caps the loss at -100%
    // of the committed equity (the rest of the account, if any was held
    // back, is untouched — isolated margin, not cross margin).
    const pnlPercentOnEquity = isLiquidation ? -100 : Math.max(-100, rawPnlPercent);
    const grossProceeds = positionEquity * (1 + pnlPercentOnEquity / 100);
    const fee = grossProceeds * (feePercent / 100);
    cash += Math.max(0, grossProceeds - fee);
    trades.push({
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      pnlPercent: pnlPercentOnEquity,
      leverage: lev,
      side: positionSide,
      liquidated: isLiquidation,
    });
    positionEquity = 0;
    positionSide = 0;
    entryPrice = null;
    entryTime = null;
    // The account is wiped out the instant a liquidation happens *and there
    // is no capital left outside this trade* — flag it here, synchronously,
    // rather than waiting until the end of the loop iteration. Checking only
    // at the end would let the very same bar that triggered the liquidation
    // immediately re-open a fresh position (since entryPrice was just
    // cleared above), effectively giving the account a free re-entry it
    // shouldn't have. With all-in sizing (the default), the whole account
    // was the collateral, so `cash <= 0` here is always true, matching the
    // original behavior exactly. With risk-based sizing, only the risked
    // slice was on the line — any untouched idle cash survives, and the
    // account correctly keeps trading with it instead of being treated as
    // dead over a single, deliberately small loss.
    if (isLiquidation && cash <= 0) liquidated = true;
  }

  function openPosition(side, atPrice, atTime) {
    const notional = resolveEntryCollateral(cash, sizing, riskParams, lev);
    const fee = notional * (feePercent / 100);
    positionEquity = Math.max(0, notional - fee);
    cash -= notional;
    positionSide = side;
    entryPrice = atPrice;
    entryTime = atTime;
  }

  for (let i = 0; i < candles.length; i++) {
    const { time, close, low, high } = candles[i];
    const direction = liquidated ? 0 : Math.sign(effectiveSignals[i] ?? 0);
    const fillPrice = forcedExitPrice?.[i] ?? fillPrices[i];

    if (entryPrice != null) {
      // Mark-to-market against the bar's worst excursion before checking the
      // exit signal, since a liquidation can happen intrabar even on the
      // same candle that would otherwise have produced a clean exit. The
      // "worst" price for a long is the bar's low; for a short it's the
      // bar's high — whichever moves against the open side.
      const worstPrice =
        Number.isFinite(low) && Number.isFinite(high) ? (positionSide === 1 ? low : high) : close;
      const worstMovePercent = movePercent(worstPrice);
      if (worstMovePercent <= -100) {
        closePosition(worstPrice, time, { isLiquidation: true });
      } else if (direction !== prevDirection) {
        closePosition(fillPrice, time);
      }
    }

    if (entryPrice == null && direction !== 0 && !liquidated) {
      openPosition(direction, fillPrice, time);
    }

    const markPrice = close;
    const openEquity = entryPrice != null ? positionEquity * (1 + movePercent(markPrice) / 100) : 0;
    equityCurve.push({ time, equity: cash + Math.max(0, openEquity) });
    prevDirection = liquidated ? 0 : direction;
    if (entryPrice == null && positionEquity === 0 && cash <= 0) liquidated = true;
  }

  if (entryPrice != null) {
    const lastClose = candles[candles.length - 1].close;
    closePosition(lastClose, candles[candles.length - 1].time);
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = cash;
  }

  const finalEquity = cash;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : null;
  const avgWin = wins.length ? mean(wins.map((t) => t.pnlPercent)) : null;
  const avgLoss = losses.length ? mean(losses.map((t) => t.pnlPercent)) : null;
  const grossWin = wins.reduce((a, t) => a + t.pnlPercent, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null;
  const expectancy = trades.length ? mean(trades.map((t) => t.pnlPercent)) : null;
  const bestTrade = trades.length ? Math.max(...trades.map((t) => t.pnlPercent)) : null;
  const worstTrade = trades.length ? Math.min(...trades.map((t) => t.pnlPercent)) : null;
  const liquidationCount = trades.filter((t) => t.liquidated).length;

  const benchmarkReturnPercent =
    ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100;
  const exposurePercent = (effectiveSignals.filter((s) => s !== 0).length / effectiveSignals.length) * 100;
  const longCount = trades.filter((t) => t.side === 1).length;
  const shortCount = trades.filter((t) => t.side === -1).length;

  return {
    equityCurve,
    trades,
    finalEquity,
    initialCapital,
    totalReturnPercent,
    maxDrawdownPercent,
    winRate,
    tradeCount: trades.length,
    benchmarkReturnPercent,
    sharpe,
    sortino,
    profitFactor,
    expectancy,
    avgWin,
    avgLoss,
    bestTrade,
    worstTrade,
    exposurePercent,
    leverage: lev,
    liquidationCount,
    wasLiquidated: liquidationCount > 0,
    longCount,
    shortCount,
    riskParams: riskParams || null,
  };
}

// Run every non-benchmark strategy (with its default params) on the same
// candles and compare them against a single Buy & Hold benchmark. Returns the
// per-strategy rows plus a set of aggregate KPIs for a portfolio-level view.
//
// `leverage` defaults to 1 (spot, unleveraged) and `direction` defaults to
// "long" (spot can't short). Passing leverage > 1 and/or direction !== "long"
// reuses the exact same strategy set against runLeveragedBacktest with
// combineDirectionalSignals(), so the same "Run all strategies" view works
// for Spot and for futures — the market/timeframe/leverage/direction the
// caller is already on, not a separate sweep across other markets.
export function runAllStrategies({ candles, strategies, feePercent = 0.1, leverage = 1, direction = "long", riskParams = null, sizing = null, fillTiming = "close" }) {
  const isFutures = leverage > 1 || direction !== "long";
  const benchmarkDef = strategies.buyAndHold;
  // Buy & Hold is always the fully-invested baseline — sizing doesn't apply.
  const benchmark = runBacktest({
    candles,
    signals: benchmarkDef.generateSignals(candles),
    feePercent,
  });

  const rows = Object.entries(strategies)
    .filter(([, s]) => s.category !== "benchmark")
    .map(([key, strategy]) => {
      const signals = isFutures
        ? combineDirectionalSignals(strategy, candles, strategy.params, direction)
        : strategy.generateSignals(candles, strategy.params);
      const result = isFutures
        ? runLeveragedBacktest({ candles, signals, feePercent, leverage, riskParams, sizing, fillTiming })
        : runBacktest({ candles, signals, feePercent, riskParams, sizing, fillTiming });
      return {
        key,
        label: strategy.label,
        category: strategy.category,
        params: strategy.params,
        result,
        excessReturn: result.totalReturnPercent - benchmark.totalReturnPercent,
        beatsBenchmark: result.totalReturnPercent > benchmark.totalReturnPercent,
        supportsShort: typeof strategy.generateShortSignals === "function",
      };
    })
    .sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);

  const returns = rows.map((r) => r.result.totalReturnPercent);
  const sharpeRows = rows.filter((r) => Number.isFinite(r.result.sharpe));
  const bestBySharpe = sharpeRows.length
    ? sharpeRows.reduce((best, r) => (r.result.sharpe > best.result.sharpe ? r : best))
    : null;

  const summary = {
    count: rows.length,
    benchmarkReturn: benchmark.totalReturnPercent,
    best: rows[0] || null,
    worst: rows[rows.length - 1] || null,
    bestBySharpe,
    beatsBenchmark: rows.filter((r) => r.beatsBenchmark).length,
    profitable: rows.filter((r) => r.result.totalReturnPercent > 0).length,
    avgReturn: mean(returns),
    liquidated: isFutures ? rows.filter((r) => r.result.wasLiquidated).length : 0,
  };

  const aggregateEquityCurve = averageEquityCurves(rows);
  const aggregateResult = summarizeEquityCurve(aggregateEquityCurve, {
    initialCapital: benchmark.initialCapital,
    candles,
    benchmarkReturnPercent: benchmark.totalReturnPercent,
  });

  return { benchmark, rows, summary, aggregateEquityCurve, aggregate: { equityCurve: aggregateEquityCurve, result: aggregateResult } };
}

/** Equal-weight average of normalized equity curves (each starts at the same capital). */
export function averageEquityCurves(rows, initialCapital = 10000) {
  if (!rows?.length) return [];

  // Every equity curve produced by runBacktest has exactly one point per
  // input candle, built in the same left-to-right order — so all rows are
  // already index-aligned and share the same time axis. No per-timestamp
  // lookup is needed; we can average by position directly in one pass.
  const length = rows[0]?.result?.equityCurve?.length || 0;
  if (!length) return [];

  const out = new Array(length);
  const rowCount = rows.length;
  for (let i = 0; i < length; i++) {
    let sumNorm = 0;
    for (let r = 0; r < rowCount; r++) {
      sumNorm += rows[r].result.equityCurve[i].equity / rows[r].result.initialCapital;
    }
    out[i] = { time: rows[0].result.equityCurve[i].time, equity: (sumNorm / rowCount) * initialCapital };
  }
  return out;
}

export function summarizeEquityCurve(equityCurve, { initialCapital = 10000, candles = [], benchmarkReturnPercent = null } = {}) {
  if (!equityCurve?.length) {
    return {
      equityCurve: [],
      initialCapital,
      finalEquity: initialCapital,
      totalReturnPercent: 0,
      maxDrawdownPercent: 0,
      sharpe: null,
      sortino: null,
      benchmarkReturnPercent,
    };
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturnPercent = ((finalEquity - initialCapital) / initialCapital) * 100;

  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd;
  }

  const periodReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) periodReturns.push(equityCurve[i].equity / prev - 1);
  }
  const meanRet = mean(periodReturns);
  const stdRet = std(periodReturns, meanRet);
  const downside = std(periodReturns.filter((r) => r < 0), 0);
  const periodsPerYear = estimatePeriodsPerYear(candles);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(periodsPerYear) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(periodsPerYear) : null;

  return {
    equityCurve,
    initialCapital,
    finalEquity,
    totalReturnPercent,
    maxDrawdownPercent,
    sharpe,
    sortino,
    benchmarkReturnPercent,
  };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function estimatePeriodsPerYear(candles) {
  if (candles.length < 2) return 365;
  const dt = candles[1].time - candles[0].time; // seconds
  if (dt <= 0) return 365;
  return (365 * 24 * 3600) / dt;
}
