import { answerCallbackQuery, escapeHtml, sendLongMessage, sendMessage, sendOrEditMessage } from "../telegram.js";
import { fetchCandles, fetchCurrentPrice, normalizeSymbol } from "../marketData.js";
import { ema, rsi } from "../lib/strategies.js";
import * as db from "../db.js";

export function automationKeyboard() {
  return { inline_keyboard: [
    [{ text: "👁 Watchlist", callback_data: "auto:watch" }, { text: "🔎 اسکن Watchlist", callback_data: "auto:scan" }],
    [{ text: "🔔 هشدارهای قیمت", callback_data: "auto:alerts" }, { text: "➕ هشدار جدید", callback_data: "auto:alertadd" }],
    [{ text: "📝 ژورنال", callback_data: "auto:journal" }, { text: "✍️ یادداشت جدید", callback_data: "auto:journaladd" }],
    [{ text: "📂 سیگنال‌ها و نتایج", callback_data: "auto:signals" }],
    [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
  ] };
}

export async function handleAutomationHub(env, message) {
  await db.clearSession(env, message.from.id);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    "<b>مرکز اتوماسیون Lensa</b>\n\nWatchlist و هشدارها روی سرور ذخیره می‌شوند. هشدار قیمت حتی وقتی سایت و تلگرام باز نیستند با Cron بررسی و در همین چت اعلام می‌شود.",
    { reply_markup: automationKeyboard() });
}

function symbolsKeyboard(prefix) {
  return { inline_keyboard: [
    [{ text: "BTC", callback_data: `${prefix}:BTCUSDT` }, { text: "ETH", callback_data: `${prefix}:ETHUSDT` }, { text: "SOL", callback_data: `${prefix}:SOLUSDT` }],
    [{ text: "XRP", callback_data: `${prefix}:XRPUSDT` }, { text: "BNB", callback_data: `${prefix}:BNBUSDT` }, { text: "DOGE", callback_data: `${prefix}:DOGEUSDT` }],
    [{ text: "⌨️ نماد دیگر", callback_data: `${prefix}:custom` }],
    [{ text: "↩️ اتوماسیون", callback_data: "auto:hub" }],
  ] };
}

function backMarkup(callbackData, label) {
  return { reply_markup: { inline_keyboard: [[{ text: `⬅️ ${label}`, callback_data: callbackData }], [{ text: "❌ لغو", callback_data: "menu:cancel" }]] } };
}

async function showWatchlist(env, message, notice = "") {
  const items = await db.listWatchlist(env, message.from.id);
  const keyboard = items.map((item) => [{ text: `❌ ${item.symbol}`, callback_data: `auto:watchdel:${item.symbol}` }]);
  keyboard.push([{ text: "➕ افزودن نماد", callback_data: "auto:watchadd" }, { text: "🔎 اسکن", callback_data: "auto:scan" }]);
  keyboard.push([{ text: "↩️ اتوماسیون", callback_data: "auto:hub" }]);
  const body = items.length
    ? `<b>Watchlist شما</b>\n\n${items.map((item, i) => `${i + 1}. ${escapeHtml(item.symbol)} · ${item.timeframe}`).join("\n")}`
    : "Watchlist خالی است. با دکمه‌ی زیر اولین نماد را اضافه کن.";
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, notice ? `${notice}\n\n${body}` : body, { reply_markup: { inline_keyboard: keyboard } });
}

async function startWatchAdd(env, message) {
  await db.setSession(env, message.from.id, "auto_watch_symbol", {});
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, "نماد موردنظر را انتخاب کن:", { reply_markup: symbolsKeyboard("auto:watchpick") });
}

async function afterWatchSymbol(env, message, symbol) {
  const clean = normalizeSymbol(symbol);
  await db.setSession(env, message.from.id, "auto_watch_timeframe", { symbol: clean });
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    `<b>${escapeHtml(clean)}</b>\n\nتایم‌فریم اسکن این نماد را انتخاب کن:`, { reply_markup: { inline_keyboard: [
      ["15m", "1h", "4h", "1d"].map((timeframe) => ({ text: timeframe, callback_data: `auto:watchtf:${timeframe}` })),
      [{ text: "⬅️ انتخاب نماد", callback_data: "auto:back:watchsymbol" }],
      [{ text: "❌ لغو", callback_data: "menu:cancel" }],
    ] } });
}

