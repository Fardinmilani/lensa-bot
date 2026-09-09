import { sendMessage, sendOrEditMessage, answerCallbackQuery, escapeHtml } from "../telegram.js";
import * as db from "../db.js";
import { candleSourceLabel, checkCandleSources, normalizeSymbol, VALID_TIMEFRAMES } from "../marketData.js";
import { mainMenuMarkup } from "./menu.js";

const SYMBOL_OPTIONS = [
  ["₿ BTC", "BTCUSDT"], ["Ξ ETH", "ETHUSDT"], ["🟡 BNB", "BNBUSDT"],
  ["◎ SOL", "SOLUSDT"], ["✕ XRP", "XRPUSDT"], ["🐕 DOGE", "DOGEUSDT"],
];
const BACKTEST_DAYS = {
  "15m": [7, 14, 30], "1h": [14, 30, 60, 90], "4h": [30, 60, 90, 180], "1d": [90, 180, 365],
};
const PERIODS_PER_DAY = { "15m": 96, "1h": 24, "4h": 6, "1d": 1 };

function valueRows(values, prefix, label = String, perRow = 4) {
  const result = [];
  for (let i = 0; i < values.length; i += perRow) {
    result.push(values.slice(i, i + perRow).map((value) => ({ text: label(value), callback_data: `${prefix}:${value}` })));
  }
  return result;
}

function keyboard(buttonRows, { custom, skip, back = true, cancel = true } = {}) {
  const result = [...buttonRows];
  if (custom) result.push([{ text: `⌨️ ${custom.label}`, callback_data: custom.data }]);
  if (skip) result.push([{ text: `⏭ ${skip.label}`, callback_data: skip.data }]);
  if (back) result.push([{ text: "⬅️ مرحله قبل", callback_data: "wz:back" }]);
  if (cancel) result.push([{ text: "❌ لغو و بازگشت", callback_data: "menu:cancel" }]);
  return { inline_keyboard: result };
}

function symbolKeyboard() {
  const result = [];
  for (let i = 0; i < SYMBOL_OPTIONS.length; i += 2) {
    result.push(SYMBOL_OPTIONS.slice(i, i + 2).map(([text, symbol]) => ({ text, callback_data: `wz:symbol:${symbol}` })));
  }
  return keyboard(result, { custom: { label: "نماد دیگر", data: "wz:custom:symbol" }, back: false });
}

async function setAndAsk(env, userId, step, data, chatId, text, replyMarkup, editMessageId = null) {
  await db.setSession(env, userId, step, data);
  return sendOrEditMessage(env, chatId, editMessageId, text, { reply_markup: replyMarkup });
}

async function askMarketType(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_market_type", data, message.chat.id,
    "<b>نوع بازار</b>\n\nدر Spot فقط لانگ و بدون لیکویید داریم. در Futures جهت و لورج را هم جدا انتخاب می‌کنی.",
    keyboard([[{ text: "🟢 Spot", callback_data: "wz:market:spot" }, { text: "⚡ Futures", callback_data: "wz:market:futures" }]]), message.editMessageId);
}

async function askTimeframe(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_timeframe", data, message.chat.id,
    "<b>تایم‌فریم</b>\n\nفاصله‌ی هر کندل را انتخاب کن:",
    keyboard([VALID_TIMEFRAMES.map((tf) => ({ text: tf, callback_data: `wz:tf:${tf}` }))]), message.editMessageId);
}

async function askDays(env, message, data) {
  const options = BACKTEST_DAYS[data.timeframe] ?? [30, 60, 90];
  return setAndAsk(env, message.from.id, "signal_days", data, message.chat.id,
    "<b>بازه‌ی فیت و بک‌تست</b>\n\nتمام استراتژی‌ها روی چند روز اخیر فیت و بک‌تست شوند؟",
    keyboard(valueRows(options, "wz:days", (value) => `${value} روز`, 4)), message.editMessageId);
}

