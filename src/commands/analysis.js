import { answerCallbackQuery, escapeHtml, sendLongMessage, sendMessage, sendOrEditMessage } from "../telegram.js";
import { fetchCandles, normalizeSymbol, VALID_TIMEFRAMES } from "../marketData.js";
import { STRATEGIES } from "../lib/strategies.js";
import { labelText } from "../lib/singleStrategyFit.js";
import * as db from "../db.js";
import {
  candleCount,
  formatAtrRisk,
  formatBacktestAnalysis,
  formatDecisionAnalysis,
  formatForecastAnalysis,
  formatMarketAnalysis,
  formatPositionSize,
  formatRiskReward,
} from "../analysisEngine.js";
import { mainMenuMarkup } from "./menu.js";
import { assertUsableCandles } from "../dataQuality.js";

const FLOW_TITLES = {
  market: "داشبورد بازار",
  decision: "مرکز تصمیم",
  forecast: "Forecast مونت‌کارلو",
  backtest: "Backtest حرفه‌ای",
  risk_position: "حجم پوزیشن",
  risk_atr: "حد ضرر ATR",
  risk_rr: "ریسک به بازده",
};

export function analysisHubKeyboard() {
  return { inline_keyboard: [
    [{ text: "📊 داشبورد بازار", callback_data: "ana:start:market" }, { text: "🧭 مرکز تصمیم", callback_data: "ana:start:decision" }],
    [{ text: "🔮 Forecast", callback_data: "ana:start:forecast" }, { text: "🧪 Backtest", callback_data: "ana:start:backtest" }],
    [{ text: "🧮 حجم پوزیشن", callback_data: "ana:start:risk_position" }, { text: "📐 حد ضرر ATR", callback_data: "ana:start:risk_atr" }],
    [{ text: "⚖️ ریسک به بازده", callback_data: "ana:start:risk_rr" }],
    [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
  ] };
}

export async function handleAnalysisHub(env, message) {
  await db.clearSession(env, message.from.id);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    "<b>مرکز قابلیت‌های Lensa</b>\n\nهر ابزار جریان کامل خودش را دارد و ورودی‌هایش را جداگانه می‌پرسد. خروجی‌ها شامل جزئیات محاسبه، فرض‌ها و هشدارهای همان بخش‌اند.",
    { reply_markup: analysisHubKeyboard() });
}

function sequence(data) {
  const common = ["symbol", "timeframe", "days"];
  if (data.flow === "market") return common;
  if (data.flow === "forecast") return [...common, "horizon", "method", ...(data.method === "blockBootstrap" ? ["blockSize"] : []), "driftMode", "sims"];
  if (data.flow === "decision") return ["symbol", "marketType", "timeframe", "days", ...(data.marketType === "futures" ? ["leverage"] : []), "accountSize", ...(Number(data.accountSize) > 0 ? ["riskPercent"] : []), "fee", "slippage"];
  if (data.flow === "backtest") return [
    "symbol", "marketType", "timeframe", "days",
    ...(data.marketType === "futures" ? ["direction", "leverage"] : []),
    "backtestMode", ...(data.backtestMode === "single" ? ["strategyKey"] : []),
    "fee", "fill", "exitMode", ...(data.exitMode === "roi" ? ["stopLossPercent", "takeProfitPercent"] : []),
    "accountSize", ...(Number(data.accountSize) > 0 && data.exitMode !== "none" ? ["riskPercent"] : []),
  ];
  if (data.flow === "risk_position") return ["accountSize", "riskPercent", "entryPrice", "stopPrice"];
  if (data.flow === "risk_rr") return ["entryPrice", "stopPrice", "targetPrice"];
  if (data.flow === "risk_atr") return [...common, "direction", "atrPeriod", "atrMultiplier"];
  return [];
}

function chunkRows(buttons, size = 4) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) rows.push(buttons.slice(i, i + size));
  return rows;
}

function withNav(rows, customField = null) {
  const result = [...rows];
  if (customField) result.push([{ text: "⌨️ مقدار دلخواه", callback_data: `ana:custom:${customField}` }]);
  result.push([{ text: "↩️ ابزارهای Lensa", callback_data: "ana:hub" }, { text: "❌ لغو", callback_data: "menu:cancel" }]);
  return { inline_keyboard: result };
}