async function addWatch(env, message, symbol, timeframe) {
  const clean = normalizeSymbol(symbol);
  await db.addWatchlistSymbol(env, message.from.id, clean, timeframe);
  await db.clearSession(env, message.from.id);
  return showWatchlist(env, message, `✅ ${escapeHtml(clean)} با تایم‌فریم ${timeframe} به Watchlist اضافه شد.`);
}

async function scanWatchlist(env, message) {
  const items = (await db.listWatchlist(env, message.from.id)).slice(0, 12);
  if (!items.length) return sendMessage(env, message.chat.id, "Watchlist خالی است.", { reply_markup: automationKeyboard() });
  await sendMessage(env, message.chat.id, `⏳ در حال اسکن ${items.length} نماد با روند، RSI و بازده اخیر…`);
  const rows = await Promise.all(items.map(async (item) => {
    try {
      const candles = await fetchCandles(item.symbol, item.timeframe, 180);
      const closes = candles.map((c) => c.close);
      const fast = ema(closes, 9).at(-1);
      const slow = ema(closes, 21).at(-1);
      const momentum = rsi(closes, 14).at(-1);
      const change = ((closes.at(-1) / closes.at(-25) - 1) * 100);
      const bias = fast > slow && momentum >= 50 ? "صعودی" : fast < slow && momentum < 50 ? "نزولی" : "خنثی";
      return `${item.symbol} · ${bias}\nقیمت ${closes.at(-1).toLocaleString("en-US")} | بازده ۲۴ کندل ${change >= 0 ? "+" : ""}${change.toFixed(2)}٪ | RSI ${momentum.toFixed(1)}`;
    } catch (err) {
      return `${escapeHtml(item.symbol)} · خطا: ${escapeHtml(err.message)}`;
    }
  }));
  return sendLongMessage(env, message.chat.id, `<b>اسکن Watchlist</b>\n\n${rows.join("\n\n")}`, { reply_markup: automationKeyboard() });
}

async function startAlert(env, message) {
  await db.setSession(env, message.from.id, "auto_alert_symbol", {});
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, "نماد هشدار را انتخاب کن:", { reply_markup: symbolsKeyboard("auto:alertpick") });
}

async function afterAlertSymbol(env, message, symbol) {
  const clean = normalizeSymbol(symbol);
  await db.setSession(env, message.from.id, "auto_alert_condition", { symbol: clean });
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, `<b>${clean}</b>\n\nهشدار هنگام عبور قیمت به کدام سمت فعال شود؟`, { reply_markup: { inline_keyboard: [
    [{ text: "⬆️ قیمت بالاتر رفت", callback_data: "auto:alertcondition:above" }, { text: "⬇️ قیمت پایین‌تر رفت", callback_data: "auto:alertcondition:below" }],
    [{ text: "⬅️ انتخاب نماد", callback_data: "auto:back:alertsymbol" }],
    [{ text: "❌ لغو", callback_data: "menu:cancel" }],
  ] } });
}

async function showAlerts(env, message, notice = "") {
  const alerts = await db.listPriceAlerts(env, message.from.id);
  const active = alerts.filter((alert) => alert.status === "active");
  const lines = alerts.map((alert) =>
    `#${alert.id} · ${escapeHtml(alert.symbol)} ${alert.condition === "above" ? "≥" : "≤"} ${Number(alert.level).toLocaleString("en-US")} · ${alert.status === "active" ? "فعال" : "فعال‌شده"}`
  );
  const keyboard = active.map((alert) => [{ text: `❌ حذف #${alert.id} ${alert.symbol}`, callback_data: `auto:alertdel:${alert.id}` }]);
  keyboard.push([{ text: "➕ هشدار جدید", callback_data: "auto:alertadd" }, { text: "↩️ اتوماسیون", callback_data: "auto:hub" }]);
  const body = alerts.length ? `<b>هشدارهای قیمت</b>\n\n${lines.join("\n")}` : "هنوز هشدار قیمتی ثبت نشده.";
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, notice ? `${notice}\n\n${body}` : body, { reply_markup: { inline_keyboard: keyboard } });
}

async function showJournal(env, message) {
  const entries = await db.listJournalEntries(env, message.from.id);
  const lines = entries.map((entry) => `#${entry.id}${entry.symbol ? ` · ${escapeHtml(entry.symbol)}` : ""}\n${escapeHtml(entry.note)}\n${entry.created_at}`);
  const keyboard = entries.slice(0, 10).map((entry) => [{ text: `❌ حذف یادداشت #${entry.id}`, callback_data: `auto:journaldel:${entry.id}` }]);
  keyboard.push([{ text: "✍️ یادداشت جدید", callback_data: "auto:journaladd" }, { text: "↩️ اتوماسیون", callback_data: "auto:hub" }]);
  return sendLongMessage(env, message.chat.id, entries.length ? `<b>ژورنال معاملاتی</b>\n\n${lines.join("\n\n")}` : "ژورنال خالی است.", { reply_markup: { inline_keyboard: keyboard } });
}

