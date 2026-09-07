import { sendMessage, answerCallbackQuery, verifyWebhookSecret } from "./telegram.js";
import * as db from "./db.js";
import { handleStart, handleMyPlan } from "./commands/start.js";
import { handleStats } from "./commands/stats.js";
import {
  handleAddAdmin,
  handleRemoveAdmin,
  handleListAdmins,
  handleListPlans,
  handleSetPlan,
  handleAdminMenu,
  handleAdminListCallback,
  handleAdminUserListCallback,
  handleAdminRemoveCallback,
  handleAdminAddCallback,
  handleAdminAddManualStart,
  handleAdminSessionText,
  handleAdminPlanUserCallback,
  handleAdminPlanPickCallback,
} from "./commands/admin.js";
import { handleSignalStart, handleWizardText, handleWizardCallback, handleCancel } from "./commands/signal.js";
import { mainMenuMarkup } from "./commands/menu.js";
import { handleFitCallback } from "./commands/signalSelection.js";
import { handleAnalysisCallback, handleAnalysisFeatureStart, handleAnalysisHub, handleAnalysisText } from "./commands/analysis.js";
import { handleAutomationCallback, handleAutomationHub, handleAutomationText } from "./commands/automation.js";
import { formatDetailMessage } from "./signalFormat.js";
import { checkOpenSignals } from "./cron/checkOpenSignals.js";
import { checkPriceAlerts } from "./cron/checkPriceAlerts.js";
import { handleNews } from "./commands/news.js";
import { handleAbout } from "./commands/about.js";

export { SignalFitWorkflow } from "./workflows/signalFitWorkflow.js";

const HELP_TEXT =
  "<b>راهنمای Lensa</b>\n\n" +
  "همه‌ی جریان‌های اصلی از منوی دکمه‌ای در دسترس‌اند؛ لازم نیست دستوری حفظ کنی.\n\n" +
  "<b>تحلیل و معامله</b>\n" +
  "/signal — فیت همه‌ی استراتژی‌ها و انتخاب دستی نتیجه\n" +
  "/market · /decision · /forecast · /backtest · /risk · /news\n\n" +
  "<b>پیگیری و حساب</b>\n" +
  "/automation — Watchlist، هشدار، ژورنال و تاریخچه\n" +
  "/myplan · /plans · /about · /cancel\n\n" +
  "<b>مدیریت</b>\n" +
  "/admin — پنل دکمه‌ای ادمین\n" +
  "دستورهای متنی قدیمی add/remove admin و setplan هم برای سازگاری فعال مانده‌اند.";

