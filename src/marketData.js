// Talks to Binance directly from the Worker. Unlike the dashboard's browser
// code, this needs no CORS-proxy trick: a Worker calling Binance server-to-
// server has no CORS restriction, and Cloudflare's edge IPs aren't subject
// to the same geo-block that hits direct requests from Iran (see the
// existing cloudflare-proxy/worker.js header comment -- same underlying
// reason that worker exists in the first place).

const BINANCE_BASE = "https://api.binance.com";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  LINK: "chainlink",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  UNI: "uniswap",
  ATOM: "cosmos",
  NEAR: "near",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
};

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

function shouldUseCoinGecko(status) {
  return status === 403 || status === 429 || status === 451 || status >= 500;
}

function baseAsset(symbol) {
  return String(symbol).replace(/(?:USDT|BUSD|USDC|FDUSD)$/, "");
}

async function coinGeckoIdForSymbol(symbol) {
  const base = baseAsset(symbol);
  if (COINGECKO_IDS[base]) return COINGECKO_IDS[base];

  const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(base)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, `جست‌وجوی ${base}`);
  if (!res.ok || !Array.isArray(body?.coins)) {
    throw new MarketDataError(`برای ${symbol} در منبع جایگزین بازار چیزی پیدا نشد.`);
  }
  const exact = body.coins.find((coin) => String(coin.symbol).toUpperCase() === base);
  const coin = exact ?? body.coins[0];
  if (!coin?.id) throw new MarketDataError(`برای ${symbol} در منبع جایگزین بازار چیزی پیدا نشد.`);
  return coin.id;
}

function aggregateCoinGeckoPrices(body, timeframe, limit) {
  if (!Array.isArray(body?.prices) || body.prices.length === 0) return [];
  const bucketSeconds = timeframe === "4h" ? 4 * 3600 : timeframe === "1h" ? 3600 : 24 * 3600;
  const buckets = new Map();
  for (let i = 0; i < body.prices.length; i++) {
    const [timeMs, rawPrice] = body.prices[i];
    const price = Number(rawPrice);
    if (!Number.isFinite(timeMs) || !Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(timeMs / 1000 / bucketSeconds) * bucketSeconds;
    const volume = Number(body.total_volumes?.[i]?.[1]);
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, {
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      if (Number.isFinite(volume)) current.volume += volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

async function fetchCoinGeckoCandles(symbol, timeframe, limit) {
  if (timeframe === "15m") {
    throw new MarketDataError("منبع جایگزین برای تایم‌فریم ۱۵ دقیقه‌ای داده‌ی کافی نمی‌دهد؛ بعداً دوباره امتحان کن.");
  }
  const id = await coinGeckoIdForSymbol(symbol);
  const days = timeframe === "1d" ? Math.max(365, Math.ceil(limit * 1.2)) : Math.min(90, Math.max(2, Math.ceil((limit * (timeframe === "4h" ? 4 : 1)) / 24 * 1.2)));
  const interval = timeframe === "1d" ? "&interval=daily" : "";
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}${interval}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, `تاریخچه‌ی ${symbol}`);
  if (!res.ok) {
    throw new MarketDataError(`منبع جایگزین بازار برای ${symbol} در دسترس نیست (HTTP ${res.status}).`);
  }
  const candles = aggregateCoinGeckoPrices(body, timeframe, limit);
  if (candles.length === 0) throw new MarketDataError(`داده‌ای برای ${symbol}/${timeframe} از منبع جایگزین برنگشت.`);
  if (candles.length < Math.min(limit, 50)) {
    throw new MarketDataError(`داده‌ی تاریخی کافی برای ${symbol}/${timeframe} برنگشت.`);
  }
  return candles;
}

async function fetchCoinGeckoPrices(symbols) {
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await coinGeckoIdForSymbol(symbol)]));
  const ids = [...new Set(entries.map(([, id]) => id))];
  const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await readJsonResponse(res, "قیمت لحظه‌ای");
  if (!res.ok) throw new MarketDataError(`منبع جایگزین قیمت در دسترس نیست (HTTP ${res.status}).`);

  const out = {};
  for (const [symbol, id] of entries) {
    const price = Number(body?.[id]?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new MarketDataError(`قیمت ${symbol} از منبع جایگزین برنگشت.`);
    out[symbol] = price;
  }
  return out;
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
  let res;
  let body;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
    body = await readJsonResponse(res, `کندل ${symbol}`);
  } catch (err) {
    if (shouldUseCoinGecko(res?.status) || !res) return fetchCoinGeckoCandles(symbol, timeframe, limit);
    throw err;
  }

  if (!res.ok || !Array.isArray(body)) {
    if (shouldUseCoinGecko(res.status)) return fetchCoinGeckoCandles(symbol, timeframe, limit);
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
  let res;
  let body;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
    body = await readJsonResponse(res, `قیمت ${symbol}`);
  } catch (err) {
    if (shouldUseCoinGecko(res?.status) || !res) return (await fetchCoinGeckoPrices([symbol]))[symbol];
    throw err;
  }
  if (!res.ok || !body?.price) {
    if (shouldUseCoinGecko(res.status)) return (await fetchCoinGeckoPrices([symbol]))[symbol];
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
  let res;
  let body;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
    body = await readJsonResponse(res, "قیمت‌ها");
  } catch (err) {
    if (shouldUseCoinGecko(res?.status) || !res) return fetchCoinGeckoPrices(unique);
    throw err;
  }
  if (!res.ok || !Array.isArray(body)) {
    if (shouldUseCoinGecko(res.status)) return fetchCoinGeckoPrices(unique);
    throw new MarketDataError(`گرفتن قیمت‌های لحظه‌ای شکست خورد: ${body?.msg || res.status}`);
  }
  const out = {};
  for (const row of body) out[row.symbol] = Number(row.price);
  return out;
}
