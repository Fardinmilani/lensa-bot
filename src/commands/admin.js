import { sendMessage, escapeHtml } from "../telegram.js";
import * as db from "../db.js";

/** All handlers here assume the caller has already been checked with db.isAdmin(). */

export async function handleAddAdmin(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  if (!args[0] || Number.isNaN(targetId)) {
    return sendMessage(env, chatId, "استفاده درست: <code>/addadmin TELEGRAM_ID</code>");
  }
  await db.addAdmin(env, targetId, message.from.id, args[1] ?? null);
  return sendMessage(env, chatId, `✅ کاربر <code>${targetId}</code> به لیست ادمین‌ها اضافه شد.`);
}

export async function handleRemoveAdmin(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  if (!args[0] || Number.isNaN(targetId)) {
    return sendMessage(env, chatId, "استفاده درست: <code>/removeadmin TELEGRAM_ID</code>");
  }
  if (targetId === message.from.id) {
    return sendMessage(env, chatId, "نمی‌تونی خودت رو حذف کنی.");
  }
  const removed = await db.removeAdmin(env, targetId);
  return sendMessage(
    env,
    chatId,
    removed ? `✅ کاربر <code>${targetId}</code> از لیست ادمین‌ها حذف شد.` : `کاربر <code>${targetId}</code> اصلاً ادمین نبود.`
  );
}

export async function handleListAdmins(env, message) {
  const admins = await db.listAdmins(env);
  if (admins.length === 0) return sendMessage(env, message.chat.id, "هیچ ادمینی ثبت نشده.");
  const lines = admins.map((a) => `• <code>${a.telegram_id}</code>${a.username ? " @" + escapeHtml(a.username) : ""}`);
  return sendMessage(env, message.chat.id, `👤 ادمین‌ها:\n${lines.join("\n")}`);
}

export async function handleListPlans(env, message) {
  const plans = await db.listPlans(env);
  const lines = plans.map(
    (p) =>
      `• <b>${escapeHtml(p.name)}</b> — سقف روزانه: ${p.daily_signal_limit ?? "نامحدود"}, سیگنال باز هم‌زمان: ${p.max_open_signals ?? "نامحدود"}`
  );
  return sendMessage(env, message.chat.id, `📋 پلن‌ها:\n${lines.join("\n")}`);
}

export async function handleSetPlan(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  const planName = args[1];
  if (!args[0] || Number.isNaN(targetId) || !planName) {
    return sendMessage(env, chatId, "استفاده درست: <code>/setplan TELEGRAM_ID PLAN_NAME</code>");
  }
  await db.getOrCreateUser(env, targetId, null); // make sure the user row exists first
  const ok = await db.setUserPlanByName(env, targetId, planName);
  return sendMessage(
    env,
    chatId,
    ok ? `✅ پلن کاربر <code>${targetId}</code> شد «${escapeHtml(planName)}».` : `پلنی به اسم «${escapeHtml(planName)}» وجود نداره. با /plans لیست رو ببین.`
  );
}
