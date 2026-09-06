import { sendMessage } from "../telegram.js";
import * as db from "../db.js";

export async function handleStart(env, message) {
  await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  return sendMessage(
    env,
    message.chat.id,
    "سلام 👋 به ربات سیگنال lensa خوش اومدی.\n\n" +
      "به‌زودی می‌تونی با /signal یه رمزارز، تایم‌فریم، لورج و حد ضرر/سود بدی تا همه‌ی استراتژی‌های بک‌تست رو براش فیت کنم و بهترین‌شون رو برای الان (long/short) بهت بگم.\n" +
      "این بخش هنوز در حال ساخته‌شدنه؛ فعلاً با /myplan می‌تونی پلن فعلیت رو ببینی."
  );
}

export async function handleMyPlan(env, message) {
  const user = await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  const used = await db.countSignalRequestsToday(env, message.from.id);
  const open = await db.countOpenSignals(env, message.from.id);
  return sendMessage(
    env,
    message.chat.id,
    `📋 پلن تو: <b>${user.plan_name}</b>\n` +
      `سقف روزانه: ${user.daily_signal_limit ?? "نامحدود"} (امروز مصرف‌شده: ${used})\n` +
      `سقف سیگنال باز هم‌زمان: ${user.max_open_signals ?? "نامحدود"} (الان باز: ${open})`
  );
}
