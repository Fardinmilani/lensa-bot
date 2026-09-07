import { sendMessage } from "../telegram.js";
import * as db from "../db.js";
import { mainMenuMarkup } from "./menu.js";

export async function handleStart(env, message) {
  await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  const isAdmin = await db.isAdmin(env, message.from.id);
  return sendMessage(
    env,
    message.chat.id,
    "سلام 👋 به ربات سیگنال Lensa خوش اومدی.\n\nاز منوی زیر انتخاب کن:",
    mainMenuMarkup(isAdmin)
  );
}

export async function handleMyPlan(env, message) {
  const user = await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  const isAdmin = await db.isAdmin(env, message.from.id);
  const used = await db.countSignalRequestsToday(env, message.from.id);
  const open = await db.countOpenSignals(env, message.from.id);
  return sendMessage(
    env,
    message.chat.id,
    `📋 پلن تو: <b>${user.plan_name}</b>\n` +
    `سقف روزانه: ${user.daily_signal_limit ?? "نامحدود"} (امروز مصرف‌شده: ${used})\n` +
      `سقف سیگنال باز هم‌زمان: ${user.max_open_signals ?? "نامحدود"} (الان باز: ${open})`,
    mainMenuMarkup(isAdmin)
  );
}
