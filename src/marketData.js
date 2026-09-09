// KuCoin is the primary public market-data source selected after probing the
// available exchange routes. It provides OHLC plus traded volume for up to
// 1,500 candles per time-paged request.
const KUCOIN_BASE = "https://api.kucoin.com";
const BITGET_BASE = "https://api.bitget.com";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const MARKET_REQUEST_TIMEOUT_MS = 12000;
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
export const CANDLE_SOURCES = [
  { id: "kucoin", label: "KuCoin", kind: "exchange" },
  { id: "bitget", label: "Bitget", kind: "exchange" },
];
const KUCOIN_INTERVALS = { "15m": ["15min", 900], "1h": ["1hour", 3600], "4h": ["4hour", 14400], "1d": ["1day", 86400] };
const BITGET_INTERVALS = { "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" };

/** "btc" / "BTC" / "btcusdt" -> "BTCUSDT". Leaves an already-quoted pair alone. */
export function normalizeSymbol(input) {
  const upper = String(input).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const knownQuotes = ["USDT", "BUSD", "USDC", "FDUSD"];
  if (knownQuotes.some((q) => upper.endsWith(q))) return upper;
  return upper + "USDT";
}

export class MarketDataError extends Error {}

async function marketFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new MarketDataError("پاسخ منبع بازار بیش از حد طول کشید و متوقف شد.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(res, endpoint) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    const error = new MarketDataError(
      `سرویس بازار برای ${endpoint} پاسخ JSON معتبر نداد (HTTP ${res.status}). چند لحظه بعد دوباره امتحان کن.`
    );
    error.invalidJson = true;
    error.status = res.status;
    throw error;
  }
}

function shouldUseFallback(status) {
  return status === 403 || status === 429 || status === 451 || status >= 500;
}

function baseAsset(symbol) {
  return String(symbol).replace(/(?:USDT|BUSD|USDC|FDUSD)$/, "");
}

