import { sendMessage, sendOrEditMessage, escapeHtml } from "../telegram.js";
import * as db from "../db.js";

/** All handlers here assume the caller has already been checked with db.isAdmin(). */

const PICKER_PAGE_SIZE = 10;

export function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 ادمین‌ها", callback_data: "adm:removelist" },
        { text: "➕ افزودن ادمین", callback_data: "adm:addlist:0" },
      ],
      [
        { text: "📋 تغییر پلن", callback_data: "adm:planlist:0" },
        { text: "📊 آمار", callback_data: "adm:stats" },
      ],
    ],
  };
}

function backToAdminMenuButton() {
  return { text: "↩️ منوی ادمین", callback_data: "adm:menu" };
}

function pickerUserLabel(user) {
  return user.username ? `@${user.username}` : String(user.telegram_id);
}

function pickerNavigation(prefix, offset, hasNext) {
  const row = [];
  if (offset > 0) row.push({ text: "◀️ قبلی", callback_data: `${prefix}:${Math.max(0, offset - PICKER_PAGE_SIZE)}` });
  if (hasNext) row.push({ text: "بعدی ▶️", callback_data: `${prefix}:${offset + PICKER_PAGE_SIZE}` });
  return row;
}

async function sendUserPicker(env, chatId, messageId, { mode, offset }) {
  const users = await db.listUsersForAdminPicker(env, { excludeAdmins: true, limit: PICKER_PAGE_SIZE, offset });
  const keyboard = users.map((user) => [
    {
      text: pickerUserLabel(user),
      callback_data: mode === "add" ? `adm:addpick:${user.telegram_id}` : `adm:planuser:${user.telegram_id}`,
    },
  ]);
  const prefix = mode === "add" ? "adm:addlist" : "adm:planlist";
  const navigation = pickerNavigation(prefix, offset, users.length === PICKER_PAGE_SIZE);
  if (navigation.length > 0) keyboard.push(navigation);
  if (mode === "add") keyboard.push([{ text: "⌨️ وارد کردن آیدی به‌صورت دستی", callback_data: "adm:addmanual" }]);
  keyboard.push([backToAdminMenuButton()]);

  const emptyText = mode === "add"
    ? "کاربر ثبت‌شده‌ی غیرادمین پیدا نشد. آیدی عددی کاربر را دستی وارد کن:"
    : "کاربر غیرادمینی برای تغییر پلن پیدا نشد.";
  return sendOrEditMessage(env, chatId, messageId, users.length > 0 ? (mode === "add" ? "➕ کاربر موردنظر برای افزودن به ادمین‌ها را انتخاب کن:" : "📋 کاربر موردنظر برای تغییر پلن را انتخاب کن:") : emptyText, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleAdminMenu(env, message) {
  return sendOrEditMessage(env, message.chat.id, message.editMessageId, "🛠 <b>مدیریت ادمین</b>\nاز منوی زیر انتخاب کن:", { reply_markup: adminMenuKeyboard() });
}

export async function handleAdminUserListCallback(env, callbackQuery, mode, offset) {
  return sendUserPicker(env, callbackQuery.message.chat.id, callbackQuery.message.message_id, { mode, offset });
}

export async function handleAdminListCallback(env, callbackQuery) {
  const admins = await db.listAdmins(env);
  const keyboard = admins.map((admin) => [
    {
      text: `❌ حذف ${admin.username ? `@${admin.username}` : admin.telegram_id}`,
      callback_data: `adm:removepick:${admin.telegram_id}`,
    },
  ]);
  keyboard.push([backToAdminMenuButton()]);
  const lines = admins.map((admin) => `• <code>${admin.telegram_id}</code>${admin.username ? ` @${escapeHtml(admin.username)}` : ""}`);
  return sendOrEditMessage(
    env,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    admins.length > 0 ? `👤 <b>ادمین‌ها</b>\n${lines.join("\n")}\n\nبرای حذف روی دکمه‌ی مربوط بزن:` : "هیچ ادمینی ثبت نشده.",
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

export async function handleAdminRemoveCallback(env, callbackQuery, targetId) {
  const chatId = callbackQuery.message.chat.id;
  if (String(targetId) === String(callbackQuery.from.id)) {
    return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "نمی‌تونی خودت رو حذف کنی.", { reply_markup: adminMenuKeyboard() });
  }
  const removed = await db.removeAdmin(env, targetId);
  return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, removed ? `✅ کاربر <code>${targetId}</code> از لیست ادمین‌ها حذف شد.` : `کاربر <code>${targetId}</code> اصلاً ادمین نبود.`, { reply_markup: adminMenuKeyboard() });
}

export async function handleAdminAddCallback(env, callbackQuery, targetId) {
  const chatId = callbackQuery.message.chat.id;
  const user = await db.getUserForAdminPicker(env, targetId, { excludeAdmin: true });
  if (!user) return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "این کاربر دیگر برای افزودن معتبر نیست. دوباره فهرست را باز کن.", { reply_markup: adminMenuKeyboard() });
  await db.addAdmin(env, user.telegram_id, callbackQuery.from.id, user.username);
  return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, `✅ کاربر <code>${user.telegram_id}</code> به لیست ادمین‌ها اضافه شد.`, { reply_markup: adminMenuKeyboard() });
}