async function startJournalEntry(env, message) {
  await db.setSession(env, message.from.id, "auto_journal_symbol", {});
  const markup = symbolsKeyboard("auto:journalpick");
  markup.inline_keyboard.splice(-1, 0, [{ text: "⏭ بدون نماد", callback_data: "auto:journalpick:none" }]);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    "این یادداشت مربوط به کدام نماد است؟ می‌توانی بدون نماد ادامه بدهی.", { reply_markup: markup });
}

async function afterJournalSymbol(env, message, symbol = null) {
  const clean = symbol ? normalizeSymbol(symbol) : null;
  await db.setSession(env, message.from.id, "auto_journal_note", { symbol: clean });
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    `${clean ? `<b>${escapeHtml(clean)}</b>\n\n` : ""}یادداشت کاملت را در یک پیام بفرست. متن بدون خلاصه‌شدن ذخیره می‌شود.\n\nبرای لغو، /cancel را بفرست.`,
    backMarkup("auto:back:journalsymbol", "انتخاب نماد"));
}

async function showSignals(env, message) {
  const signals = await db.listUserSignals(env, message.from.id);
  const statusFa = { open: "باز", hit_tp: "حد سود", hit_sl: "حد ضرر", expired: "منقضی" };
  const lines = signals.map((signal) =>
    `#${signal.id} · <b>${escapeHtml(signal.symbol)}</b> · ${signal.direction} · ${statusFa[signal.status] ?? signal.status}\n` +
    `${escapeHtml(signal.strategy_label)} | ورود ${Number(signal.entry_price).toLocaleString("en-US")} | SL ${Number(signal.stop_loss_price).toLocaleString("en-US")} | TP ${Number(signal.take_profit_price).toLocaleString("en-US")}\n` +
    `بازده بک‌تست ${Number(signal.backtest_return_percent ?? 0).toFixed(1)}٪ | برد ${Number(signal.backtest_win_rate ?? 0).toFixed(1)}٪ | ${signal.opened_at}`
  );
  const keyboard = signals.slice(0, 10).map((signal) => [{ text: `جزئیات #${signal.id}`, callback_data: `detail:${signal.id}` }]);
  keyboard.push([{ text: "↩️ اتوماسیون", callback_data: "auto:hub" }]);
  return sendLongMessage(env, message.chat.id, signals.length ? `<b>تاریخچه‌ی سیگنال‌ها</b>\n\n${lines.join("\n\n")}` : "هنوز سیگنالی ثبت نشده.", { reply_markup: { inline_keyboard: keyboard } });
}

export async function handleAutomationText(env, message, session) {
  const text = String(message.text || "").trim();
  if (session.step === "auto_watch_symbol") return afterWatchSymbol(env, message, text);
  if (session.step === "auto_alert_symbol") return afterAlertSymbol(env, message, text);
  if (session.step === "auto_journal_symbol") return afterJournalSymbol(env, message, text);
  if (session.step === "auto_alert_level") {
    const level = Number(text.replace(/[^\d.]/g, ""));
    if (!(level > 0)) return sendMessage(env, message.chat.id, "قیمت معتبر و بزرگ‌تر از صفر بفرست.");
    const lastPrice = await fetchCurrentPrice(session.data.symbol).catch(() => null);
    await db.createPriceAlert(env, { userId: message.from.id, ...session.data, level, lastPrice });
    await db.clearSession(env, message.from.id);
    return showAlerts(env, message, `✅ هشدار ${session.data.symbol} ${session.data.condition === "above" ? "بالاتر از" : "پایین‌تر از"} ${level.toLocaleString("en-US")} فعال شد.`);
  }
  if (session.step === "auto_journal_note") {
    if (text.length < 2 || text.length > 2000) return sendMessage(env, message.chat.id, "یادداشت باید بین ۲ تا ۲۰۰۰ کاراکتر باشد.");
    await db.addJournalEntry(env, { userId: message.from.id, symbol: session.data.symbol ?? null, note: text });
    await db.clearSession(env, message.from.id);
    return showJournal(env, message);
  }
  return false;
}

