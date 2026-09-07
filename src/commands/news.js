import { sendOrEditMessage } from "../telegram.js";

const SOURCES = [
  [{ text: "CoinDesk Markets", url: "https://www.coindesk.com/markets/" }, { text: "Cointelegraph", url: "https://cointelegraph.com/tags/markets" }],
  [{ text: "Decrypt Markets", url: "https://decrypt.co/news/markets" }, { text: "CryptoSlate", url: "https://cryptoslate.com/news/" }],
  [{ text: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/" }],
  [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
];

export async function handleNews(env, message) {
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    "📰 <b>اخبار و منابع بازار</b>\n\nنسخه‌ی سایت هم در حالت استاتیک تیترها را روی سرور جمع‌آوری نمی‌کند؛ برای جلوگیری از خبر قدیمی، لینک منابع زنده و معتبر را مستقیم باز کن. تحلیل کمی Lensa مستقل از تیتر خبر اجرا می‌شود.",
    { reply_markup: { inline_keyboard: SOURCES } });
}
