export function mainMenuKeyboard(isAdmin = false) {
  const rows = [
    [
      { text: "📈 سیگنال جدید", callback_data: "menu:signal" },
      { text: "📋 پلن من", callback_data: "menu:myplan" },
    ],
    [
      { text: "📚 پلن‌ها", callback_data: "menu:plans" },
      { text: "❓ راهنما", callback_data: "menu:help" },
    ],
    [{ text: "❌ لغو و بازگشت", callback_data: "menu:cancel" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠 مدیریت ادمین", callback_data: "menu:admin" }]);
  return { inline_keyboard: rows };
}

export function mainMenuMarkup(isAdmin = false) {
  return { reply_markup: mainMenuKeyboard(isAdmin) };
}
