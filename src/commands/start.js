import { sendMessage } from "../telegram.js";
import * as db from "../db.js";
import { mainMenuMarkup } from "./menu.js";
import { handleAnalysisFeatureStart, handleAnalysisHub } from "./analysis.js";
import { handleAbout } from "./about.js";

export async function handleStart(env, message, args = []) {
  await db.getOrCreateUser(env, message.from.id, message.from.username ?? null);
  const siteFeature = String(args[0] || "").match(/^site_(dashboard|decision|forecast|backtest|risk|about)$/)?.[1];
  if (siteFeature) {
    if (siteFeature === "about") return handleAbout(env, message);
    if (siteFeature === "risk") return handleAnalysisHub(env, message);
    const flow = siteFeature === "dashboard" ? "market" : siteFeature;
    await sendMessage(env, message.chat.id, `از بخش ${siteFeature} سایت وارد شدی. تنظیمات این تحلیل را کامل و مرحله‌به‌مرحله تأیید می‌کنیم.`);
    return handleAnalysisFeatureStart(env, message, flow);
  }
  const isAdmin = await db.isAdmin(env, message.from.id);
  return sendMessage(
    env,
    message.chat.id,
    "سلام 👋 به ربات عملیاتی Lensa خوش اومدی.\n\nتحلیل بازار، Forecast، Backtest، سیگنال، مدیریت ریسک و پیگیری خودکار را از همین منو انجام بده؛ لازم نیست دستوری حفظ کنی.",
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
