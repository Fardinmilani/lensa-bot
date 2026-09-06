import { escapeHtml } from "./telegram.js";

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const DIRECTION_FA = { long: "لانگ 📈", short: "شورت 📉" };

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
}) {
  return (
    `🎯 <b>${escapeHtml(symbol)}</b> — ${escapeHtml(timeframe)} — لورج ${leverage}x\n\n` +
    `پوزیشن: <b>${DIRECTION_FA[direction] ?? escapeHtml(direction)}</b>\n` +
    `استراتژی برنده: ${escapeHtml(strategyLabel)}\n\n` +
    `ورود: <code>${fmt(entryPrice)}</code>\n` +
    `حد ضرر: <code>${fmt(stopLossPrice)}</code> (${stopLossPercent}٪)\n` +
    `حد سود: <code>${fmt(takeProfitPrice)}</code> (${takeProfitPercent}٪)\n\n` +
    `📊 بک‌تست این استراتژی روی همین بازه: بازدهی ${fmt(backtestReturnPercent, 1)}٪` +
    (backtestWinRate != null ? `، نرخ برد ${fmt(backtestWinRate, 0)}٪` : "") +
    (backtestTradeCount != null ? `، ${backtestTradeCount} معامله` : "") +
    `\n\n⚠️ این تحلیلِ بک‌تست تاریخیه، نه توصیه‌ی مالی. مسئولیت پوزیشن با خودته.`
  );
}

export function formatDetailMessage(signal) {
  const d = signal.backtest_detail_json ? JSON.parse(signal.backtest_detail_json) : {};
  const lines = [`📈 <b>جزئیات ${escapeHtml(signal.symbol)} / ${escapeHtml(signal.strategy_label)}</b>`, ""];
  if (d.sharpe != null) lines.push(`Sharpe: ${fmt(d.sharpe, 2)}`);
  if (d.sortino != null) lines.push(`Sortino: ${fmt(d.sortino, 2)}`);
  if (d.maxDrawdownPercent != null) lines.push(`حداکثر افت (Max Drawdown): ${fmt(d.maxDrawdownPercent, 1)}٪`);
  if (d.profitFactor != null && Number.isFinite(d.profitFactor)) lines.push(`Profit Factor: ${fmt(d.profitFactor, 2)}`);
  if (d.benchmarkReturnPercent != null) lines.push(`بازدهی Buy & Hold برای مقایسه: ${fmt(d.benchmarkReturnPercent, 1)}٪`);
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
    `📍 استراتژی <b>${escapeHtml(strategyLabel)}</b> روی <b>${escapeHtml(symbol)}</b> (${escapeHtml(timeframe)}) توی بک‌تست بازدهی مثبت داشته،\n` +
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
