export function mainMenuKeyboard(isAdmin = false) {
  const rows = [
    [{ text: "🎯 سیگنال حرفه‌ای", callback_data: "menu:signal" }],
    [
      { text: "📊 بازار", callback_data: "menu:market" },
      { text: "🧭 مرکز تصمیم", callback_data: "menu:decision" },
    ],
    [{ text: "📰 اخبار و منابع بازار", callback_data: "menu:news" }],
    [
      { text: "🔮 Forecast", callback_data: "menu:forecast" },
      { text: "🧪 Backtest", callback_data: "menu:backtest" },
    ],
    [{ text: "🧮 ابزارهای ریسک", callback_data: "menu:risk" }, { text: "🤖 اتوماسیون", callback_data: "menu:automation" }],
    [{ text: "📋 پلن من", callback_data: "menu:myplan" }, { text: "📚 پلن‌ها", callback_data: "menu:plans" }],
    [{ text: "❓ راهنما", callback_data: "menu:help" }, { text: "ℹ️ درباره Lensa", callback_data: "menu:about" }],
    [{ text: "❌ لغو عملیات جاری", callback_data: "menu:cancel" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠 مدیریت ادمین", callback_data: "menu:admin" }]);
  return { inline_keyboard: rows };
}

export function mainMenuMarkup(isAdmin = false) {
  return { reply_markup: mainMenuKeyboard(isAdmin) };
}