export async function handleAdminPlanUserCallback(env, callbackQuery, targetId) {
  const chatId = callbackQuery.message.chat.id;
  const user = await db.getUserForAdminPicker(env, targetId, { excludeAdmin: true });
  if (!user) return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "این کاربر دیگر برای تغییر پلن معتبر نیست. دوباره فهرست را باز کن.", { reply_markup: adminMenuKeyboard() });
  const plans = await db.listPlans(env);
  const keyboard = plans.map((plan) => [{ text: plan.name, callback_data: `adm:planpick:${user.telegram_id}:${encodeURIComponent(plan.name)}` }]);
  keyboard.push([backToAdminMenuButton()]);
  return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, `📋 پلن جدید برای <code>${user.telegram_id}</code> را انتخاب کن:`, { reply_markup: { inline_keyboard: keyboard } });
}

export async function handleAdminPlanPickCallback(env, callbackQuery, targetId, encodedPlanName) {
  const chatId = callbackQuery.message.chat.id;
  const planName = decodeURIComponent(encodedPlanName);
  const user = await db.getUserForAdminPicker(env, targetId);
  const plans = await db.listPlans(env);
  if (!user || !plans.some((plan) => plan.name === planName)) {
    return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, "این انتخاب دیگر معتبر نیست. دوباره منوی ادمین را باز کن.", { reply_markup: adminMenuKeyboard() });
  }
  const ok = await db.setUserPlanByName(env, targetId, planName);
  return sendOrEditMessage(env, chatId, callbackQuery.message.message_id, ok ? `✅ پلن کاربر <code>${targetId}</code> شد «${escapeHtml(planName)}».` : "تغییر پلن انجام نشد.", { reply_markup: adminMenuKeyboard() });
}

export async function handleAddAdmin(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  if (!args[0] || Number.isNaN(targetId)) {
    return sendMessage(env, chatId, "استفاده درست: <code>/addadmin TELEGRAM_ID</code>", { reply_markup: adminMenuKeyboard() });
  }
  await db.addAdmin(env, targetId, message.from.id, args[1] ?? null);
  return sendMessage(env, chatId, `✅ کاربر <code>${targetId}</code> به لیست ادمین‌ها اضافه شد.`, { reply_markup: adminMenuKeyboard() });
}

export async function handleRemoveAdmin(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  if (!args[0] || Number.isNaN(targetId)) {
    return sendMessage(env, chatId, "استفاده درست: <code>/removeadmin TELEGRAM_ID</code>", { reply_markup: adminMenuKeyboard() });
  }
  if (targetId === message.from.id) {
    return sendMessage(env, chatId, "نمی‌تونی خودت رو حذف کنی.", { reply_markup: adminMenuKeyboard() });
  }
  const removed = await db.removeAdmin(env, targetId);
  return sendMessage(
    env,
    chatId,
    removed ? `✅ کاربر <code>${targetId}</code> از لیست ادمین‌ها حذف شد.` : `کاربر <code>${targetId}</code> اصلاً ادمین نبود.`,
    { reply_markup: adminMenuKeyboard() }
  );
}

