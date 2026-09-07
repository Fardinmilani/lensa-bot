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
  handleAdminPlanUserCallback,
  handleAdminPlanPickCallback,
} from "./commands/admin.js";
import { handleSignalStart, handleWizardText, handleWizardCallback, handleCancel } from "./commands/signal.js";
import { mainMenuMarkup } from "./commands/menu.js";
import { formatDetailMessage } from "./signalFormat.js";
import { checkOpenSignals } from "./cron/checkOpenSignals.js";

export { SignalFitWorkflow } from "./workflows/signalFitWorkflow.js";

const HELP_TEXT =
  "دستورهای عمومی:\n" +
  "/start ، /myplan ، /plans\n" +
  "/signal — سیگنال جدید (فیت همه‌ی استراتژی‌ها + تصمیم long/short)\n" +
  "/cancel — لغو کردن ویزارد /signal در حال انجام\n\n" +
  "دستورهای ادمین:\n" +
  "/addadmin ، /removeadmin ، /listadmins\n" +
  "/setplan TELEGRAM_ID PLAN_NAME\n" +
  "/stats\n" +
  "/admin — مدیریت ادمین با دکمه‌ها";

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
  cancel: handleCancel,
};

const ADMIN_COMMANDS = {
  addadmin: handleAddAdmin,
  removeadmin: handleRemoveAdmin,
  listadmins: handleListAdmins,
  setplan: handleSetPlan,
  stats: handleStats,
  admin: handleAdminMenu,
};

async function routeMessage(env, message) {
  const userId = message.from.id;

  // Do this before routing so the configured owner sees the admin button on
  // their very first /start response as well.
  await db.ensureBootstrapAdmin(env, userId, message.from.username ?? null);

  // An in-progress /signal wizard owns the next text message (except
  // /cancel, which handleWizardText itself handles).
  const session = await db.getSession(env, userId);
  if (session) {
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

  await sendMessage(env, message.chat.id, `دستور ناشناخته.\n\n${HELP_TEXT}`, mainMenuMarkup(await db.isAdmin(env, userId)));
}

async function routeCallbackQuery(env, callbackQuery) {
  const data = callbackQuery.data ?? "";

  if (data.startsWith("menu:")) {
    const action = data.split(":")[1];
    if (action === "admin" && !(await db.isAdmin(env, callbackQuery.from.id))) {
      await answerCallbackQuery(env, callbackQuery.id, "این منو فقط برای ادمین‌هاست.");
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);
    const message = { chat: callbackQuery.message.chat, from: callbackQuery.from };
    // A navigation button exits any half-finished signal wizard. Starting a
    // fresh signal replaces the session itself; cancel has its own message.
    if (action !== "signal" && action !== "cancel") {
      await db.clearSession(env, callbackQuery.from.id);
    }
    if (action === "home") await handleStart(env, message);
    else if (action === "signal") await handleSignalStart(env, message);
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
    await answerCallbackQuery(env, callbackQuery.id);

    if (action === "menu") {
      await handleAdminMenu(env, { chat: callbackQuery.message.chat, from: callbackQuery.from });
    } else if (action === "removelist") {
      await handleAdminListCallback(env, callbackQuery);
    } else if (action === "removepick") {
      await handleAdminRemoveCallback(env, callbackQuery, Number(value));
    } else if (action === "addlist") {
      await handleAdminUserListCallback(env, callbackQuery, "add", Math.max(0, Number(value) || 0));
    } else if (action === "addpick") {
      await handleAdminAddCallback(env, callbackQuery, Number(value));
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
    if (!signal) {
      await sendMessage(env, callbackQuery.message.chat.id, "این سیگنال پیدا نشد.");
      return;
    }
    await sendMessage(env, callbackQuery.message.chat.id, formatDetailMessage(signal));
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
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
        routeCallbackQuery(env, callbackQuery).catch((err) => {
          console.error("routeCallbackQuery failed", err);
        })
      );
    }

    // Always ack quickly so Telegram doesn't retry-storm us; real work runs in waitUntil.
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkOpenSignals(env)
        .then((result) => console.log("checkOpenSignals", JSON.stringify(result)))
        .catch((err) => console.error("checkOpenSignals failed", err))
    );
  },
};