export async function handleAutomationCallback(env, callbackQuery) {
  const [, action, value] = callbackQuery.data.split(":");
  const message = { chat: callbackQuery.message.chat, from: callbackQuery.from, editMessageId: callbackQuery.message.message_id };
  await answerCallbackQuery(env, callbackQuery.id);
  if (action === "hub") return handleAutomationHub(env, message);
  if (action === "back") {
    if (value === "watchsymbol") return startWatchAdd(env, message);
    if (value === "alertsymbol") return startAlert(env, message);
    if (value === "alertcondition") {
      const session = await db.getSession(env, message.from.id);
      return session?.data?.symbol ? afterAlertSymbol(env, message, session.data.symbol) : startAlert(env, message);
    }
    if (value === "journalsymbol") return startJournalEntry(env, message);
    return handleAutomationHub(env, message);
  }
  if (action === "watch") return showWatchlist(env, message);
  if (action === "watchadd") return startWatchAdd(env, message);
  if (action === "watchpick") {
    if (value === "custom") {
      await db.setSession(env, message.from.id, "auto_watch_symbol", {});
      return sendOrEditMessage(env, message.chat.id, message.editMessageId, "نماد را بفرست؛ مثلاً AVAX یا AVAXUSDT:", backMarkup("auto:back:watchsymbol", "انتخاب نماد"));
    }
    return afterWatchSymbol(env, message, value);
  }
  if (action === "watchtf") {
    const session = await db.getSession(env, message.from.id);
    if (!session || session.step !== "auto_watch_timeframe") return sendMessage(env, message.chat.id, "فرم Watchlist منقضی شده؛ دوباره «افزودن نماد» را بزن.");
    if (!["15m", "1h", "4h", "1d"].includes(value)) return sendMessage(env, message.chat.id, "تایم‌فریم معتبر نیست.");
    return addWatch(env, message, session.data.symbol, value);
  }
  if (action === "watchdel") {
    await db.removeWatchlistSymbol(env, message.from.id, value);
    return showWatchlist(env, message);
  }
  if (action === "scan") return scanWatchlist(env, message);
  if (action === "alerts") return showAlerts(env, message);
  if (action === "alertadd") return startAlert(env, message);
  if (action === "alertpick") {
    if (value === "custom") {
      await db.setSession(env, message.from.id, "auto_alert_symbol", {});
      return sendOrEditMessage(env, message.chat.id, message.editMessageId, "نماد هشدار را بفرست؛ مثلاً BTC یا BTCUSDT:", backMarkup("auto:back:alertsymbol", "انتخاب نماد"));
    }
    return afterAlertSymbol(env, message, value);
  }
  if (action === "alertcondition") {
    const session = await db.getSession(env, message.from.id);
    if (!session || session.step !== "auto_alert_condition") return sendMessage(env, message.chat.id, "فرم هشدار منقضی شده؛ دوباره «هشدار جدید» را بزن.");
    if (!new Set(["above", "below"]).has(value)) return sendMessage(env, message.chat.id, "جهت هشدار معتبر نیست؛ دوباره «هشدار جدید» را بزن.");
    await db.setSession(env, message.from.id, "auto_alert_level", { ...session.data, condition: value });
    return sendOrEditMessage(env, message.chat.id, message.editMessageId, "قیمت فعال‌شدن هشدار را بفرست:\n\nبرای لغو، /cancel را بفرست.", backMarkup("auto:back:alertcondition", "انتخاب جهت هشدار"));
  }
  if (action === "alertdel") {
    await db.deletePriceAlert(env, message.from.id, Number(value));
    return showAlerts(env, message);
  }
  if (action === "journal") return showJournal(env, message);
  if (action === "journaladd") return startJournalEntry(env, message);
  if (action === "journalpick") {
    if (value === "custom") {
      await db.setSession(env, message.from.id, "auto_journal_symbol", {});
      return sendOrEditMessage(env, message.chat.id, message.editMessageId, "نماد را بفرست؛ مثلاً BTC یا BTCUSDT:", backMarkup("auto:back:journalsymbol", "انتخاب نماد"));
    }
    return afterJournalSymbol(env, message, value === "none" ? null : value);
  }
  if (action === "journaldel") {
    await db.deleteJournalEntry(env, message.from.id, Number(value));
    return showJournal(env, message);
  }
  if (action === "signals") return showSignals(env, message);
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, "این گزینه دیگر معتبر نیست. از منوی اتوماسیون دوباره انتخاب کن.", { reply_markup: automationKeyboard() });
}