export async function handleListAdmins(env, message) {
  const admins = await db.listAdmins(env);
  if (admins.length === 0) return sendMessage(env, message.chat.id, "هیچ ادمینی ثبت نشده.", { reply_markup: adminMenuKeyboard() });
  const lines = admins.map((a) => `• <code>${a.telegram_id}</code>${a.username ? " @" + escapeHtml(a.username) : ""}`);
  return sendMessage(env, message.chat.id, `👤 ادمین‌ها:\n${lines.join("\n")}`, { reply_markup: adminMenuKeyboard() });
}

export async function handleListPlans(env, message) {
  const plans = await db.listPlans(env);
  const lines = plans.map(
    (p) =>
      `• <b>${escapeHtml(p.name)}</b> — سقف روزانه: ${p.daily_signal_limit ?? "نامحدود"}, سیگنال باز هم‌زمان: ${p.max_open_signals ?? "نامحدود"}`
  );
  const isAdmin = message.from ? await db.isAdmin(env, message.from.id) : false;
  return sendMessage(env, message.chat.id, `📋 پلن‌ها:\n${lines.join("\n")}`, {
    reply_markup: isAdmin ? adminMenuKeyboard() : { inline_keyboard: [[{ text: "↩️ منوی اصلی", callback_data: "menu:home" }]] },
  });
}

export async function handleAdminAddManualStart(env, callbackQuery) {
  await db.setSession(env, callbackQuery.from.id, "admin_add_manual", {});
  return sendOrEditMessage(
    env,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    "آیدی عددی تلگرام کاربر را بفرست. اگر خواستی یوزرنیم را هم بعدش بنویس.\n\nمثال: <code>123456789 @username</code>"
  );
}

export async function handleAdminSessionText(env, message, session) {
  if (session.step !== "admin_add_manual") return false;
  const [idText, usernameText] = String(message.text || "").trim().split(/\s+/);
  const targetId = Number(idText);
  if (!/^\d+$/.test(idText || "") || !Number.isSafeInteger(targetId) || targetId <= 0) {
    await sendMessage(env, message.chat.id, "آیدی معتبر نیست. فقط آیدی عددی تلگرام را بفرست؛ مثلاً <code>123456789</code>.");
    return true;
  }
  const username = usernameText ? usernameText.replace(/^@/, "") : null;
  await db.getOrCreateUser(env, targetId, username);
  await db.addAdmin(env, targetId, message.from.id, username);
  await db.clearSession(env, message.from.id);
  await sendMessage(env, message.chat.id, `✅ کاربر <code>${targetId}</code>${username ? ` @${escapeHtml(username)}` : ""} ادمین شد.`, {
    reply_markup: adminMenuKeyboard(),
  });
  return true;
}

export async function handleSetPlan(env, message, args) {
  const chatId = message.chat.id;
  const targetId = Number(args[0]);
  const planName = args[1];
  if (!args[0] || Number.isNaN(targetId) || !planName) {
    return sendMessage(env, chatId, "استفاده درست: <code>/setplan TELEGRAM_ID PLAN_NAME</code>", { reply_markup: adminMenuKeyboard() });
  }
  await db.getOrCreateUser(env, targetId, null); // make sure the user row exists first
  const ok = await db.setUserPlanByName(env, targetId, planName);
  return sendMessage(
    env,
    chatId,
    ok ? `✅ پلن کاربر <code>${targetId}</code> شد «${escapeHtml(planName)}».` : `پلنی به اسم «${escapeHtml(planName)}» وجود نداره. با /plans لیست رو ببین.`,
    { reply_markup: adminMenuKeyboard() }
  );
}
