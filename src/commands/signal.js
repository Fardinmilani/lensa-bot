import { sendMessage, answerCallbackQuery } from "../telegram.js";
import * as db from "../db.js";
import { normalizeSymbol, VALID_TIMEFRAMES } from "../marketData.js";

const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20];

function timeframeKeyboard() {
  return { inline_keyboard: [VALID_TIMEFRAMES.map((tf) => ({ text: tf, callback_data: `wz:tf:${tf}` }))] };
}

function leverageKeyboard() {
  return { inline_keyboard: [LEVERAGE_OPTIONS.map((lev) => ({ text: `${lev}x`, callback_data: `wz:lev:${lev}` }))] };
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
  return sendMessage(
    env,
    chatId,
    "کدوم رمزارز؟ (مثلاً BTC یا ETH -- جفت‌ارز رو خودم به USDT کامل می‌کنم)\n\nهر وقت خواستی /cancel بزن."
  );
}

/** Routed here for any text message while the user has an active wizard session. */
export async function handleWizardText(env, message, session) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text ?? "").trim();

  if (text === "/cancel") {
    await db.clearSession(env, userId);
    return sendMessage(env, chatId, "لغو شد.");
  }

  if (session.step === "symbol") {
    const symbol = normalizeSymbol(text);
    if (!/^[A-Z0-9]{5,15}$/.test(symbol)) {
      return sendMessage(env, chatId, "این نماد معتبر به نظر نمی‌رسه. یه چیزی مثل BTC یا ETH بفرست.");
    }
    await db.setSession(env, userId, "timeframe", { ...session.data, symbol });
    return sendMessage(env, chatId, "تایم‌فریم رو انتخاب کن:", { reply_markup: timeframeKeyboard() });
  }

  if (session.step === "stop_loss") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
      return sendMessage(env, chatId, "فقط یه عدد بین ۰ تا ۵۰ بفرست (درصد حد ضرر)، مثلاً 2");
    }
    await db.setSession(env, userId, "take_profit", { ...session.data, stopLossPercent: pct });
    return sendMessage(env, chatId, "درصد حد سود چقدر باشه؟ (فقط عدد، مثلاً 5)");
  }

  if (session.step === "take_profit") {
    const pct = Number(text.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 200) {
      return sendMessage(env, chatId, "فقط یه عدد معتبر بفرست (درصد حد سود)، مثلاً 5");
    }
    return finishWizard(env, message, { ...session.data, takeProfitPercent: pct });
  }

  // "timeframe" and "leverage" steps expect a button tap, not free text.
  return sendMessage(env, chatId, "لطفاً از دکمه‌های بالا انتخاب کن، یا /cancel بزن.");
}

/** Routed here for callback_query taps (inline keyboard buttons) while a wizard session is active. */
export async function handleWizardCallback(env, callbackQuery, session) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const [, kind, value] = callbackQuery.data.split(":"); // "wz:tf:4h" -> ["wz","tf","4h"]

  if (kind === "tf" && session.step === "timeframe") {
    await db.setSession(env, userId, "leverage", { ...session.data, timeframe: value });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "لورج رو انتخاب کن:", { reply_markup: leverageKeyboard() });
  }

  if (kind === "lev" && session.step === "leverage") {
    await db.setSession(env, userId, "stop_loss", { ...session.data, leverage: Number(value) });
    await answerCallbackQuery(env, callbackQuery.id);
    return sendMessage(env, chatId, "درصد حد ضرر چقدر باشه؟ (فقط عدد، مثلاً 2)");
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
