import { ema, rsi, macd, atr, STRATEGIES, currentSignalState, combineDirectionalSignals } from "./lib/strategies.js";
import { runBacktest, runLeveragedBacktest, runAllStrategies } from "./lib/backtest.js";
import { monteCarlo, probabilityPriceMap, tradeSetups, annualizedVol } from "./lib/forecast.js";
import { positionSize, calculateATR, atrStopSuggestion, riskRewardRatio } from "./lib/risk.js";
import { labelText } from "./lib/singleStrategyFit.js";
import { escapeHtml } from "./telegram.js";
import { assessCandleQuality, qualitySummary } from "./dataQuality.js";

function n(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number >= 0 ? "+" : ""}${n(number, digits)}٪`;
}

function pct(value, digits = 1) {
  return `${n(Number(value) * 100, digits)}٪`;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function timeframeSeconds(timeframe) {
  return { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[timeframe] ?? 86400;
}

export function candleCount(timeframe, days) {
  return Math.max(60, Math.ceil((Number(days) * 86400) / timeframeSeconds(timeframe)));
}

function commonMarketStats(candles) {
  if (!Array.isArray(candles) || candles.length < 20) throw new Error("برای این تحلیل حداقل ۲۰ کندل لازم است.");
  const closes = candles.map((c) => Number(c.close));
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const last = candles.at(-1);
  const first = candles[0];
  const e9 = ema(closes, 9).at(-1);
  const e21 = ema(closes, 21).at(-1);
  const e55 = ema(closes, 55).at(-1);
  const r14 = rsi(closes, 14).at(-1);
  const m = macd(closes, 12, 26, 9);
  const hist = m.hist.at(-1);
  const previousHist = m.hist.at(-2);
  const atr14 = atr(candles, 14).at(-1) || calculateATR(candles, 14) || 0;
  const high = Math.max(...candles.map((c) => Number(c.high)));
  const low = Math.min(...candles.map((c) => Number(c.low)));
  const averageVolume = mean(volumes.slice(-30));
  const currentVolume = volumes.at(-1);
  return {
    closes,
    volumes,
    last,
    first,
    e9,
    e21,
    e55,
    r14,
    hist,
    previousHist,
    atr14,
    high,
    low,
    averageVolume,
    currentVolume,
    returnPct: ((last.close / first.open) - 1) * 100,
    atrPct: last.close > 0 ? (atr14 / last.close) * 100 : 0,
  };
}

export function formatMarketAnalysis({ symbol, timeframe, days, candles }) {
  const s = commonMarketStats(candles);
  const quality = assessCandleQuality(candles, timeframe);
  const trend = s.last.close > s.e55 && s.e9 > s.e21 ? "صعودی" : s.last.close < s.e55 && s.e9 < s.e21 ? "نزولی" : "خنثی/ترکیبی";
  const momentum = s.hist > 0 && s.hist > s.previousHist ? "مثبت و در حال تقویت" : s.hist < 0 && s.hist < s.previousHist ? "منفی و در حال تضعیف" : "بدون تأیید قوی";
  const volumeRatio = s.averageVolume > 0 ? s.currentVolume / s.averageVolume : 0;
  return (
    `📊 <b>داشبورد کامل بازار — ${escapeHtml(symbol)}</b>\n` +
    `تایم‌فریم: ${escapeHtml(timeframe)} | بازه: ${days} روز | تعداد کندل: ${candles.length}\n\n` +
    `<b>کیفیت داده</b>\n${qualitySummary(quality)}\n\n` +
    `<b>قیمت و بازه</b>\n` +
    `قیمت آخر: <code>${n(s.last.close)}</code>\n` +
    `بازده کل بازه: ${signed(s.returnPct)}\n` +
    `بیشترین قیمت: ${n(s.high)}\nکمترین قیمت: ${n(s.low)}\n\n` +
    `<b>روند</b>\nEMA 9: ${n(s.e9)}\nEMA 21: ${n(s.e21)}\nEMA 55: ${n(s.e55)}\n` +
    `ساختار روند: <b>${trend}</b>\n\n` +
    `<b>مومنتوم و نوسان</b>\nRSI(14): ${n(s.r14, 1)}\nMACD Histogram: ${n(s.hist, 4)}\n` +
    `وضعیت مومنتوم: ${momentum}\nATR(14): ${n(s.atr14)} (${n(s.atrPct, 2)}٪ قیمت)\n\n` +
    `<b>حجم</b>\nحجم کندل آخر: ${n(s.currentVolume, 4)}\nمیانگین حجم ۳۰ کندل: ${n(s.averageVolume, 4)}\n` +
    `نسبت حجم فعلی به میانگین: ${n(volumeRatio, 2)}x\n\n` +
    `بازه‌ی زمانی داده: ${new Date(s.first.time * 1000).toISOString()} تا ${new Date(s.last.time * 1000).toISOString()}\n\n` +
    `⚠️ این خروجی توصیف داده‌ی بازار است و توصیه‌ی مالی نیست.`
  );
}

export function formatForecastAnalysis({ symbol, timeframe, days, candles, horizon, sims, method, driftMode, blockSize }) {
  const closes = candles.map((c) => c.close);
  const result = monteCarlo({ closes, horizon, sims, method, driftMode, blockSize, seed: 12345 });
  if (result.error) throw new Error(result.error);
  const periodsPerYear = (365 * 86400) / timeframeSeconds(timeframe);
  const vol = annualizedVol(closes, periodsPerYear);
  const map = probabilityPriceMap(result);
  const setups = tradeSetups(result);
  const methodFa = { bootstrap: "Bootstrap تاریخی", blockBootstrap: "Block Bootstrap", gbm: "GBM" }[method] ?? method;
  const quality = assessCandleQuality(candles, timeframe);
  const lines = [
    `🔮 <b>Forecast کامل — ${escapeHtml(symbol)}</b>`,
    `تایم‌فریم: ${timeframe} | داده‌ی تاریخی: ${days} روز (${candles.length} کندل)`,
    `افق: ${horizon} کندل | مسیرها: ${Number(sims).toLocaleString("en-US")} | روش: ${methodFa}`,
    `Drift: ${driftMode === "zero" ? "صفر/بدون فرض رشد" : "میانگین تاریخی"}${method === "blockBootstrap" ? ` | اندازه بلوک: ${blockSize}` : ""}`,
    `کیفیت داده: ${qualitySummary(quality)}`,
    "",
    "<b>توزیع قیمت پایانی</b>",
    `قیمت فعلی: ${n(result.current)}`,
    `P5 سناریوی بدبینانه: ${n(result.dist.p5)} (${signed(result.var5Pct)})`,
    `P25: ${n(result.dist.p25)}`,
    `P50 میانه: ${n(result.dist.p50)} (${signed(result.medianReturnPct)})`,
    `P75: ${n(result.dist.p75)}`,
    `P95 سناریوی خوش‌بینانه: ${n(result.dist.p95)} (${signed(result.upside95Pct)})`,
    `میانگین قیمت پایانی: ${n(result.dist.expected)} (${signed(result.expectedReturnPct)})`,
    `احتمال پایان بالاتر از قیمت فعلی: ${pct(result.probAboveCurrent, 1)}`,
    `نوسان تحقق‌یافته‌ی سالانه: ${n(vol, 1)}٪`,
    "",
    "<b>نقشه‌ی احتمال قیمت</b>",
    ...map.map((item) => `${item.probability}٪ ${item.side === "above" ? "احتمال بالاتر از" : "احتمال در/پایین‌تر از"} ${n(item.price)}`),
    "",
    "<b>سناریوهای هدف/حد ضرر بر پایه‌ی نوسان</b>",
    ...setups.map((setup) =>
      `${setup.k}σ — هدف ${n(setup.target)} (${signed(setup.targetPct)}) | حد ${n(setup.stop)} (${signed(setup.stopPct)}) | ` +
      `R:R 1:${n(setup.rr, 2)} | P(target) ${pct(setup.pTarget, 0)} | P(stop) ${pct(setup.pStop, 0)} | EV ${n(setup.ev, 2)}`
    ),
    "",
    "⚠️ این‌ها سناریوهای احتمالی‌اند، نه پیش‌بینی قطعی یا توصیه‌ی معامله.",
  ];
  return lines.join("\n");
}

function higherFrame(candles, size = 4) {
  const result = [];
  for (let i = 0; i < candles.length; i += size) {
    const group = candles.slice(i, i + size);
    if (group.length < size) continue;
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1).close,
      volume: group.reduce((sum, c) => sum + (Number(c.volume) || 0), 0),
    });
  }
  return result;
}

export function formatDecisionAnalysis({ symbol, timeframe, days, candles, marketType, leverage, accountSize, riskPercent, fee, slippage }) {
  const s = commonMarketStats(candles);
  const quality = assessCandleQuality(candles, timeframe);
  const hf = higherFrame(candles);
  const hfCloses = hf.map((c) => c.close);
  const hfFast = ema(hfCloses, 9).at(-1);
  const hfSlow = ema(hfCloses, 21).at(-1);
  const mc = monteCarlo({ closes: s.closes, horizon: 48, sims: 2500, method: "bootstrap", driftMode: "zero", seed: 12345 });
  const trendLong = s.e9 > s.e21 && s.last.close > s.e55;
  const trendShort = s.e9 < s.e21 && s.last.close < s.e55;
  const momentumLong = s.hist > 0 && s.hist > s.previousHist;
  const momentumShort = s.hist < 0 && s.hist < s.previousHist;
  const rsiLong = s.r14 > 50 && s.r14 < 74;
  const rsiShort = s.r14 < 50 && s.r14 > 26;
  const volumeLong = s.currentVolume > s.averageVolume * 1.05;
  const mtfLong = hfFast > hfSlow;
  const mtfShort = hfFast < hfSlow;
  const mcLong = !mc.error && mc.probAboveCurrent > 0.55;
  const mcShort = !mc.error && mc.probAboveCurrent < 0.45;

  let longScore = 50;
  let shortScore = 50;
  const apply = (longOk, shortOk, weight) => {
    if (longOk) { longScore += weight; shortScore -= weight / 2; }
    if (shortOk) { shortScore += weight; longScore -= weight / 2; }
  };
  apply(trendLong, trendShort, 16);
  apply(momentumLong, momentumShort, 12);
  apply(rsiLong, rsiShort, 8);
  apply(mtfLong, mtfShort, 10);
  apply(mcLong, mcShort, 10);
  if (volumeLong) { longScore += trendLong ? 5 : 0; shortScore += trendShort ? 5 : 0; }
  if (s.atrPct > 6) { longScore -= 8; shortScore -= 8; }
  longScore = Math.max(0, Math.min(100, Math.round(longScore)));
  shortScore = Math.max(0, Math.min(100, Math.round(shortScore)));
  const best = longScore >= shortScore ? "Long" : "Short";
  const edge = Math.abs(longScore - shortScore);
  const bestScore = Math.max(longScore, shortScore);
  const decision = bestScore < 48 ? "No Trade" : bestScore < 70 || edge < 12 ? "Wait" : best;
  const side = best === "Long" ? "long" : "short";
  const entry = s.last.close;
  const stop = atrStopSuggestion({ entryPrice: entry, atr: s.atr14, multiplier: 1.5, direction: side })?.stopPrice;
  const target1 = side === "long" ? entry + s.atr14 * 2 : entry - s.atr14 * 2;
  const target2 = side === "long" ? entry + s.atr14 * 3 : entry - s.atr14 * 3;
  const rr1 = riskRewardRatio({ entryPrice: entry, stopPrice: stop, targetPrice: target1 });
  const hasSizing = Number(accountSize) > 0 && Number(riskPercent) > 0;
  const sizing = hasSizing ? positionSize({ accountSize, riskPercent, entryPrice: entry, stopPrice: stop }) : null;
  const maxNotional = Number(accountSize) * Math.max(1, Number(leverage));
  const rawUnits = sizing ? sizing.positionSize ?? sizing.units ?? 0 : 0;
  const units = Math.min(rawUnits, maxNotional / entry);
  const notional = units * entry;
  const actualRisk = units * Math.abs(entry - stop);
  const costs = notional * ((Number(fee) + Number(slippage)) / 100) * 2;
  const liquidation = marketType === "spot" ? null : side === "long" ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
  const test = (name, value, impact) => `${name}: ${value ? "✅" : "⚠️"} — ${impact}`;
  return [
    `🧭 <b>مرکز تصمیم کامل — ${escapeHtml(symbol)}</b>`,
    `${marketType === "spot" ? "Spot" : "Futures"} | ${timeframe} | ${days} روز | ${candles.length} کندل`,
    `کیفیت داده: ${qualitySummary(quality)}`,
    "",
    `<b>نتیجه‌ی ترکیبی: ${decision}</b>`,
    `امتیاز Long: ${longScore}/100 | امتیاز Short: ${shortScore}/100 | فاصله: ${edge}`,
    `قیمت تحلیل: ${n(entry)} | ریسک بازار: ${s.atrPct > 6 ? "زیاد" : s.atrPct > 3 ? "متوسط" : "کم"}`,
    "",
    "<b>آزمون‌های تصمیم</b>",
    test("روند EMA", best === "Long" ? trendLong : trendShort, `EMA9 ${n(s.e9)}، EMA21 ${n(s.e21)}، EMA55 ${n(s.e55)}`),
    test("مومنتوم MACD", best === "Long" ? momentumLong : momentumShort, `Histogram ${n(s.hist, 4)} در برابر ${n(s.previousHist, 4)}`),
    test("RSI", best === "Long" ? rsiLong : rsiShort, `RSI14 = ${n(s.r14, 1)}`),
    test("حجم", volumeLong, `حجم فعلی ${n(s.currentVolume, 2)} در برابر میانگین ${n(s.averageVolume, 2)}`),
    test("چندتایم‌فریمی", best === "Long" ? mtfLong : mtfShort, `EMA9/21 تایم بالاتر: ${n(hfFast)} / ${n(hfSlow)}`),
    test("Monte Carlo", best === "Long" ? mcLong : mcShort, mc.error ? mc.error : `احتمال پایان بالاتر ${pct(mc.probAboveCurrent, 1)}`),
    test("نوسان", s.atrPct <= 6, `ATR = ${n(s.atr14)} (${n(s.atrPct, 2)}٪)`),
    "",
    `<b>ستاپ ${best}</b>`,
    `ورود مبنا: ${n(entry)}`,
    `حد ابطال/ضرر ATR: ${n(stop)}`,
    `هدف اول: ${n(target1)} | R:R = 1:${n(rr1, 2)}`,
    `هدف دوم: ${n(target2)}`,
    "",
    "<b>موتور ریسک با ورودی‌های شما</b>",
    hasSizing ? `سرمایه: ${n(accountSize)} | ریسک: ${n(riskPercent, 2)}٪ | لورج: ${leverage}x` : `محاسبه‌ی حجم رد شد | لورج تحلیلی: ${leverage}x`,
    hasSizing ? `حجم پیشنهادی: ${n(units, 6)} واحد | ارزش پوزیشن: ${n(notional)}` : "حجم پیشنهادی: محاسبه نشده",
    hasSizing ? `ریسک واقعی تا استاپ: ${n(actualRisk)} | هزینه‌ی رفت‌وبرگشت تخمینی: ${n(costs)}` : "برای محاسبه‌ی ریسک مبلغی، اندازه حساب لازم است.",
    hasSizing ? (rawUnits > units ? "ℹ️ حجم خام فرمول از توان خرید بیشتر بود و به سقف حساب/لورج محدود شد." : "حجم بدون نیاز به محدودسازی در توان خرید انتخابی قرار دارد.") : "",
    liquidation == null ? "قیمت لیکویید: برای Spot وجود ندارد" : `قیمت لیکویید تقریبی: ${n(liquidation)}`,
    marketType === "spot" && best === "Short" ? "⚠️ در Spot، Short فقط سوگیری تحلیلی است و پوزیشن فروش اجرایی محسوب نمی‌شود." : "",
    "",
    `<b>چه چیزی تصمیم را عوض می‌کند؟</b>`,
    best === "Long"
      ? `شکست حد ${n(stop)}، کراس نزولی EMA9/21، افت مومنتوم و از دست رفتن تأیید تایم بالاتر.`
      : `عبور قیمت از ${n(stop)}، کراس صعودی EMA9/21 و برگشت مومنتوم و حجم به سمت بالا.`,
    "",
    "⚠️ Wait/No Trade یعنی شواهد برای ورود کافی نیست. این تحلیل توصیه‌ی مالی نیست.",
  ].join("\n");
}

export function formatBacktestAnalysis({ symbol, timeframe, days, candles, mode, strategyKey, direction, leverage, fee, fill, exitMode = "roi", stopLossPercent, takeProfitPercent, accountSize, riskPercent }) {
  const lev = Math.max(1, Number(leverage) || 1);
  const priceStop = Number(stopLossPercent) > 0 ? Number(stopLossPercent) / lev : 0;
  const priceTarget = Number(takeProfitPercent) > 0 ? Number(takeProfitPercent) / lev : 0;
  const riskParams = priceStop > 0 || priceTarget > 0 ? { stopLossPercent: priceStop, takeProfitPercent: priceTarget } : null;
  const sizing = riskPercent > 0 ? { mode: "riskPercent", riskPercent, accountSize } : null;
  const options = { candles, feePercent: fee, leverage, direction, riskParams, sizing, fillTiming: fill };
  let rows;
  if (mode === "all") {
    rows = runAllStrategies({ ...options, strategies: STRATEGIES }).rows;
  } else {
    const strategy = STRATEGIES[strategyKey];
    if (!strategy) throw new Error("استراتژی انتخاب‌شده پیدا نشد.");
    const signals = combineDirectionalSignals(strategy, candles, strategy.params, direction);
    const result = leverage > 1 || direction !== "long"
      ? runLeveragedBacktest({ candles, signals, feePercent: fee, leverage, riskParams, sizing, fillTiming: fill })
      : runBacktest({ candles, signals, feePercent: fee, riskParams, sizing, fillTiming: fill });
    rows = [{ key: strategyKey, label: strategy.label, category: strategy.category, params: strategy.params, result }];
  }
  const sorted = [...rows].sort((a, b) => b.result.totalReturnPercent - a.result.totalReturnPercent);
  const quality = assessCandleQuality(candles, timeframe);
  const best = sorted[0];
  const current = best ? currentSignalState(STRATEGIES[best.key], candles, best.params, direction) : null;
  const lines = [
    `🧪 <b>بک‌تست کامل — ${escapeHtml(symbol)}</b>`,
    `${timeframe} | ${days} روز | ${candles.length} کندل | جهت ${direction} | لورج ${leverage}x`,
    `Fee: ${fee}٪ | Fill: ${fill === "nextOpen" ? "کندل بعدی/قیمت باز" : "بسته‌شدن همان کندل"}`,
    `کیفیت داده: ${qualitySummary(quality)}`,
    `روش خروج: ${exitMode === "atr" ? "ATR خودکار (۱.۵× / ۳×)" : exitMode === "none" ? "بدون حد ثابت" : "ROI پوزیشن"}`,
    `SL: ${stopLossPercent || "خاموش"}${stopLossPercent ? `٪ ROI (${n(priceStop, 2)}٪ حرکت قیمت)` : ""} | TP: ${takeProfitPercent || "خاموش"}${takeProfitPercent ? `٪ ROI (${n(priceTarget, 2)}٪ حرکت قیمت)` : ""}`,
    `سرمایه: ${n(accountSize)} | ریسک هر معامله: ${riskPercent}٪`,
    "",
  ];
  sorted.forEach((row, index) => {
    const r = row.result;
    lines.push(
      `<b>${index + 1}. ${escapeHtml(labelText(row.label))}</b> (${escapeHtml(row.category || "—")})`,
      `بازده ${signed(r.totalReturnPercent)} | Buy & Hold ${signed(r.benchmarkReturnPercent)}`,
      `معامله ${r.tradeCount} | برد ${n(r.winRate, 1)}٪ | Profit Factor ${r.profitFactor === Infinity ? "∞" : n(r.profitFactor, 2)}`,
      `Sharpe ${n(r.sharpe, 2)} | Sortino ${n(r.sortino, 2)} | Max DD ${n(r.maxDrawdownPercent, 1)}٪`,
      `پارامترها: <code>${escapeHtml(JSON.stringify(row.params))}</code>`,
      ""
    );
  });
  if (best) {
    lines.push(
      `<b>وضعیت زنده‌ی استراتژی اول</b>`,
      `استراتژی: ${escapeHtml(labelText(best.label))}`,
      `حالت: ${current?.state ?? "flat"} | قیمت آخر: ${n(current?.lastClose)}`,
      current?.sinceTime ? `شروع حالت از: ${new Date(current.sinceTime * 1000).toISOString()}` : "زمان شروع حالت: —",
      ""
    );
  }
  lines.push("⚠️ نتیجه‌ی تاریخی تضمین عملکرد آینده نیست؛ هزینه، لغزش، لورج و زمان اجرای انتخابی در محاسبه لحاظ شده‌اند.");
  return lines.join("\n");
}

export function formatPositionSize({ accountSize, riskPercent, entryPrice, stopPrice }) {
  const result = positionSize({ accountSize, riskPercent, entryPrice, stopPrice });
  if (result.error) throw new Error(result.error);
  const riskAmount = Number(accountSize) * Number(riskPercent) / 100;
  const units = result.positionSize ?? result.units;
  return [
    "🧮 <b>محاسبه‌ی کامل حجم پوزیشن</b>",
    `سرمایه: ${n(accountSize)} | ریسک مجاز: ${riskPercent}٪ = ${n(riskAmount)}`,
    `قیمت ورود: ${n(entryPrice)} | حد ضرر: ${n(stopPrice)}`,
    `فاصله‌ی ورود تا حد ضرر: ${n(Math.abs(entryPrice - stopPrice))} (${n(Math.abs(entryPrice - stopPrice) / entryPrice * 100, 2)}٪)`,
    `حجم پیشنهادی: <b>${n(units, 8)} واحد</b>`,
    `ارزش پوزیشن: ${n(units * entryPrice)}`,
    "⚠️ هزینه‌ی معامله و slippage را جداگانه در نظر بگیر.",
  ].join("\n");
}

export function formatRiskReward({ entryPrice, stopPrice, targetPrice }) {
  const isLong = Number(stopPrice) < Number(entryPrice) && Number(targetPrice) > Number(entryPrice);
  const isShort = Number(stopPrice) > Number(entryPrice) && Number(targetPrice) < Number(entryPrice);
  if (!isLong && !isShort) throw new Error("برای Long باید Stop پایین‌تر و Target بالاتر از Entry باشد؛ برای Short برعکس.");
  const rr = riskRewardRatio({ entryPrice, stopPrice, targetPrice });
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  return [
    "⚖️ <b>تحلیل کامل ریسک به بازده</b>",
    `ورود: ${n(entryPrice)} | حد ضرر: ${n(stopPrice)} | هدف: ${n(targetPrice)}`,
    `ریسک هر واحد: ${n(risk)} | بازده بالقوه‌ی هر واحد: ${n(reward)}`,
    `نسبت R:R: <b>1:${n(rr, 2)}</b>`,
    rr >= 2 ? "ارزیابی: نسبت از نظر عددی مناسب است؛ احتمال موفقیت و کیفیت ستاپ همچنان باید بررسی شود." : rr >= 1 ? "ارزیابی: نسبت متوسط است و به نرخ برد بالاتری نیاز دارد." : "ارزیابی: بازده بالقوه از ریسک کمتر است.",
  ].join("\n");
}

export function formatAtrRisk({ symbol, timeframe, days, candles, direction, atrPeriod, atrMultiplier }) {
  const value = calculateATR(candles, atrPeriod);
  if (!Number.isFinite(value)) throw new Error("برای ATR داده‌ی کافی وجود ندارد.");
  const entry = candles.at(-1).close;
  const stop = atrStopSuggestion({ entryPrice: entry, atr: value, multiplier: atrMultiplier, direction })?.stopPrice;
  return [
    `📐 <b>حد ضرر ATR — ${escapeHtml(symbol)}</b>`,
    `${timeframe} | ${days} روز | دوره ATR: ${atrPeriod} | ضریب: ${atrMultiplier}`,
    `جهت: ${direction} | قیمت فعلی: ${n(entry)}`,
    `ATR: ${n(value)} (${n(value / entry * 100, 2)}٪ قیمت)`,
    `حد ضرر پیشنهادی: <b>${n(stop)}</b>`,
    `فاصله تا حد ضرر: ${n(Math.abs(entry - stop))} (${n(Math.abs(entry - stop) / entry * 100, 2)}٪)`,
    "⚠️ ATR فقط نوسان گذشته را اندازه می‌گیرد و تضمین نمی‌کند قیمت از حد پیشنهادی عبور نکند.",
  ].join("\n");
}
