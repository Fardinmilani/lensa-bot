// Thin wrapper around the Telegram Bot API. No SDK dependency on purpose --
// it's three endpoints, and skipping the dependency keeps the Worker bundle
// (and therefore cold-start / parse time) small.

const API_BASE = "https://api.telegram.org";

function apiUrl(env, method) {
  return `${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Escape the 3 characters that are special in Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Sends a message. `extra` can include reply_markup (inline keyboards --
 * used from Phase 2 onward), parse_mode override, etc.
 */
export async function sendMessage(env, chatId, text, extra = {}) {
  const res = await fetch(apiUrl(env, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  if (!res.ok) {
    console.error("sendMessage failed", res.status, await res.text());
  }
  return res.ok;
}

export async function editMessage(env, chatId, messageId, text, extra = {}) {
  const res = await fetch(apiUrl(env, "editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  return res.ok;
}

/** Keep button-driven wizards in one message; fall back to a fresh message if editing is unavailable. */
export async function sendOrEditMessage(env, chatId, messageId, text, extra = {}) {
  if (messageId && await editMessage(env, chatId, messageId, text, extra)) return true;
  return sendMessage(env, chatId, text, extra);
}

/** Send long, paragraph-oriented reports without hitting Telegram's 4096-char limit. */
export async function sendLongMessage(env, chatId, text, finalExtra = {}) {
  const max = 3800;
  if (text.length <= max) return sendMessage(env, chatId, text, finalExtra);
  const paragraphs = String(text).split("\n\n");
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < paragraph.length; i += max) chunks.push(paragraph.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > max) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    ok = (await sendMessage(env, chatId, chunks[i], i === chunks.length - 1 ? finalExtra : {})) && ok;
  }
  return ok;
}

export async function answerCallbackQuery(env, callbackQueryId, text, extra = {}) {
  const res = await fetch(apiUrl(env, "answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, ...extra }),
  });
  return res.ok;
}

/**
 * Telegram lets you set a `secret_token` when calling setWebhook; it then
 * echoes it back on every webhook call as the X-Telegram-Bot-Api-Secret-Token
 * header. Checking it stops randoms from POSTing fake "updates" at your
 * Worker once they guess/scan for the URL.
 */
export function verifyWebhookSecret(request, env) {
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return Boolean(env.TELEGRAM_WEBHOOK_SECRET) && header === env.TELEGRAM_WEBHOOK_SECRET;
}

/** One-time setup helper -- see README for how to call this. */
export async function setWebhook(env, url) {
  const res = await fetch(apiUrl(env, "setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: env.TELEGRAM_WEBHOOK_SECRET }),
  });
  return res.json();
}