async function askDataSource(env, message, data) {
  const requested = Math.max(60, Math.ceil(Number(data.backtestDays) * (PERIODS_PER_DAY[data.timeframe] ?? 1)));
  await sendOrEditMessage(env, message.chat.id, message.editMessageId,
    `⏳ در حال بررسی منبع‌های واقعی برای <b>${escapeHtml(data.symbol)}</b> · ${data.timeframe} · ${data.backtestDays} روز…`);
  const checks = await checkCandleSources(data.symbol, data.timeframe, requested);
  const available = checks.filter((item) => item.available);
  const status = checks.map((item) =>
    `${item.available ? "✅" : "❌"} <b>${item.label}</b> — ${item.available ? `${item.candleCount} کندل · ${item.latencyMs}ms` : escapeHtml(item.error)}`
  ).join("\n");
  const rows = available.map((item) => [{
    text: `${item.kind === "exchange" ? "🏦" : "🌐"} ${item.label} · ${item.candleCount} کندل`,
    callback_data: `wz:source:${item.id}`,
  }]);
  if (!available.length) rows.push([{ text: "🔄 بررسی دوباره", callback_data: "wz:retry:sources" }]);
  const dataWithChecks = { ...data, sourceChecks: checks.map(({ id, label, available: ok, candleCount, requested: wanted }) => ({ id, label, available: ok, candleCount, requested: wanted })) };
  await db.setSession(env, message.from.id, "signal_source", dataWithChecks);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    `<b>انتخاب منبع داده</b>\n\nفقط منبع‌هایی که همین الان برای نماد، تایم‌فریم و بازه‌ی انتخابی پاسخ سالم داده‌اند قابل انتخاب‌اند.\n\n${status}\n\n${available.length ? "تحلیل بر اساس دیتای کدام منبع انجام شود؟" : "فعلاً هیچ منبعی پوشش کافی ندارد؛ دوباره بررسی کن یا به مرحله قبل برگرد."}`,
    { reply_markup: keyboard(rows) });
}

async function askDirection(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_direction", data, message.chat.id,
    "<b>جهت Futures</b>\n\nمی‌توانی یک جهت را محدود کنی یا بررسی هر دو جهت را به ربات بسپاری.",
    keyboard([[
      { text: "↕️ هر دو", callback_data: "wz:dir:both" },
      { text: "📈 Long", callback_data: "wz:dir:long" },
      { text: "📉 Short", callback_data: "wz:dir:short" },
    ]], { skip: { label: "پیش‌فرض: هر دو", data: "wz:dir:both" } }), message.editMessageId);
}

async function askLeverage(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_leverage", data, message.chat.id,
    "<b>لورج</b>\n\nاگر انتخاب نکنی، مقدار محافظه‌کارانه‌ی 3x اعمال می‌شود.",
    keyboard(valueRows([2, 3, 5, 10, 20], "wz:lev", (value) => `${value}x`, 5), {
      custom: { label: "لورج دلخواه", data: "wz:custom:leverage" },
      skip: { label: "انتخاب نمی‌کنم — 3x", data: "wz:lev:3" },
    }), message.editMessageId);
}

async function askFee(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_fee", data, message.chat.id,
    "<b>کارمزد</b>\n\nکارمزد هر سمت معامله را مشخص کن. اگر مطمئن نیستی، پیش‌فرض مناسب است.",
    keyboard(valueRows([0.05, 0.1, 0.2, 0.5], "wz:fee", (value) => `${value}٪`, 4), {
      custom: { label: "کارمزد دلخواه", data: "wz:custom:feePercent" },
      skip: { label: "پیش‌فرض 0.1٪", data: "wz:fee:0.1" },
    }), message.editMessageId);
}

async function askFill(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_fill", data, message.chat.id,
    "<b>زمان اجرای معامله در بک‌تست</b>\n\n" +
    "Close همان کندل خوش‌بینانه‌تر است. Next Open تأخیر اجرای واقعی را بهتر شبیه‌سازی می‌کند.",
    keyboard([[
      { text: "Close همان کندل", callback_data: "wz:fill:close" },
      { text: "Next Open", callback_data: "wz:fill:nextOpen" },
    ]], { skip: { label: "پیش‌فرض: Next Open", data: "wz:fill:nextOpen" } }), message.editMessageId);
}

async function askExitMode(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_exit_mode", data, message.chat.id,
    "<b>روش محاسبه‌ی حدها</b>\n\n" +
    "• ROI پوزیشن: درصد سود/زیان پوزیشن است و در Futures بر لورج تقسیم می‌شود.\n" +
    "• ATR خودکار: حدها از نوسان واقعی بازار ساخته می‌شوند.",
    keyboard([[
      { text: "٪ ROI پوزیشن", callback_data: "wz:exit:roi" },
      { text: "📐 ATR خودکار", callback_data: "wz:exit:atr" },
    ]], { skip: { label: "انتخاب نمی‌کنم — ATR", data: "wz:exit:atr" } }), message.editMessageId);
}

