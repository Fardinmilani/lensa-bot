import { fetchCurrentPrices } from "../marketData.js";
import { escapeHtml, sendMessage } from "../telegram.js";
import * as db from "../db.js";

export async function checkPriceAlerts(env) {
  const alerts = await db.getActivePriceAlerts(env);
  if (!alerts.length) return { checked: 0, triggered: 0 };
  const prices = await fetchCurrentPrices([...new Set(alerts.map((alert) => alert.symbol))]);
  const updates = [];
  for (const alert of alerts) {
    const price = prices[alert.symbol];
    if (!(price > 0)) continue;
    const hasPrevious = alert.last_price != null && Number.isFinite(Number(alert.last_price));
    const previous = Number(alert.last_price);
    const crossed = alert.condition === "above"
      ? (hasPrevious ? previous < alert.level && price >= alert.level : price >= alert.level)
      : (hasPrevious ? previous > alert.level && price <= alert.level : price <= alert.level);
    updates.push({ id: alert.id, price, triggered: crossed });
    if (crossed) {
      await sendMessage(env, alert.user_id,
        `🔔 <b>هشدار قیمت فعال شد</b>\n\n${escapeHtml(alert.symbol)} ${alert.condition === "above" ? "به بالای" : "به پایین"} ${Number(alert.level).toLocaleString("en-US")} رسید.\nقیمت ثبت‌شده: <code>${Number(price).toLocaleString("en-US")}</code>`);
    }
  }
  await db.updatePriceAlerts(env, updates);
  return { checked: alerts.length, triggered: updates.filter((item) => item.triggered).length };
}
