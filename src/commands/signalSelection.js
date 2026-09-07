import { answerCallbackQuery, escapeHtml, sendOrEditMessage } from "../telegram.js";
import * as db from "../db.js";
import { labelText } from "../lib/singleStrategyFit.js";
import { fitBasisLabel, sortFitResults } from "../workflows/signalFitWorkflow.js";
import { mainMenuMarkup } from "./menu.js";

function metric(row, basis) {
  const result = row.result;
  if (basis === "profitfactor" && result.profitFactorInfinite) return "∞";
  const value = basis === "sharpe" ? result.sharpe
    : basis === "winrate" ? result.winRate
    : basis === "drawdown" ? result.maxDrawdownPercent
    : basis === "profitfactor" ? result.profitFactor
    : result.totalReturnPercent;
  const suffix = basis === "winrate" || basis === "drawdown" || basis === "return" ? "٪" : "";
  return `${Number.isFinite(value) ? Number(value).toFixed(basis === "sharpe" || basis === "profitfactor" ? 2 : 1) : "—"}${suffix}`;
}

function strategyButtonLabel(row, index, basis) {
  const label = labelText(row.label);
  const short = label.length > 28 ? `${label.slice(0, 27)}…` : label;
  return `${index + 1}. ${short} · ${metric(row, basis)}`;
}

export async function handleFitCallback(env, callbackQuery) {
  const parts = callbackQuery.data.split(":");
  const action = parts[1];
  const requestId = Number(parts[2]);
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const run = await db.getSignalFitRun(env, requestId);
  if (!run || String(run.user_id) !== String(userId)) {
    await answerCallbackQuery(env, callbackQuery.id, "این نتیجه متعلق به شما نیست یا منقضی شده.");
    return;
  }

  if (action === "cancel") {
    if (run.status !== "awaiting_selection") {
      await answerCallbackQuery(env, callbackQuery.id, "این تحلیل قبلاً نهایی شده است.");
      return;
    }
    await db.finishSignalFitRun(env, requestId, "cancelled");
    await db.updateSignalRequestStatus(env, requestId, "cancelled");
    await answerCallbackQuery(env, callbackQuery.id);
    await sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "انتخاب استراتژی لغو شد؛ هیچ سیگنالی ساخته نشد.", mainMenuMarkup(await db.isAdmin(env, userId)));
    return;
  }

  if (run.status !== "awaiting_selection") {
    await answerCallbackQuery(env, callbackQuery.id, "این تحلیل قبلاً انتخاب یا نهایی شده است.");
    return;
  }

  if (action === "basis") {
    const basis = parts[3];
    const allowed = new Set(["return", "sharpe", "winrate", "drawdown", "profitfactor"]);
    if (!allowed.has(basis)) {
      await answerCallbackQuery(env, callbackQuery.id, "معیار معتبر نیست.");
      return;
    }
    await db.chooseSignalFitBasis(env, requestId, userId, basis);
    const sorted = sortFitResults(run.results, basis);
    const keyboard = sorted.map((row, index) => [{
      text: strategyButtonLabel(row, index, basis),
      callback_data: `fit:strategy:${requestId}:${row.key}`,
    }]);
    keyboard.push([{ text: "↩️ تغییر معیار", callback_data: `fit:rebasis:${requestId}` }]);
    keyboard.push([{ text: "❌ لغو", callback_data: `fit:cancel:${requestId}` }]);
    await answerCallbackQuery(env, callbackQuery.id);
    await sendOrEditMessage(env, chatId, callbackQuery.message.message_id,
      `<b>مرتب‌سازی: ${escapeHtml(fitBasisLabel(basis))}</b>\n\n` +
      "عدد کنار هر دکمه مقدار همان معیار است. انتخاب استراتژی به معنی صدور قطعی نیست؛ اگر وضعیت زنده‌ی آن Flat باشد، ربات شفاف اعلام می‌کند که فعلاً ورود ندارد.",
      { reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }

  if (action === "rebasis") {
    await answerCallbackQuery(env, callbackQuery.id);
    await sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "معیار مرتب‌سازی را دوباره انتخاب کن:", { reply_markup: { inline_keyboard: [
      [{ text: "📈 بیشترین بازده", callback_data: `fit:basis:${requestId}:return` }, { text: "⚖️ بهترین Sharpe", callback_data: `fit:basis:${requestId}:sharpe` }],
      [{ text: "🎯 بیشترین نرخ برد", callback_data: `fit:basis:${requestId}:winrate` }, { text: "🛡 کمترین افت", callback_data: `fit:basis:${requestId}:drawdown` }],
      [{ text: "💹 Profit Factor", callback_data: `fit:basis:${requestId}:profitfactor` }],
    ] } });
    return;
  }

  if (action === "strategy") {
    const strategyKey = parts[3];
    if (!run.results.some((row) => row.key === strategyKey)) {
      await answerCallbackQuery(env, callbackQuery.id, "استراتژی در نتیجه‌ی فیت وجود ندارد.");
      return;
    }
    const chosen = await db.chooseSignalFitStrategy(env, requestId, userId, strategyKey);
    if (!chosen) {
      await answerCallbackQuery(env, callbackQuery.id, "این انتخاب قبلاً ثبت شده است.");
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);
    const row = run.results.find((item) => item.key === strategyKey);
    const warnings = [];
    if (Number(row.result?.totalReturnPercent) <= 0) {
      warnings.push("⚠️ این استراتژی در بازه‌ی انتخابی سودده نبوده است؛ انتخاب آن صرفاً برای بررسی وضعیت زنده ادامه پیدا می‌کند.");
    }
    if (row.fit?.validation?.available && !row.fit.validation.passed) {
      warnings.push("⚠️ بخش خارج از نمونه (Walk-Forward) برتری تنظیمات فیت‌شده را تأیید نکرده است؛ احتمال بیش‌برازش بالاتر است.");
    }
    const warningText = warnings.length ? `\n\n${warnings.map(escapeHtml).join("\n")}` : "";
    await sendOrEditMessage(env, chatId, callbackQuery.message.message_id,
      `<b>استراتژی انتخاب شد</b> ✅\n\n${escapeHtml(labelText(row.label))}\n` +
      `پارامترها: <code>${escapeHtml(JSON.stringify(row.params))}</code>${warningText}\n\n` +
      "در حال بررسی وضعیت زنده و ساخت حدها و حجم پوزیشن با تنظیمات انتخابی شما…"
    );
    await env.SIGNAL_FIT_WORKFLOW.create({ params: { operation: "finalize", requestId, userId, chatId, strategyKey } });
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, "این گزینه‌ی انتخاب استراتژی معتبر نیست.");
}