function options(field, data) {
  const button = (text, value) => ({ text, callback_data: `ana:set:${field}:${value}` });
  if (field === "symbol") return withNav(chunkRows([
    button("₿ BTC", "BTCUSDT"), button("Ξ ETH", "ETHUSDT"), button("🟡 BNB", "BNBUSDT"),
    button("◎ SOL", "SOLUSDT"), button("✕ XRP", "XRPUSDT"), button("🐕 DOGE", "DOGEUSDT"),
  ], 2), "symbol");
  if (field === "marketType") return withNav([[button("🟢 Spot", "spot"), button("⚡ Futures", "futures")]]);
  if (field === "timeframe") return withNav([VALID_TIMEFRAMES.map((tf) => button(tf, tf))]);
  if (field === "days") return withNav(chunkRows([7, 14, 30, 60, 90, 180, 365].map((v) => button(`${v} روز`, v)), 4));
  if (field === "horizon") return withNav(chunkRows([12, 24, 48, 72, 120, 240].map((v) => button(`${v} کندل`, v)), 3), "horizon");
  if (field === "method") return withNav([[button("Bootstrap", "bootstrap"), button("Block Bootstrap", "blockBootstrap")], [button("GBM", "gbm")]]);
  if (field === "blockSize") return withNav([chunkRows([3, 5, 10, 20].map((v) => button(String(v), v)), 4)[0]], "blockSize");
  if (field === "driftMode") return withNav([[button("میانگین تاریخی", "historical"), button("Drift صفر", "zero")]]);
  if (field === "sims") return withNav([[button("سریع · 1,000", 1000), button("متعادل · 3,000", 3000), button("دقیق · 8,000", 8000)]]);
  if (field === "direction") return withNav([data.flow === "risk_atr"
    ? [button("Long", "long"), button("Short", "short")]
    : [button("Long", "long"), button("Short", "short"), button("هر دو", "both")]]);
  if (field === "leverage") return withNav([chunkRows([2, 3, 5, 10, 20].map((v) => button(`${v}x`, v)), 5)[0], [button("⏭ پیش‌فرض 3x", 3)]], "leverage");
  if (field === "backtestMode") return withNav([[button("یک استراتژی", "single"), button("مقایسه‌ی همه", "all")]]);
  if (field === "strategyKey") {
    const buttons = Object.entries(STRATEGIES).filter(([, strategy]) => strategy.category !== "benchmark")
      .map(([key, strategy]) => button(labelText(strategy.label), key));
    return withNav(chunkRows(buttons, 1));
  }
  if (field === "fee") return withNav([[button("0.05٪", 0.05), button("0.1٪", 0.1), button("0.2٪", 0.2), button("0.5٪", 0.5)], [button("⏭ پیش‌فرض 0.1٪", 0.1)]], "fee");
  if (field === "slippage") return withNav([[button("صفر", 0), button("0.05٪", 0.05), button("0.1٪", 0.1), button("0.2٪", 0.2)], [button("⏭ پیش‌فرض 0.05٪", 0.05)]], "slippage");
  if (field === "fill") return withNav([[button("Close همان کندل", "close"), button("Next Open", "nextOpen")], [button("⏭ پیش‌فرض Next Open", "nextOpen")]]);
  if (field === "exitMode") return withNav([[button("٪ ROI", "roi"), button("ATR خودکار", "atr")], [button("⏭ بدون حد درصدی", "none")]]);
  if (field === "stopLossPercent") return withNav([chunkRows([5, 10, 15, 20, 30].map((v) => button(`${v}٪ ROI`, v)), 5)[0]], "stopLossPercent");
  if (field === "takeProfitPercent") return withNav([chunkRows([10, 20, 30, 50, 100].map((v) => button(`${v}٪ ROI`, v)), 5)[0]], "takeProfitPercent");
  if (field === "accountSize") {
    const values = data.flow === "risk_position" ? [1000, 5000, 10000, 25000] : [0, 1000, 5000, 10000, 25000];
    return withNav(chunkRows(values.map((v) => button(v === 0 ? "⏭ بدون محاسبه حجم" : `${v.toLocaleString("en-US")} USDT`, v)), 2), "accountSize");
  }
  if (field === "riskPercent") return withNav([chunkRows([0.5, 1, 2, 3, 5].map((v) => button(`${v}٪`, v)), 5)[0]], "riskPercent");
  if (field === "entryPrice" || field === "stopPrice" || field === "targetPrice") return withNav([], field);
  if (field === "atrPeriod") return withNav([[button("7", 7), button("14 استاندارد", 14), button("21", 21), button("30", 30)]], "atrPeriod");
  if (field === "atrMultiplier") return withNav([[button("1x", 1), button("1.5x", 1.5), button("2x استاندارد", 2), button("3x", 3)]], "atrMultiplier");
  return withNav([]);
}