/** "/addadmin@MyBot 123 alice" -> { command: "addadmin", args: ["123", "alice"] } */
function parseCommand(text) {
  const [head, ...args] = text.trim().split(/\s+/);
  const command = head.replace(/^\//, "").split("@")[0].toLowerCase();
  return { command, args };
}

const PUBLIC_COMMANDS = {
  start: handleStart,
  myplan: handleMyPlan,
  plans: handleListPlans,
  help: async (env, message) => sendMessage(env, message.chat.id, HELP_TEXT, mainMenuMarkup(await db.isAdmin(env, message.from.id))),
  signal: handleSignalStart,
  market: (env, message) => handleAnalysisFeatureStart(env, message, "market"),
  decision: (env, message) => handleAnalysisFeatureStart(env, message, "decision"),
  forecast: (env, message) => handleAnalysisFeatureStart(env, message, "forecast"),
  backtest: (env, message) => handleAnalysisFeatureStart(env, message, "backtest"),
  risk: handleAnalysisHub,
  automation: handleAutomationHub,
  news: handleNews,
  about: handleAbout,
  cancel: handleCancel,
};

const ADMIN_COMMANDS = {
  listadmins: handleListAdmins,
  setplan: handleSetPlan,
  stats: handleStats,
  admin: handleAdminMenu,
};

const OWNER_COMMANDS = {
  addadmin: handleAddAdmin,
  removeadmin: handleRemoveAdmin,
};

async function routeMessage(env, message) {
  const userId = message.from.id;

  // Do this before routing so the configured owner sees the admin button on
  // their very first /start response as well.
  await db.ensureBootstrapAdmin(env, userId, message.from.username ?? null);

  if ((message.text ?? "").trim().split("@")[0] === "/cancel") {
    await handleCancel(env, message);
    return;
  }

  // An in-progress /signal wizard owns the next text message (except
  // /cancel, which handleWizardText itself handles).
  const session = await db.getSession(env, userId);
  if (session) {
    if (session.step.startsWith("admin_")) {
      if (!db.isOwner(env, userId)) {
        await db.clearSession(env, userId);
        await sendMessage(env, message.chat.id, "افزودن یا حذف ادمین فقط در اختیار مالک اصلی ربات است.");
        return;
      }
      await handleAdminSessionText(env, message, session);
      return;
    }
    if (session.step.startsWith("analysis_")) {
      await handleAnalysisText(env, message, session);
      return;
    }
    if (session.step.startsWith("auto_")) {
      await handleAutomationText(env, message, session);
      return;
    }
    await handleWizardText(env, message, session);
    return;
  }

  const text = message.text;
  if (!text || !text.startsWith("/")) return; // ignore non-command chatter

  const { command, args } = parseCommand(text);

  if (command in PUBLIC_COMMANDS) {
    await PUBLIC_COMMANDS[command](env, message, args);
    return;
  }

  if (command in ADMIN_COMMANDS) {
    if (!(await db.isAdmin(env, userId))) {
      await sendMessage(env, message.chat.id, "این دستور فقط برای ادمین‌هاست.");
      return;
    }
    await ADMIN_COMMANDS[command](env, message, args);
    return;
  }

  if (command in OWNER_COMMANDS) {
    if (!db.isOwner(env, userId)) {
      await sendMessage(env, message.chat.id, "این دستور فقط برای مالک اصلی ربات است.");
      return;
    }
    await OWNER_COMMANDS[command](env, message, args);
    return;
  }

  await sendMessage(env, message.chat.id, `دستور ناشناخته.\n\n${HELP_TEXT}`, mainMenuMarkup(await db.isAdmin(env, userId)));
}

async function routeCallbackQuery(env, callbackQuery) {
  const data = callbackQuery.data ?? "";
  await db.ensureBootstrapAdmin(env, callbackQuery.from.id, callbackQuery.from.username ?? null);

  if (data.startsWith("fit:")) {
    await handleFitCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("ana:")) {
    await handleAnalysisCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("auto:")) {
    await handleAutomationCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("menu:")) {
    const action = data.split(":")[1];
    const knownActions = new Set(["home", "signal", "market", "decision", "forecast", "backtest", "risk", "automation", "news", "about", "myplan", "plans", "cancel", "admin", "help"]);
    if (!knownActions.has(action)) {
      await answerCallbackQuery(env, callbackQuery.id, "این گزینه معتبر نیست؛ منوی اصلی را دوباره باز کن.");
      return;
    }
    if (action === "admin" && !(await db.isAdmin(env, callbackQuery.from.id))) {
      await answerCallbackQuery(env, callbackQuery.id, "این منو فقط برای ادمین‌هاست.");
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);
    const message = { chat: callbackQuery.message.chat, from: callbackQuery.from, editMessageId: callbackQuery.message.message_id };
    // A navigation button exits any half-finished signal wizard. Starting a
    // fresh signal replaces the session itself; cancel has its own message.
    if (action !== "signal" && action !== "cancel") {
      await db.clearSession(env, callbackQuery.from.id);
    }
    if (action === "home") await handleStart(env, message);
    else if (action === "signal") await handleSignalStart(env, message);
    else if (action === "market") await handleAnalysisFeatureStart(env, message, "market");
    else if (action === "decision") await handleAnalysisFeatureStart(env, message, "decision");
    else if (action === "forecast") await handleAnalysisFeatureStart(env, message, "forecast");
    else if (action === "backtest") await handleAnalysisFeatureStart(env, message, "backtest");
    else if (action === "risk") await handleAnalysisHub(env, message);
    else if (action === "automation") await handleAutomationHub(env, message);
    else if (action === "news") await handleNews(env, message);
    else if (action === "about") await handleAbout(env, message);
    else if (action === "myplan") await handleMyPlan(env, message);
    else if (action === "plans") await handleListPlans(env, message);
    else if (action === "cancel") await handleCancel(env, message);
    else if (action === "admin") await handleAdminMenu(env, message);
    else if (action === "help") await sendMessage(env, message.chat.id, HELP_TEXT, mainMenuMarkup(await db.isAdmin(env, message.from.id)));
    return;
  }

  if (data.startsWith("adm:")) {
    if (!(await db.isAdmin(env, callbackQuery.from.id))) {
      await answerCallbackQuery(env, callbackQuery.id, "این منو فقط برای ادمین‌هاست.");
      return;
    }

    const [, action, value, extra] = data.split(":");
    const knownActions = new Set(["menu", "removelist", "removepick", "addlist", "addpick", "addmanual", "planlist", "planuser", "planpick", "stats"]);
    if (!knownActions.has(action)) {
      await answerCallbackQuery(env, callbackQuery.id, "این گزینه مدیریتی معتبر نیست؛ منو را دوباره باز کن.");
      return;
    }
    const ownerActions = new Set(["addlist", "addpick", "addmanual", "removepick"]);
    if (ownerActions.has(action) && !db.isOwner(env, callbackQuery.from.id)) {
      await answerCallbackQuery(env, callbackQuery.id, "افزودن یا حذف ادمین فقط برای مالک اصلی مجاز است.", { show_alert: true });
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);

    if (action === "menu") {
      await handleAdminMenu(env, { chat: callbackQuery.message.chat, from: callbackQuery.from, editMessageId: callbackQuery.message.message_id });
    } else if (action === "removelist") {
      await handleAdminListCallback(env, callbackQuery);
    } else if (action === "removepick") {
      await handleAdminRemoveCallback(env, callbackQuery, Number(value));
    } else if (action === "addlist") {
      await handleAdminUserListCallback(env, callbackQuery, "add", Math.max(0, Number(value) || 0));
    } else if (action === "addpick") {
      await handleAdminAddCallback(env, callbackQuery, Number(value));
    } else if (action === "addmanual") {
      await handleAdminAddManualStart(env, callbackQuery);
    } else if (action === "planlist") {
      await handleAdminUserListCallback(env, callbackQuery, "plan", Math.max(0, Number(value) || 0));
    } else if (action === "planuser") {
      await handleAdminPlanUserCallback(env, callbackQuery, Number(value));
    } else if (action === "planpick") {
      await handleAdminPlanPickCallback(env, callbackQuery, Number(value), extra ?? "");
    } else if (action === "stats") {
      await handleStats(env, { chat: callbackQuery.message.chat, from: callbackQuery.from });
    }
    return;
  }

  if (data.startsWith("wz:")) {
    const session = await db.getSession(env, callbackQuery.from.id);
    if (!session) {
      await answerCallbackQuery(env, callbackQuery.id, "این ویزارد دیگه فعال نیست. /signal رو دوباره بزن.");
      return;
    }
    await handleWizardCallback(env, callbackQuery, session);
    return;
  }

  if (data.startsWith("detail:")) {
    const signalId = Number(data.split(":")[1]);
    const signal = await db.getSignalById(env, signalId);
    await answerCallbackQuery(env, callbackQuery.id);
    if (!signal || String(signal.user_id) !== String(callbackQuery.from.id)) {
      await sendMessage(env, callbackQuery.message.chat.id, "این سیگنال پیدا نشد.");
      return;
    }
    const metadata = await db.getSignalMetadata(env, signalId);
    await sendMessage(env, callbackQuery.message.chat.id, formatDetailMessage(signal, metadata), mainMenuMarkup(await db.isAdmin(env, callbackQuery.from.id)));
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, "این دکمه دیگر معتبر نیست؛ منوی اصلی را دوباره باز کن.");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("lensa-signal-bot is alive", { status: 200 });
    }

    if (!verifyWebhookSecret(request, env)) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const message = update.message;
    if (message?.from && !message.from.is_bot) {
      ctx.waitUntil(
        routeMessage(env, message).catch((err) => {
          console.error("routeMessage failed", err);
          return sendMessage(env, message.chat.id, "یه خطای غیرمنتظره پیش اومد. دوباره امتحان کن.");
        })
      );
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery?.from && !callbackQuery.from.is_bot) {
      ctx.waitUntil(
        routeCallbackQuery(env, callbackQuery).catch(async (err) => {
          console.error("routeCallbackQuery failed", err);
          let showAdminMenu = false;
          try {
            showAdminMenu = await db.isAdmin(env, callbackQuery.from.id);
          } catch {
            // The callback may have failed because D1 itself is unavailable.
          }
          await Promise.allSettled([
            answerCallbackQuery(env, callbackQuery.id, "اجرای این گزینه با خطا روبه‌رو شد. دوباره امتحان کن.", { show_alert: true }),
            sendMessage(env, callbackQuery.message.chat.id, "⚠️ اجرای این گزینه کامل نشد. از منوی اصلی دوباره وارد بخش موردنظر شو.", mainMenuMarkup(showAdminMenu)),
          ]);
        })
      );
    }

    // Always ack quickly so Telegram doesn't retry-storm us; real work runs in waitUntil.
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.allSettled([
        checkOpenSignals(env).then((result) => console.log("checkOpenSignals", JSON.stringify(result))),
        checkPriceAlerts(env).then((result) => console.log("checkPriceAlerts", JSON.stringify(result))),
      ]).then((results) => {
        for (const result of results) if (result.status === "rejected") console.error("scheduled automation failed", result.reason);
      })
    );
  },
};