async function askStopLoss(env, message, data) {
  const example = data.marketType === "futures"
    ? `\nمثال: 10٪ ROI با لورج ${data.leverage}x ≈ ${Number(10 / data.leverage).toFixed(2)}٪ حرکت خلاف قیمت.`
    : "\nدر Spot درصد ROI با درصد حرکت قیمت یکسان است.";
  return setAndAsk(env, message.from.id, "signal_stop_loss", data, message.chat.id,
    `<b>حد ضرر · ROI پوزیشن</b>${example}`,
    keyboard(valueRows([5, 10, 15, 20, 30], "wz:sl", (value) => `${value}٪`, 5), {
      custom: { label: "حد ضرر دلخواه", data: "wz:custom:stopLossPercent" },
      skip: { label: "پیش‌فرض 10٪", data: "wz:sl:10" },
    }), message.editMessageId);
}

async function askTakeProfit(env, message, data) {
  const example = data.marketType === "futures"
    ? `\nمثال: 50٪ ROI با لورج ${data.leverage}x ≈ ${Number(50 / data.leverage).toFixed(2)}٪ حرکت موافق قیمت.`
    : "";
  return setAndAsk(env, message.from.id, "signal_take_profit", data, message.chat.id,
    `<b>تارگت · ROI پوزیشن</b>${example}`,
    keyboard(valueRows([10, 20, 30, 50, 100], "wz:tp", (value) => `${value}٪`, 5), {
      custom: { label: "تارگت دلخواه", data: "wz:custom:takeProfitPercent" },
      skip: { label: "پیش‌فرض 20٪", data: "wz:tp:20" },
    }), message.editMessageId);
}

async function askAccountSize(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_account", data, message.chat.id,
    "<b>اندازه‌ی پوزیشن</b>\n\nاندازه‌ی حساب را برای محاسبه‌ی حجم پوزیشن انتخاب کن. این بخش اختیاری است.",
    keyboard(valueRows([1000, 5000, 10000, 25000], "wz:account", (value) => `${value.toLocaleString("en-US")} USDT`, 2), {
      custom: { label: "سرمایه‌ی دلخواه", data: "wz:custom:accountSize" },
      skip: { label: "حجم پوزیشن لازم نیست", data: "wz:account:0" },
    }), message.editMessageId);
}

async function askRiskPercent(env, message, data) {
  return setAndAsk(env, message.from.id, "signal_risk", data, message.chat.id,
    "<b>ریسک هر معامله</b>\n\nچند درصد از کل حساب در صورت برخورد به حد ضرر از دست برود؟",
    keyboard(valueRows([0.5, 1, 2, 3, 5], "wz:risk", (value) => `${value}٪`, 5), {
      custom: { label: "درصد دلخواه", data: "wz:custom:riskPercent" },
      skip: { label: "پیش‌فرض 1٪", data: "wz:risk:1" },
    }), message.editMessageId);
}

async function askSymbol(env, message) {
  return setAndAsk(env, message.from.id, "signal_symbol", {}, message.chat.id,
    "<b>سیگنال حرفه‌ای Lensa</b>\n\nاول نماد را انتخاب می‌کنی؛ بعد ربات دسترسی زنده‌ی منبع‌های داده را برای همان بازه بررسی می‌کند.\n\nرمزارز را انتخاب کن:",
    symbolKeyboard(), message.editMessageId);
}

export async function handleSignalStart(env, message) {
  const { id: userId, username } = message.from;
  await db.getOrCreateUser(env, userId, username ?? null);
  const rate = await db.checkRateLimit(env, userId);
  if (!rate.allowed) {
    const why = rate.reason === "daily_limit" ? `سقف روزانه‌ات (${rate.limit}) پر شده.` : `بیشتر از ${rate.limit} سیگنال باز هم‌زمان نمی‌توانی داشته باشی.`;
    return sendMessage(env, message.chat.id, `⛔ ${why}`, mainMenuMarkup(await db.isAdmin(env, userId)));
  }
  return askSymbol(env, message);
}