function prompt(field, data, index, total) {
  const head = `<b>${FLOW_TITLES[data.flow]} · ${index + 1}/${total}</b>`;
  const body = {
    symbol: "دارایی را انتخاب کن.", marketType: "نوع بازار را انتخاب کن.", timeframe: "تایم‌فریم کندل‌ها را انتخاب کن.",
    days: "طول تاریخچه‌ی مورد استفاده را انتخاب کن.", horizon: "افق آینده چند کندل باشد؟", method: "روش شبیه‌سازی را انتخاب کن.",
    blockSize: "اندازه‌ی بلوک بازنمونه‌گیری را انتخاب کن.", driftMode: "فرض Drift را انتخاب کن.", sims: "دقت/تعداد مسیرهای شبیه‌سازی را انتخاب کن.",
    direction: "جهت معامله را انتخاب کن.", leverage: "لورج را انتخاب کن یا مقدار دلخواه بده.", backtestMode: "یک استراتژی یا مقایسه‌ی کامل؟",
    strategyKey: "استراتژی را انتخاب کن.", fee: "کارمزد هر سمت معامله را مشخص کن.", slippage: "لغزش قیمت هر سمت را مشخص کن.",
    fill: "فرض زمان اجرای سفارش را انتخاب کن.", exitMode: "روش خروج و حدها را انتخاب کن.", stopLossPercent: "حد ضرر را به درصد ROI پوزیشن انتخاب کن.",
    takeProfitPercent: "تارگت را به درصد ROI پوزیشن انتخاب کن.", accountSize: "اندازه حساب را وارد کن یا محاسبه حجم را رد کن.",
    riskPercent: "درصد ریسک حساب در هر معامله را انتخاب کن.", entryPrice: "قیمت ورود را با «مقدار دلخواه» وارد کن.", stopPrice: "قیمت حد ضرر را وارد کن.",
    targetPrice: "قیمت هدف را وارد کن.", atrPeriod: "دوره‌ی ATR را انتخاب کن.", atrMultiplier: "ضریب فاصله‌ی ATR را انتخاب کن.",
  }[field] ?? "انتخاب کن.";
  return `${head}\n\n${body}`;
}

async function askCurrent(env, message, data) {
  const fields = sequence(data);
  const field = fields.find((name) => data[name] === undefined);
  if (!field) return execute(env, message, data);
  const index = fields.indexOf(field);
  await db.setSession(env, message.from.id, `analysis_${field}`, data);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, prompt(field, data, index, fields.length), { reply_markup: options(field, data) });
}

async function startFlow(env, message, flow) {
  if (!FLOW_TITLES[flow]) return handleAnalysisHub(env, message);
  await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  return askCurrent(env, message, { flow });
}

export async function handleAnalysisFeatureStart(env, message, flow) {
  return startFlow(env, message, flow);
}

function parseValue(field, raw) {
  if (["symbol", "marketType", "timeframe", "method", "driftMode", "direction", "backtestMode", "strategyKey", "fill", "exitMode"].includes(field)) return raw;
  return Number(raw);
}

