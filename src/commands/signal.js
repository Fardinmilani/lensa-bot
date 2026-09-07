import { sendMessage, answerCallbackQuery } from "../telegram.js";
import * as db from "../db.js";
import { normalizeSymbol, VALID_TIMEFRAMES } from "../marketData.js";
import { mainMenuMarkup } from "./menu.js";

const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20];
const SYMBOL_OPTIONS = [
  ["₿ BTC", "BTCUSDT"],
  ["Ξ ETH", "ETHUSDT"],
  ["🟡 BNB", "BNBUSDT"],
  ["◎ SOL", "SOLUSDT"],
  ["✕ XRP", "XRPUSDT"],
  ["🐕 DOGE", "DOGEUSDT"],
];
const STOP_LOSS_OPTIONS = [1, 2, 5, 10];
const TAKE_PROFIT_OPTIONS = [2, 5, 10, 20, 50, 100];
const BACKTEST_DAYS = {
  "15m": [7, 14, 30],
  "1h": [14, 30, 60, 90],
  "4h": [60, 90],
  "1d": [90, 180, 365],
};

function symbolKeyboard() {
  const rows = [];
  for (let i = 0; i < SYMBOL_OPTIONS.length; i += 2) {
    rows.push(
      SYMBOL_OPTIONS.slice(i, i + 2).map(([text, symbol]) => ({ text, callback_data: `wz:symbol:${symbol}` }))
    );
  }
  rows.push([{ text: "⌨️ نماد دیگر", callback_data: "wz:customsymbol" }]);
  rows.push([{ text: "↩️ منوی اصلی", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

function timeframeKeyboard() {
  return { inline_keyboard: [VALID_TIMEFRAMES.map((tf) => ({ text: tf, callback_data: `wz:tf:${tf}` }))] };
}

function leverageKeyboard() {
  return { inline_keyboard: [LEVERAGE_OPTIONS.map((lev) => ({ text: `${lev}x`, callback_data: `wz:lev:${lev}` }))] };
}

function stopLossKeyboard() {
  return {
    inline_keyboard: [
      STOP_LOSS_OPTIONS.map((pct) => ({ text: `SL ${pct}٪`, callback_data: `wz:sl:${pct}` })),
      [{ text: "⌨️ عدد دیگر", callback_data: "wz:customsl" }],
      [{ text: "❌ لغو", callback_data: "menu:cancel" }],
    ],
  };
}

function takeProfitKeyboard() {
  return {
    inline_keyboard: [
      TAKE_PROFIT_OPTIONS.map((pct) => ({ text: `TP ${pct}٪`, callback_data: `wz:tp:${pct}` })),
      [{ text: "⌨️ عدد دیگر", callback_data: "wz:customtp" }],
      [{ text: "❌ لغو", callback_data: "menu:cancel" }],
    ],
  };
}

function backtestDaysKeyboard(timeframe) {
  const options = BACKTEST_DAYS[timeframe] ?? [90, 180, 365];
  return {
    inline_keyboard: [
      options.map((days) => ({ text: `${days} روز`, callback_data: `wz:days:${days}` })),
      [{ text: "❌ لغو", callback_data: "menu:cancel" }],
    ],
  };
}

/** Entry point for the /signal command. */
export async function handleSignalStart(env, message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  await db.getOrCreateUser(env, userId, message.from.username ?? null); // sessions.telegram_id FKs to users

  const rate = await db.checkRateLimit(env, userId);
  if (!rate.allowed) {
    const why =
      rate.reason === "daily_limit"
        ? `سقف روزانه‌ت (${rate.limit} تا) پر شده.`
        : `هم‌زمان بیشتر از ${rate.limit} سیگنال باز نمی‌تونی داشته باشی -- منتظر بسته‌شدن یکی‌شون بمون.`;
    return sendMessage(env, chatId, `⛔ ${why}`);
  }

  await db.setSession(env, userId, "symbol", {});
  return sendMessage(env, chatId, "رمزارز را انتخاب کن:", { reply_markup: symbolKeyboard() });
}

/** Routed here for any text message while the user has an active wizard session. */
export async function handleWizardText(env, message, session) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text ?? "").trim();

  if (text === "/cancel") {
    return handleCancel(env, message);
  }

  if (session.step === "symbol") {
    const symbol = normalizeSymbol(text);
    if (!/^[A-Z0-9]{5,15}$/.test(symbol)) {
      return sendMessage(env, chatId, "این نماد معتبر به نظر نمی‌رسه. یه چیزی مثل BTC یا ETH بفرست.");
    }
    await db.setSession(env, userId, "timeframe", { ...session.data, symbol });
    return sendMessage(env, chatId, "تایم‌فریم رو انتخاب کن:", { reply_markup: timeframeKeyboard() });
  }

  if (session.step === "symbol_custom") {
    const symbol = normalizeSymbol(text);
    if (!/^[A-Z0-9]{5,15}$/.test(symbol)) {
      return sendMessage(env, chatId, "این نماد معتبر به نظر نمی‌رسه. مثلاً BTC یا ETH بفرست.");
    }
    await db.setSession(env, userId, "timeframe", { ...session.data, symbol });
    return sendMessage(env, chatId, "تایم‌فریم را انتخاب کن:", { reply_markup: timeframeKeyboard() });
  }

  if (session.step === "stop_loss") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
      return sendMessage(env, chatId, "فقط یه عدد بین ۰ تا ۵۰ بفرست (درصد حد ضرر)، مثلاً 2");
    }
    await db.setSession(env, userId, "take_profit", { ...session.data, stopLossPercent: pct });
    return sendMessage(env, chatId, "درصد حد سود را انتخاب کن:", { reply_markup: takeProfitKeyboard() });
  }

  if (session.step === "stop_loss_custom") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
      return sendMessage(env, chatId, "فقط یک عدد بین ۰ تا ۵۰ بفرست.");
    }
    await db.setSession(env, userId, "take_profit", { ...session.data, stopLossPercent: pct });
    return sendMessage(env, chatId, "درصد حد سود را انتخاب کن:", { reply_markup: takeProfitKeyboard() });
  }

  if (session.step === "take_profit") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 200) {
      return sendMessage(env, chatId, "درصد حد سود را انتخاب کن یا عدد دیگری بفرست:", { reply_markup: takeProfitKeyboard() });
    }
    return askBacktestDays(env, message, { ...session.data, takeProfitPercent: pct });
  }

  if (session.step === "take_profit_custom") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 200) {
      return sendMessage(env, chatId, "فقط یک عدد معتبر بین ۰ تا ۲۰۰ بفرست.");
    }
    return askBacktestDays(env, message, { ...session.data, takeProfitPercent: pct });
  }

  // Button-only steps expect a tap, not free text.
  return sendMessage(env, chatId, "لطفاً از دکمه‌های بالا انتخاب کن، یا /cancel بزن.");
}

