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
} from "./commands/admin.js";
import { handleSignalStart, handleWizardText, handleWizardCallback } from "./commands/signal.js";
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
  "/stats";

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
  help: async (env, message) => sendMessage(env, message.chat.id, HELP_TEXT),
  signal: handleSignalStart,
};

const ADMIN_COMMANDS = {
  addadmin: handleAddAdmin,
  removeadmin: handleRemoveAdmin,
  listadmins: handleListAdmins,
  setplan: handleSetPlan,
  stats: handleStats,
};

async function routeMessage(env, message) {
  const userId = message.from.id;

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

  await sendMessage(env, message.chat.id, `دستور ناشناخته.\n\n${HELP_TEXT}`);
}

async function routeCallbackQuery(env, callbackQuery) {
  const data = callbackQuery.data ?? "";

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
      // Cheap no-op after the very first call; see db.ensureBootstrapAdmin.
      ctx.waitUntil(db.ensureBootstrapAdmin(env, message.from.id, message.from.username ?? null));
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
