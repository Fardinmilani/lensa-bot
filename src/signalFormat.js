import { escapeHtml } from "./telegram.js";

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const DIRECTION_FA = { long: "لانگ 📈", short: "شورت 📉" };

export function calculateSignalLevels({
  entryPrice,
  direction,
  marketType = "spot",
  leverage = 1,
  exitMode = "roi",
  stopLossPercent = 10,
  takeProfitPercent = 20,
  atr = null,
}) {
  const lev = marketType === "futures" ? Math.max(1, Number(leverage) || 1) : 1;
  let stopMovePercent;
  let targetMovePercent;
  if (exitMode === "atr" && Number.isFinite(Number(atr)) && Number(atr) > 0) {
    stopMovePercent = (Number(atr) * 1.5 / entryPrice) * 100;
    targetMovePercent = (Number(atr) * 3 / entryPrice) * 100;
  } else {
    // The wizard asks for position ROI. Futures ROI is approximately the
    // underlying price move multiplied by leverage (before fees/funding).
    stopMovePercent = Number(stopLossPercent) / lev;
    targetMovePercent = Number(takeProfitPercent) / lev;
  }
  const isLong = direction === "long";
  const stopLossPrice = entryPrice * (1 + (isLong ? -1 : 1) * stopMovePercent / 100);
  const takeProfitPrice = entryPrice * (1 + (isLong ? 1 : -1) * targetMovePercent / 100);
  const liquidationPrice = marketType === "futures"
    ? entryPrice * (1 + (isLong ? -1 : 1) / lev)
    : null;
  return {
    stopLossPrice,
    takeProfitPrice,
    stopMovePercent,
    targetMovePercent,
    stopRoiPercent: stopMovePercent * lev,
    targetRoiPercent: targetMovePercent * lev,
    liquidationPrice,
  };
}

export function capPositionSize({ sizing, accountSize, entryPrice, marketType = "spot", leverage = 1 }) {
  if (!sizing || sizing.error) return null;
  const account = Number(accountSize);
  const entry = Number(entryPrice);
  const lev = marketType === "futures" ? Math.max(1, Number(leverage) || 1) : 1;
  if (!(account > 0) || !(entry > 0)) return null;

  const requestedUnits = Number(sizing.units);
  const maxPositionValue = account * lev;
  const maxUnits = maxPositionValue / entry;
  const units = Math.min(requestedUnits, maxUnits);
  const positionValue = units * entry;
  const riskAmount = units * Number(sizing.perUnitRisk);

  return {
    ...sizing,
    requestedUnits,
    requestedRiskAmount: Number(sizing.riskAmount),
    units,
    positionValue,
    riskAmount,
    maxUnits,
    maxPositionValue,
    marginRequired: marketType === "futures" ? positionValue / lev : positionValue,
    capped: units + Number.EPSILON < requestedUnits,
  };
}

