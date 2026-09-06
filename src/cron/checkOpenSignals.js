import * as db from "../db.js";
import { fetchCurrentPrices } from "../marketData.js";
import { sendMessage } from "../telegram.js";
import { formatResolvedNotification } from "../signalFormat.js";

/** Direction-aware: for a short, price falling is the "good" (TP) direction. */
function resolveOutcome(signal, price) {
  if (signal.direction === "long") {
    if (price <= signal.stop_loss_price) return "hit_sl";
    if (price >= signal.take_profit_price) return "hit_tp";
  } else {
    if (price >= signal.stop_loss_price) return "hit_sl";
    if (price <= signal.take_profit_price) return "hit_tp";
  }
  return null;
}

export async function checkOpenSignals(env) {
  const open = await db.getOpenSignals(env);
  if (open.length === 0) return { checked: 0, resolved: 0 };

  const symbols = [...new Set(open.map((s) => s.symbol))];
  let prices;
  try {
    prices = await fetchCurrentPrices(symbols);
  } catch (err) {
    console.error("checkOpenSignals: price fetch failed", err);
    return { checked: open.length, resolved: 0, error: String(err) };
  }

  const resolutions = [];
  const notifications = [];
  for (const signal of open) {
    const price = prices[signal.symbol];
    if (price == null) continue; // Binance didn't return this symbol this round; try again next tick
    const outcome = resolveOutcome(signal, price);
    if (!outcome) continue;
    resolutions.push({ id: signal.id, status: outcome, resolvedPrice: price });
    notifications.push({ signal: { ...signal, status: outcome }, price, chatId: signal.user_id });
  }

  await db.resolveSignalsBatch(env, resolutions);

  for (const n of notifications) {
    await sendMessage(env, n.chatId, formatResolvedNotification(n.signal, n.price));
  }

  return { checked: open.length, resolved: resolutions.length };
}
