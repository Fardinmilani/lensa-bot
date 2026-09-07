import { sendOrEditMessage } from "../telegram.js";

export async function handleAbout(env, message) {
  return sendOrEditMessage(env, message.chat.id, message.editMessageId,
    "ℹ️ <b>درباره‌ی Lensa</b>\n\nLensa یک سامانه‌ی تصمیم‌یار برای تبدیل داده‌ی بازار، بک‌تست چنداستراتژی، سناریوهای Monte Carlo و مدیریت ریسک به خروجی شفاف و قابل‌پیگیری است.\n\nطراحی و توسعه: <b>فردین شیخ میلانی</b>\nمهندسی صنایع و توسعه‌ی سامانه‌های تصمیم‌یار\n\n⚠️ Lensa توصیه‌ی مالی نیست و به حساب صرافی متصل نمی‌شود یا سفارش واقعی ثبت نمی‌کند.",
    { reply_markup: { inline_keyboard: [
      [{ text: "GitHub پروژه", url: "https://github.com/Fardinmilani/lensa-bot" }],
      [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
    ] } });
}
