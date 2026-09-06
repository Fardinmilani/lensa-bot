// Talks to Binance directly from the Worker. Unlike the dashboard's browser
// code, this needs no CORS-proxy trick: a Worker calling Binance server-to-
// server has no CORS restriction, and Cloudflare's edge IPs aren't subject
// to the same geo-block that hits direct requests from Iran (see the
// existing cloudflare-proxy/worker.js header comment -- same underlying
// reason that worker exists in the first place).

const BINANCE_BASE = "https://api.binance.com";

export const VALID_TIMEFRAMES = ["15m", "1h", "4h", "1d"];

/** "btc" / "BTC" / "btcusdt" -> "BTCUSDT". Leaves an already-quoted pair alone. */
export function normalizeSymbol(input) {
  const upper = String(input).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const knownQuotes = ["USDT", "BUSD", "USDC", "FDUSD"];
  if (knownQuotes.some((q) => upper.endsWith(q))) return upper;
  return upper + "USDT";
}

export class MarketDataError extends Error {}

async function readJsonResponse(res, endpoint) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new MarketDataError(
      `سرویس بازار برای ${endpoint} پاسخ JSON معتبر نداد (HTTP ${res.status}). چند لحظه بعد دوباره امتحان کن.`
    );
  }
}

/**
 * Returns candles as [{ time (unix SECONDS -- backtest.js's
 * estimatePeriodsPerYear divides by this unit for Sharpe annualization,
 * getting it wrong silently skews every risk-adjusted stat), open, high,
 * low, close, volume }], oldest first (Binance's own order).
 */
export async function fetchCandles(symbol, timeframe, limit = 300) {
  if (!VALID_TIMEFRAMES.includes(timeframe)) {
    throw new MarketDataError(`تایم‌فریم نامعتبر: ${timeframe}`);
  }
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, `کندل ${symbol}`);

  if (!res.ok || !Array.isArray(body)) {
    const msg = body?.msg || `HTTP ${res.status}`;
    throw new MarketDataError(`گرفتن کندل برای ${symbol} شکست خورد: ${msg}`);
  }
  if (body.length === 0) {
    throw new MarketDataError(`داده‌ای برای ${symbol}/${timeframe} برنگشت.`);
  }

  return body.map((k) => ({
    time: Math.floor(k[0] / 1000), // Binance gives ms; backtest.js wants seconds
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/** Single current price. */
export async function fetchCurrentPrice(symbol) {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, `قیمت ${symbol}`);
  if (!res.ok || !body?.price) {
    throw new MarketDataError(`گرفتن قیمت لحظه‌ای ${symbol} شکست خورد: ${body?.msg || res.status}`);
  }
  return Number(body.price);
}

/**
 * Prices for many symbols in ONE Binance call (used by the cron TP/SL
 * checker so N open signals across a handful of symbols cost one
 * subrequest instead of N -- Workers Free caps a single invocation at 50
 * subrequests total, D1 calls included). Returns { SYMBOL: price }.
 */
export async function fetchCurrentPrices(symbols) {
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return {};
  if (unique.length === 1) {
    return { [unique[0]]: await fetchCurrentPrice(unique[0]) };
  }
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(unique))}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, "قیمت‌ها");
  if (!res.ok || !Array.isArray(body)) {
    throw new MarketDataError(`گرفتن قیمت‌های لحظه‌ای شکست خورد: ${body?.msg || res.status}`);
  }
  const out = {};
  for (const row of body) out[row.symbol] = Number(row.price);
  return out;
}