async function coinGeckoIdForSymbol(symbol) {
  const base = baseAsset(symbol);
  if (COINGECKO_IDS[base]) return COINGECKO_IDS[base];

  const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(base)}`;
  const res = await marketFetch(url, { headers: { Accept: "application/json" } });
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
  const res = await marketFetch(url, { headers: { Accept: "application/json" } });
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

async function fetchBitgetCandles(symbol, timeframe, limit) {
  const granularity = BITGET_INTERVALS[timeframe];
  const rows = [];
  let remaining = limit;
  let endTime = Date.now();

  while (remaining > 0) {
    const pageLimit = Math.min(200, remaining);
    const url = `${BITGET_BASE}/api/v2/spot/market/history-candles?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&endTime=${Math.floor(endTime)}&limit=${pageLimit}`;
    const res = await marketFetch(url, { headers: { Accept: "application/json" } });
    const body = await readJsonResponse(res, `کندل جایگزین ${symbol}`);
    if (!res.ok || body?.code !== "00000" || !Array.isArray(body?.data)) {
      const error = new MarketDataError(`منبع دوم بازار برای ${symbol} پاسخ معتبر نداد: ${body?.msg || body?.code || `HTTP ${res.status}`}`);
      error.status = res.status;
      throw error;
    }
    if (body.data.length === 0) break;
    rows.push(...body.data);
    remaining -= body.data.length;
    const oldest = Math.min(...body.data.map((row) => Number(row[0])));
    if (!Number.isFinite(oldest) || body.data.length < pageLimit) break;
    endTime = oldest - 1;
  }

  const deduped = new Map();
  for (const row of rows) deduped.set(Number(row[0]), row);
  const candles = [...deduped.values()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(-limit)
    .map((row) => ({
      time: Number(row[0]) / 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  if (candles.length < Math.min(limit, 50)) throw new MarketDataError(`داده‌ی کافی برای ${symbol}/${timeframe} از منبع دوم برنگشت.`);
  return candles;
}

async function fallbackCandles(symbol, timeframe, limit) {
  try {
    return await fetchBitgetCandles(symbol, timeframe, limit);
  } catch (bitgetError) {
    console.error("Bitget candle fallback failed", symbol, timeframe, bitgetError);
    return fetchCoinGeckoCandles(symbol, timeframe, limit);
  }
}

async function fetchCoinGeckoPrices(symbols) {
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await coinGeckoIdForSymbol(symbol)]));
  const ids = [...new Set(entries.map(([, id]) => id))];
  const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
  const res = await marketFetch(url, { headers: { Accept: "application/json" } });
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

function kucoinSymbol(symbol) {
  return `${baseAsset(symbol)}-USDT`;
}

function normalizeKucoinCandles(rows, limit) {
  return rows
    .flat()
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(-limit)
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5]),
    }));
}

async function fetchKucoinCandles(symbol, timeframe, limit) {
  const [type, intervalSeconds] = KUCOIN_INTERVALS[timeframe];
  const pages = [];
  let remaining = limit;
  let endAt = Math.floor(Date.now() / 1000);

  while (remaining > 0) {
    const pageLimit = Math.min(1500, remaining);
    const startAt = endAt - pageLimit * intervalSeconds;
    const url = `${KUCOIN_BASE}/api/v1/market/candles?symbol=${encodeURIComponent(kucoinSymbol(symbol))}&type=${type}&startAt=${startAt}&endAt=${endAt}`;
    let res;
    try {
      res = await marketFetch(url, { headers: { Accept: "application/json" } });
      const body = await readJsonResponse(res, `کندل ${symbol}`);
      if (!res.ok || body?.code !== "200000" || !Array.isArray(body?.data)) {
        const error = new MarketDataError(`گرفتن کندل برای ${symbol} شکست خورد: ${body?.msg || body?.code || `HTTP ${res.status}`}`);
        error.status = res.status;
        throw error;
      }
      const data = body.data;
      if (data.length === 0) break;
      pages.unshift(data);
      remaining -= data.length;
      const oldest = Math.min(...data.map((row) => Number(row[0])));
      if (!Number.isFinite(oldest)) break;
      endAt = oldest - 1;
    } catch (err) {
      if (res) err.status ??= res.status;
      throw err;
    }
  }

  // KuCoin returns every page newest-first; every strategy and backtest in this
  // project expects a chronological (oldest-first) series.
  return normalizeKucoinCandles(pages, limit);
}

/**
 * Returns candles as [{ time (unix SECONDS -- backtest.js's
 * estimatePeriodsPerYear divides by this unit for Sharpe annualization,
 * getting it wrong silently skews every risk-adjusted stat), open, high,
 * low, close, volume }], oldest first.
 */
export async function fetchCandles(symbol, timeframe, limit = 300, source = "auto") {
  if (!VALID_TIMEFRAMES.includes(timeframe)) {
    throw new MarketDataError(`تایم‌فریم نامعتبر: ${timeframe}`);
  }
  const selected = String(source || "auto").toLowerCase();
  if (selected === "kucoin") return fetchKucoinCandles(symbol, timeframe, limit);
  if (selected === "bitget") return fetchBitgetCandles(symbol, timeframe, limit);
  if (selected === "coingecko") return fetchCoinGeckoCandles(symbol, timeframe, limit);
  if (selected !== "auto") throw new MarketDataError(`منبع داده نامعتبر است: ${source}`);
  try {
    const candles = await fetchKucoinCandles(symbol, timeframe, limit);
    if (candles.length === 0) throw new MarketDataError(`داده‌ای برای ${symbol}/${timeframe} برنگشت.`);
    return candles;
  } catch (err) {
    if (err?.invalidJson || shouldUseFallback(err?.status) || err?.status == null) {
      return fallbackCandles(symbol, timeframe, limit);
    }
    throw err;
  }
}

export function candleSourceLabel(source) {
  return CANDLE_SOURCES.find((item) => item.id === source)?.label ?? String(source || "نامشخص");
}

/** Probe the exact symbol/timeframe/history requested before showing source buttons. */
export async function checkCandleSources(symbol, timeframe, limit) {
  const requested = Math.max(50, Math.trunc(Number(limit) || 60));
  return Promise.all(CANDLE_SOURCES.map(async (source) => {
    const startedAt = Date.now();
    try {
      const candles = await fetchCandles(symbol, timeframe, requested, source.id);
      const valid = candles.filter((candle) =>
        Number.isFinite(candle.time) && Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) && Number.isFinite(candle.close) && candle.close > 0 &&
        candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close)
      );
      const coverage = candles.length / requested;
      const available = valid.length === candles.length && candles.length >= Math.min(requested, 50) && coverage >= 0.9;
      return {
        id: source.id,
        label: source.label,
        kind: source.kind,
        available,
        candleCount: candles.length,
        requested,
        latencyMs: Date.now() - startedAt,
        error: available ? null : `پوشش تاریخی کافی نیست (${candles.length}/${requested} کندل)`,
      };
    } catch (error) {
      return {
        id: source.id,
        label: source.label,
        kind: source.kind,
        available: false,
        candleCount: 0,
        requested,
        latencyMs: Date.now() - startedAt,
        error: String(error?.message ?? error),
      };
    }
  }));
}

/** Single current price. */
export async function fetchCurrentPrice(symbol) {
  const url = `${KUCOIN_BASE}/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(kucoinSymbol(symbol))}`;
  let res;
  let body;
  try {
    res = await marketFetch(url, { headers: { Accept: "application/json" } });
    body = await readJsonResponse(res, `قیمت ${symbol}`);
  } catch (err) {
    if (err?.invalidJson || shouldUseFallback(res?.status) || !res) {
      return (await fetchCoinGeckoPrices([symbol]))[symbol];
    }
    throw err;
  }
  if (!res.ok || body?.code !== "200000" || !body?.data?.price) {
    if (shouldUseFallback(res.status)) return (await fetchCoinGeckoPrices([symbol]))[symbol];
    throw new MarketDataError(`گرفتن قیمت لحظه‌ای ${symbol} شکست خورد: ${body?.msg || body?.code || res.status}`);
  }
  return Number(body.data.price);
}

/**
 * Prices for many symbols in ONE KuCoin call (used by the cron TP/SL
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
  const url = `${KUCOIN_BASE}/api/v1/market/allTickers`;
  let res;
  let body;
  try {
    res = await marketFetch(url, { headers: { Accept: "application/json" } });
    body = await readJsonResponse(res, "قیمت‌ها");
  } catch (err) {
    if (err?.invalidJson || shouldUseFallback(res?.status) || !res) return fetchCoinGeckoPrices(unique);
    throw err;
  }
  if (!res.ok || body?.code !== "200000" || !Array.isArray(body?.data?.ticker)) {
    if (shouldUseFallback(res.status)) return fetchCoinGeckoPrices(unique);
    throw new MarketDataError(`گرفتن قیمت‌های لحظه‌ای شکست خورد: ${body?.msg || body?.code || res.status}`);
  }
  const out = {};
  const tickers = new Map(body.data.ticker.map((row) => [row.symbol, Number(row.last)]));
  const missing = [];
  for (const symbol of unique) {
    const price = tickers.get(kucoinSymbol(symbol));
    if (!Number.isFinite(price) || price <= 0) missing.push(symbol);
    else out[symbol] = price;
  }
  if (missing.length) {
    try {
      Object.assign(out, await fetchCoinGeckoPrices(missing));
    } catch (err) {
      console.error("Could not resolve some market prices", missing, err);
    }
  }
  return out;
}