/** Routed here for callback_query taps (inline keyboard buttons) while a wizard session is active. */
export async function handleWizardCallback(env, callbackQuery, session) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const [, kind, value] = callbackQuery.data.split(":");

  if (kind === "symbol" && session.step === "symbol") {
    await db.setSession(env, userId, "timeframe", { ...session.data, symbol: value });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "تایم‌فریم را انتخاب کن:", { reply_markup: timeframeKeyboard() });
  }

  if (kind === "customsymbol" && session.step === "symbol") {
    await db.setSession(env, userId, "symbol_custom", session.data);
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "نماد را بفرست (مثلاً BTC یا ETH):");
  }

  if (kind === "tf" && session.step === "timeframe") {
    await db.setSession(env, userId, "leverage", { ...session.data, timeframe: value });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "لورج رو انتخاب کن:", { reply_markup: leverageKeyboard() });
  }

  if (kind === "lev" && session.step === "leverage") {
    await db.setSession(env, userId, "stop_loss", { ...session.data, leverage: Number(value) });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "درصد حد ضرر را انتخاب کن:", { reply_markup: stopLossKeyboard() });
  }

  if (kind === "sl" && session.step === "stop_loss") {
    await db.setSession(env, userId, "take_profit", { ...session.data, stopLossPercent: Number(value) });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "درصد حد سود را انتخاب کن:", { reply_markup: takeProfitKeyboard() });
  }

  if (kind === "customsl" && session.step === "stop_loss") {
    await db.setSession(env, userId, "stop_loss_custom", session.data);
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "درصد حد ضرر را بفرست (عدد بین ۰ تا ۵۰):");
  }

  if (kind === "tp" && session.step === "take_profit") {
    await answerCallbackQuery(env, callbackQuery.id);
    return askBacktestDays(env, { chat: { id: chatId }, from: { id: userId } }, { ...session.data, takeProfitPercent: Number(value) });
  }

  if (kind === "customtp" && session.step === "take_profit") {
    await db.setSession(env, userId, "take_profit_custom", session.data);
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "درصد حد سود را بفرست (عدد بین ۰ تا ۲۰۰):");
  }

  if (kind === "days" && session.step === "backtest_days") {
    const allowedDays = BACKTEST_DAYS[session.data.timeframe] ?? [];
    if (!allowedDays.includes(Number(value))) {
      return answerCallbackQuery(env, callbackQuery.id, "این انتخاب دیگر معتبر نیست.");
    }
    await answerCallbackQuery(env, callbackQuery.id);
    return finishWizard(env, { chat: { id: chatId }, from: { id: userId } }, { ...session.data, backtestDays: Number(value) });
  }

  // Tap on a stale keyboard from an earlier, already-passed step.
  return answerCallbackQuery(env, callbackQuery.id, "این دکمه دیگه معتبر نیست.");
}

async function finishWizard(env, message, data) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  await db.clearSession(env, userId);

  const requestId = await db.createSignalRequest(env, {
    userId,
    symbol: data.symbol,
    timeframe: data.timeframe,
    leverage: data.leverage,
    stopLossPercent: data.stopLossPercent,
    takeProfitPercent: data.takeProfitPercent,
  });

  await sendMessage(
    env,
    chatId,
    `⏳ در حال فیت کردن همه‌ی استراتژی‌ها روی ${data.symbol} (${data.timeframe})... چند ثانیه طول می‌کشه.`
  );

  await env.SIGNAL_FIT_WORKFLOW.create({
    params: { requestId, userId, chatId, ...data },
  });
}

async function askBacktestDays(env, message, data) {
  await db.setSession(env, message.from.id, "backtest_days", data);
  return sendMessage(env, message.chat.id, "بک‌تست روی چند روز اخیر انجام شود؟", {
    reply_markup: backtestDaysKeyboard(data.timeframe),
  });
}

export async function handleCancel(env, message) {
  await db.clearSession(env, message.from.id);
  const isAdmin = await db.isAdmin(env, message.from.id);
  return sendMessage(env, message.chat.id, "لغو شد. از منوی زیر انتخاب کن:", mainMenuMarkup(isAdmin));
}
