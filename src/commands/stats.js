import { sendMessage, escapeHtml } from "../telegram.js";
import * as db from "../db.js";
import { adminMenuKeyboard } from "./admin.js";

export async function handleStats(env, message) {
  const s = await db.getStats(env);
  const chatId = message.chat.id;

  if (s.total === 0) {
    return sendMessage(env, chatId, "هنوز هیچ سیگنالی صادر نشده.", { reply_markup: adminMenuKeyboard() });
  }

  const winRateLine = s.winRate == null ? "هنوز سیگنال بسته‌شده‌ای نیست" : `${s.winRate.toFixed(1)}٪`;

  let text =
    `📊 <b>آمار کلی سیگنال‌ها</b>\n` +
    `مجموع: ${s.total}\n` +
    `باز: ${s.open_count} | به تارگت خورده: ${s.hit_tp} | استاپ خورده: ${s.hit_sl} | منقضی: ${s.expired}\n` +
    `نرخ برد (از بسته‌شده‌ها): ${winRateLine}`;

  if (s.byStrategy.length > 0) {
    text += "\n\n<b>به تفکیک استراتژی</b> (فقط سیگنال‌های بسته‌شده)\n";
    text += s.byStrategy
      .map((row) => {
        const resolved = row.hit_tp + row.hit_sl;
        const wr = resolved > 0 ? ((row.hit_tp / resolved) * 100).toFixed(0) : "-";
        return `• ${escapeHtml(row.strategy_label)}: ${row.hit_tp}/${resolved} (${wr}٪)`;
      })
      .join("\n");
  }

  return sendMessage(env, chatId, text, { reply_markup: adminMenuKeyboard() });
}