function customValue(field, text) {
  if (field === "symbol") {
    const symbol = normalizeSymbol(text);
    return /^[A-Z0-9]{5,20}$/.test(symbol) ? symbol : null;
  }
  const value = Number(String(text || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  const ranges = {
    horizon: [1, 2000], blockSize: [1, 60], leverage: [1, 125], fee: [0, 5], slippage: [0, 5],
    stopLossPercent: [0.01, 95], takeProfitPercent: [0.01, 1000], accountSize: [0, 1e12], riskPercent: [0.01, 100],
    entryPrice: [0.00000001, 1e15], stopPrice: [0.00000001, 1e15], targetPrice: [0.00000001, 1e15], atrPeriod: [2, 200], atrMultiplier: [0.1, 20],
  };
  const [min, max] = ranges[field] ?? [0, 1e15];
  return value >= min && value <= max ? value : null;
}

export async function handleAnalysisText(env, message, session) {
  if (session.step !== "analysis_custom") return sendMessage(env, message.chat.id, "برای ادامه از دکمه‌های مرحله‌ی فعلی استفاده کن.");
  const field = session.data.pendingField;
  const value = customValue(field, message.text);
  if (value == null || (field === "accountSize" && session.data.flow === "risk_position" && value <= 0)) return sendMessage(env, message.chat.id, "مقدار معتبر نیست. عدد مثبت و در محدوده‌ی منطقی وارد کن.");
  const data = { ...session.data, [field]: value };
  delete data.pendingField;
  return askCurrent(env, message, data);
}

export async function handleAnalysisCallback(env, callbackQuery) {
  const [, action, fieldOrFlow, rawValue] = callbackQuery.data.split(":");
  const message = { chat: callbackQuery.message.chat, from: callbackQuery.from, editMessageId: callbackQuery.message.message_id };
  if (action === "hub") {
    await answerCallbackQuery(env, callbackQuery.id);
    return handleAnalysisHub(env, message);
  }
  if (action === "start") {
    await answerCallbackQuery(env, callbackQuery.id);
    return startFlow(env, message, fieldOrFlow);
  }
  const session = await db.getSession(env, callbackQuery.from.id);
  if (!session || !session.step.startsWith("analysis_")) return answerCallbackQuery(env, callbackQuery.id, "این فرم دیگر فعال نیست.");
  if (action === "custom") {
    if (session.step !== `analysis_${fieldOrFlow}`) return answerCallbackQuery(env, callbackQuery.id, "این دکمه مربوط به مرحله‌ی فعلی نیست.");
    await db.setSession(env, callbackQuery.from.id, "analysis_custom", { ...session.data, pendingField: fieldOrFlow });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, message.chat.id, "مقدار دلخواه را در یک پیام بفرست:");
  }
  if (action !== "set" || session.step !== `analysis_${fieldOrFlow}`) return answerCallbackQuery(env, callbackQuery.id, "این دکمه مربوط به مرحله‌ی فعلی نیست.");
  await answerCallbackQuery(env, callbackQuery.id);
  return askCurrent(env, message, { ...session.data, [fieldOrFlow]: parseValue(fieldOrFlow, rawValue) });
}

async function execute(env, message, data) {
  await db.clearSession(env, message.from.id);
  await sendOrEditMessage(env, message.chat.id, message.editMessageId, `⏳ در حال اجرای ${FLOW_TITLES[data.flow]} با تمام تنظیمات انتخاب‌شده…`);
  try {
    let text;
    if (data.flow === "risk_position") text = formatPositionSize(data);
    else if (data.flow === "risk_rr") text = formatRiskReward(data);
    else {
      const candles = await fetchCandles(data.symbol, data.timeframe, candleCount(data.timeframe, data.days));
      assertUsableCandles(candles, data.timeframe);
      if (data.flow === "market") text = formatMarketAnalysis({ ...data, candles });
      else if (data.flow === "forecast") text = formatForecastAnalysis({ ...data, candles, blockSize: data.blockSize ?? 5 });
      else if (data.flow === "decision") text = formatDecisionAnalysis({ ...data, candles, leverage: data.leverage ?? 1 });
      else if (data.flow === "backtest") text = formatBacktestAnalysis({
        ...data, candles, leverage: data.leverage ?? 1, direction: data.direction ?? "long",
        stopLossPercent: data.exitMode === "roi" ? data.stopLossPercent ?? 0 : data.exitMode === "atr" ? (calculateATRPercent(candles) * 1.5 * (data.leverage ?? 1)) : 0,
        takeProfitPercent: data.exitMode === "roi" ? data.takeProfitPercent ?? 0 : data.exitMode === "atr" ? (calculateATRPercent(candles) * 3 * (data.leverage ?? 1)) : 0,
        riskPercent: data.riskPercent ?? 0,
      });
      else if (data.flow === "risk_atr") text = formatAtrRisk({ ...data, candles });
    }
    return sendLongMessage(env, message.chat.id, text, { reply_markup: analysisHubKeyboard() });
  } catch (err) {
    console.error("analysis flow failed", err);
    return sendMessage(env, message.chat.id,
      `⚠️ اجرای این تحلیل کامل نشد.\n\nعلت: ${escapeHtml(String(err?.message ?? err))}\n\nمی‌توانی تنظیمات دیگری امتحان کنی.`,
      { reply_markup: analysisHubKeyboard() });
  }
}

function calculateATRPercent(candles) {
  if (!Array.isArray(candles) || candles.length < 15) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  let value = ranges.slice(0, 14).reduce((sum, item) => sum + item, 0) / 14;
  for (let i = 14; i < ranges.length; i++) value = (value * 13 + ranges[i]) / 14;
  return value / candles.at(-1).close * 100;
}