export function formatSignalMessage({
  symbol,
  timeframe,
  leverage,
  direction,
  strategyLabel,
  entryPrice,
  stopLossPrice,
  takeProfitPrice,
  stopLossPercent,
  takeProfitPercent,
  backtestReturnPercent,
  backtestWinRate,
  backtestTradeCount,
  marketType = leverage > 1 ? "futures" : "spot",
  stopMovePercent,
  targetMovePercent,
  liquidationPrice,
  positionSize,
  positionValue,
  accountRiskAmount,
  positionCapped,
  marginRequired,
}) {
  const marketLabel = marketType === "futures" ? `Futures · ${leverage}x` : "Spot";
  return (
    `🎯 <b>${escapeHtml(symbol)}</b> · ${escapeHtml(timeframe)} · ${marketLabel}\n\n` +
    `پوزیشن: <b>${DIRECTION_FA[direction] ?? escapeHtml(direction)}</b>\n` +
    `استراتژی انتخابی: ${escapeHtml(strategyLabel)}\n\n` +
    `ورود: <code>${fmt(entryPrice)}</code>\n` +
    `حد ضرر: <code>${fmt(stopLossPrice)}</code> (${fmt(stopMovePercent ?? stopLossPercent, 2)}٪ حرکت قیمت` +
      (marketType === "futures" ? ` ≈ ${fmt(stopLossPercent, 1)}٪ ROI` : "") + `)\n` +
    `حد سود: <code>${fmt(takeProfitPrice)}</code> (${fmt(targetMovePercent ?? takeProfitPercent, 2)}٪ حرکت قیمت` +
      (marketType === "futures" ? ` ≈ ${fmt(takeProfitPercent, 1)}٪ ROI` : "") + `)\n` +
    (liquidationPrice != null ? `لیکویید تقریبی: <code>${fmt(liquidationPrice)}</code>\n` : "") +
    (positionSize != null ? `\nحجم پیشنهادی: ${fmt(positionSize, 6)} واحد (ارزش ${fmt(positionValue)} USDT)\n` +
      (marketType === "futures" ? `مارجین تقریبی لازم: ${fmt(marginRequired)} USDT\n` : "") +
      `ریسک حساب تا استاپ: حدود ${fmt(accountRiskAmount)} USDT\n` +
      (positionCapped ? "ℹ️ حجم به سقف توان حساب/لورج محدود شده است.\n" : "") : "") +
    `\n` +
    `📊 بک‌تست این استراتژی روی همین بازه: بازدهی ${fmt(backtestReturnPercent, 1)}٪` +
    (backtestWinRate != null ? `، نرخ برد ${fmt(backtestWinRate, 0)}٪` : "") +
    (backtestTradeCount != null ? `، ${backtestTradeCount} معامله` : "") +
    `\n\n⚠️ این تحلیلِ بک‌تست تاریخیه، نه توصیه‌ی مالی. مسئولیت پوزیشن با خودته.`
  );
}