async function goBack(env, message, session) {
  let step = session.step;
  if (step === "signal_custom") {
    step = {
      leverage: "signal_leverage", feePercent: "signal_fee", stopLossPercent: "signal_stop_loss",
      takeProfitPercent: "signal_take_profit", accountSize: "signal_account", riskPercent: "signal_risk",
    }[session.data.pendingField] ?? "signal_symbol";
  }
  const data = { ...session.data };
  delete data.pendingField;
  if (step === "signal_market_type") return askSymbol(env, message);
  if (step === "signal_timeframe") return askMarketType(env, message, data);
  if (step === "signal_days") return askTimeframe(env, message, data);
  if (step === "signal_source") return askDays(env, message, data);
  if (step === "signal_direction") return askDataSource(env, message, data);
  if (step === "signal_leverage") return askDirection(env, message, data);
  if (step === "signal_fee") return data.marketType === "spot" ? askDataSource(env, message, data) : askLeverage(env, message, data);
  if (step === "signal_fill") return askFee(env, message, data);
  if (step === "signal_exit_mode") return askFill(env, message, data);
  if (step === "signal_stop_loss") return askExitMode(env, message, data);
  if (step === "signal_take_profit") return askStopLoss(env, message, data);
  if (step === "signal_account") return data.exitMode === "atr" ? askExitMode(env, message, data) : askTakeProfit(env, message, data);
  if (step === "signal_risk") return askAccountSize(env, message, data);
  return askSymbol(env, message);
}

async function afterValue(env, message, session, field, value) {
  const data = { ...session.data, [field]: value };
  if (field === "symbol") return askMarketType(env, message, data);
  if (field === "marketType") return askTimeframe(env, message, data);
  if (field === "timeframe") return askDays(env, message, data);
  if (field === "backtestDays") return askDataSource(env, message, data);
  if (field === "dataSource") return data.marketType === "spot"
    ? askFee(env, message, { ...data, direction: "long", leverage: 1 })
    : askDirection(env, message, data);
  if (field === "direction") return askLeverage(env, message, data);
  if (field === "leverage") return askFee(env, message, data);
  if (field === "feePercent") return askFill(env, message, data);
  if (field === "fillTiming") return askExitMode(env, message, data);
  if (field === "exitMode") return value === "atr"
    ? askAccountSize(env, message, { ...data, stopLossPercent: 0, takeProfitPercent: 0 })
    : askStopLoss(env, message, data);
  if (field === "stopLossPercent") return askTakeProfit(env, message, data);
  if (field === "takeProfitPercent") return askAccountSize(env, message, data);
  if (field === "accountSize") return Number(value) <= 0
    ? startFit(env, message, { ...data, riskPercent: 0 })
    : askRiskPercent(env, message, data);
  if (field === "riskPercent") return startFit(env, message, data);
}

function customRule(field) {
  return {
    symbol: { prompt: "نماد را بفرست؛ مثلاً BTC یا ETH." },
    leverage: { min: 1, max: 125, prompt: "لورج را بین 1 تا 125 بفرست." },
    feePercent: { min: 0, max: 5, prompt: "کارمزد هر سمت را بین 0 تا 5 درصد بفرست." },
    stopLossPercent: { min: 0.1, max: 95, prompt: "حد ضرر ROI را بین 0.1 تا 95 درصد بفرست تا قیمت حد ضرر معتبر بماند." },
    takeProfitPercent: { min: 0.1, max: 1000, prompt: "تارگت ROI را بین 0.1 تا 1000 درصد بفرست." },
    accountSize: { min: 1, max: 1e12, prompt: "اندازه‌ی حساب را به USDT بفرست." },
    riskPercent: { min: 0.01, max: 100, prompt: "درصد ریسک حساب را بین 0.01 تا 100 بفرست." },
  }[field];
}