export function formatDetailMessage(signal, metadata = null) {
  let d = {};
  try { d = signal.backtest_detail_json ? JSON.parse(signal.backtest_detail_json) : {}; } catch { d = {}; }
  const lines = [`📈 <b>جزئیات ${escapeHtml(signal.symbol)} / ${escapeHtml(signal.strategy_label)}</b>`, ""];
  if (metadata?.marketType) lines.push(`بازار: ${metadata.marketType === "futures" ? `Futures ${metadata.leverage}x` : "Spot"}`);
  if (metadata?.backtestDays) lines.push(`بازه‌ی بک‌تست: ${metadata.backtestDays} روز`);
  if (metadata?.selectedBasis) lines.push(`معیار انتخاب: ${escapeHtml(metadata.selectedBasis)}`);
  if (metadata?.feePercent != null) lines.push(`کارمزد هر سمت: ${metadata.feePercent}٪`);
  if (metadata?.fillTiming) lines.push(`زمان اجرا: ${metadata.fillTiming === "nextOpen" ? "بازشدن کندل بعد" : "بسته‌شدن همان کندل"}`);
  if (d.params) lines.push(`پارامترهای فیت‌شده: <code>${escapeHtml(JSON.stringify(d.params))}</code>`);
  if (d.fit?.testedCount) lines.push(`ترکیب‌های پارامتر آزمایش‌شده: ${d.fit.testedCount}`);
  if (d.fit?.validation?.available) {
    lines.push(`Walk-Forward: ${d.fit.validation.trainCandles} کندل آموزش + ${d.fit.validation.testCandles} کندل آزمون دست‌نخورده`);
    lines.push(`بازده خارج‌ازنمونه‌ی فیت‌شده: ${fmt(d.fit.validation.fittedReturnPercent, 2)}٪ | پیش‌فرض: ${fmt(d.fit.validation.defaultReturnPercent, 2)}٪`);
    lines.push(d.fit.validation.passed ? "نتیجه: برتری پارامتر فیت‌شده در خارج نمونه حفظ شد." : "نتیجه: برتری پارامتر فیت‌شده در خارج نمونه تأیید نشد؛ ریسک overfitting بالاتر است.");
  }
  if (d.totalReturnPercent != null) lines.push(`بازده کل: ${fmt(d.totalReturnPercent, 2)}٪`);
  if (d.winRate != null) lines.push(`نرخ برد: ${fmt(d.winRate, 1)}٪`);
  if (d.tradeCount != null) lines.push(`تعداد معاملات: ${d.tradeCount}`);
  if (d.sharpe != null) lines.push(`Sharpe: ${fmt(d.sharpe, 2)}`);
  if (d.sortino != null) lines.push(`Sortino: ${fmt(d.sortino, 2)}`);
  if (d.maxDrawdownPercent != null) lines.push(`حداکثر افت (Max Drawdown): ${fmt(d.maxDrawdownPercent, 1)}٪`);
  if (d.profitFactorInfinite) lines.push("Profit Factor: ∞");
  else if (d.profitFactor != null && Number.isFinite(d.profitFactor)) lines.push(`Profit Factor: ${fmt(d.profitFactor, 2)}`);
  if (d.benchmarkReturnPercent != null) lines.push(`بازدهی Buy & Hold برای مقایسه: ${fmt(d.benchmarkReturnPercent, 1)}٪`);
  if (metadata?.levels) {
    lines.push("");
    lines.push("<b>محاسبه‌ی حدها</b>");
    lines.push(`حرکت قیمت تا SL: ${fmt(metadata.levels.stopMovePercent, 2)}٪`);
    lines.push(`حرکت قیمت تا TP: ${fmt(metadata.levels.targetMovePercent, 2)}٪`);
    if (metadata.marketType === "futures") {
      lines.push(`ROI تقریبی SL: ${fmt(metadata.levels.stopRoiPercent, 1)}٪`);
      lines.push(`ROI تقریبی TP: ${fmt(metadata.levels.targetRoiPercent, 1)}٪`);
      lines.push(`لیکویید تقریبی: ${fmt(metadata.levels.liquidationPrice, 2)}`);
    }
  }
  if (metadata?.sizing) {
    lines.push("");
    lines.push("<b>اندازه پوزیشن</b>");
    lines.push(`ریسک حساب: ${fmt(metadata.sizing.riskAmount, 2)} USDT`);
    lines.push(`حجم: ${fmt(metadata.sizing.units, 8)} واحد`);
    lines.push(`ارزش پوزیشن: ${fmt(metadata.sizing.positionValue, 2)} USDT`);
    if (metadata.marketType === "futures") lines.push(`مارجین تقریبی لازم: ${fmt(metadata.sizing.marginRequired, 2)} USDT`);
    if (metadata.sizing.capped) {
      lines.push(`حجم خام فرمول ریسک: ${fmt(metadata.sizing.requestedUnits, 8)} واحد`);
      lines.push("حجم نهایی به سقف خرید حساب/لورج محدود شده است؛ بنابراین ریسک واقعی از درصد درخواستی کمتر است.");
    }
  }
  if (lines.length === 2) lines.push("جزئیات بیشتری ثبت نشده.");
  return lines.join("\n");
}

export function formatNoStrategyMessage({ symbol, timeframe }) {
  return (
    `🤔 هیچ‌کدوم از استراتژی‌ها روی <b>${escapeHtml(symbol)}</b> (${escapeHtml(timeframe)}) توی این بازه بازدهی مثبت نداشتن.\n` +
    `فعلاً سیگنالی صادر نمی‌کنم — بعداً دوباره امتحان کن.`
  );
}

export function formatFlatMessage({ symbol, timeframe, strategyLabel }) {
  return (
    `📍 استراتژی انتخابی <b>${escapeHtml(strategyLabel)}</b> روی <b>${escapeHtml(symbol)}</b> (${escapeHtml(timeframe)}) فیت و بررسی شد،\n` +
    `ولی همین الان توی حالت flat‌ـه (نه long نه short). فعلاً پوزیشنی پیشنهاد نمی‌شه.`
  );
}

export function formatResolvedNotification(signal, resolvedPrice) {
  const hitTp = signal.status === "hit_tp";
  const emoji = hitTp ? "✅" : "🛑";
  const label = hitTp ? "به حد سود خورد" : "به حد ضرر خورد";
  return (
    `${emoji} سیگنال <b>${escapeHtml(signal.symbol)}</b> (${escapeHtml(signal.strategy_label)}, ${DIRECTION_FA[signal.direction] ?? signal.direction}) ${label}.\n` +
    `ورود: <code>${fmt(signal.entry_price)}</code> → خروج: <code>${fmt(resolvedPrice)}</code>`
  );
}