export async function handleWizardText(env, message, session) {
  if ((message.text ?? "").trim() === "/cancel") return handleCancel(env, message);
  if (session.step !== "signal_custom") return sendMessage(env, message.chat.id, "در این مرحله از دکمه‌ها استفاده کن یا عملیات را لغو کن.");
  const field = session.data.pendingField;
  const rule = customRule(field);
  if (!rule) return handleCancel(env, message);
  let value;
  if (field === "symbol") {
    value = normalizeSymbol(message.text);
    if (!/^[A-Z0-9]{5,20}$/.test(value)) return sendMessage(env, message.chat.id, "نماد معتبر نیست؛ مثلاً BTC یا ETH بفرست.");
  } else {
    value = Number(String(message.text || "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(value) || value < rule.min || value > rule.max) return sendMessage(env, message.chat.id, rule.prompt);
  }
  const data = { ...session.data };
  delete data.pendingField;
  return afterValue(env, message, { ...session, data }, field, value);
}

export async function handleWizardCallback(env, callbackQuery, session) {
  const message = { chat: callbackQuery.message.chat, from: callbackQuery.from, editMessageId: callbackQuery.message.message_id };
  const [, kind, value] = callbackQuery.data.split(":");
  if (kind === "back") {
    await answerCallbackQuery(env, callbackQuery.id);
    return goBack(env, message, session);
  }
  if (kind === "retry" && value === "sources" && session.step === "signal_source") {
    await answerCallbackQuery(env, callbackQuery.id);
    return askDataSource(env, message, session.data);
  }
  if (kind === "custom") {
    const rule = customRule(value);
    if (!rule) return answerCallbackQuery(env, callbackQuery.id, "گزینه معتبر نیست.");
    await db.setSession(env, callbackQuery.from.id, "signal_custom", { ...session.data, pendingField: value });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, message.chat.id, `${rule.prompt}\n\nمی‌توانی مقدار را بفرستی یا به مرحله قبل برگردی.`,
      { reply_markup: keyboard([]) });
  }
  const expected = {
    symbol: "signal_symbol", market: "signal_market_type", tf: "signal_timeframe", days: "signal_days", source: "signal_source",
    dir: "signal_direction", lev: "signal_leverage", fee: "signal_fee", fill: "signal_fill",
    exit: "signal_exit_mode", sl: "signal_stop_loss", tp: "signal_take_profit", account: "signal_account", risk: "signal_risk",
  }[kind];
  if (!expected || session.step !== expected) return answerCallbackQuery(env, callbackQuery.id, "این دکمه دیگر مربوط به مرحله‌ی فعلی نیست.");
  if (kind === "source" && !session.data.sourceChecks?.some((item) => item.id === value && item.available)) {
    return answerCallbackQuery(env, callbackQuery.id, "این منبع در بررسی فعلی تأیید نشده؛ دوباره منابع را بررسی کن.", { show_alert: true });
  }
  await answerCallbackQuery(env, callbackQuery.id);
  const field = {
    symbol: "symbol", market: "marketType", tf: "timeframe", days: "backtestDays", source: "dataSource", dir: "direction",
    lev: "leverage", fee: "feePercent", fill: "fillTiming", exit: "exitMode", sl: "stopLossPercent",
    tp: "takeProfitPercent", account: "accountSize", risk: "riskPercent",
  }[kind];
  const numeric = new Set(["backtestDays", "leverage", "feePercent", "stopLossPercent", "takeProfitPercent", "accountSize", "riskPercent"]);
  return afterValue(env, message, session, field, numeric.has(field) ? Number(value) : value);
}

async function startFit(env, message, data) {
  await db.clearSession(env, message.from.id);
  const requestId = await db.createSignalRequest(env, {
    userId: message.from.id,
    symbol: data.symbol,
    timeframe: data.timeframe,
    leverage: data.leverage,
    stopLossPercent: data.stopLossPercent,
    takeProfitPercent: data.takeProfitPercent,
  });
  const market = data.marketType === "spot" ? "Spot" : `Futures ${data.leverage}x`;
  const exits = data.exitMode === "atr" ? "ATR خودکار" : `SL ${data.stopLossPercent}٪ / TP ${data.takeProfitPercent}٪ ROI`;
  await sendOrEditMessage(env, message.chat.id, message.editMessageId,
    `<b>فیت شروع شد</b> ⏳\n\n${data.symbol} · ${market}\n${data.timeframe} · ${data.backtestDays} روز · جهت ${data.direction}\n` +
    `منبع داده: ${candleSourceLabel(data.dataSource)}\n` +
    `Fee ${data.feePercent}٪ · Fill ${data.fillTiming}\nحدها: ${exits}\n\n` +
    "بعد از پایان، اطلاعات همه‌ی استراتژی‌ها در چند پیام خوانا می‌آید. سپس معیار رتبه‌بندی و خود استراتژی را انتخاب می‌کنی."
  );
  await env.SIGNAL_FIT_WORKFLOW.create({ params: { operation: "fit", requestId, userId: message.from.id, chatId: message.chat.id, ...data } });
}

export async function handleCancel(env, message) {
  await db.clearSession(env, message.from.id);
  return sendMessage(env, message.chat.id, "عملیات لغو شد. از منوی زیر انتخاب کن:", mainMenuMarkup(await db.isAdmin(env, message.from.id)));
}
