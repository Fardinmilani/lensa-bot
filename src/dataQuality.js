const INTERVAL_SECONDS = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

export function assessCandleQuality(candles, timeframe, nowSeconds = Date.now() / 1000) {
  const expected = INTERVAL_SECONDS[timeframe] ?? 0;
  let invalid = 0;
  let nonIncreasing = 0;
  let missing = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const values = [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].map(Number);
    const [time, open, high, low, close, volume] = values;
    if (values.some((value) => !Number.isFinite(value)) || open <= 0 || close <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low || volume < 0) invalid++;
    if (i > 0) {
      const delta = time - Number(candles[i - 1].time);
      if (!(delta > 0)) nonIncreasing++;
      else if (expected && delta > expected * 1.5) missing += Math.max(0, Math.round(delta / expected) - 1);
    }
  }

  const lastTime = Number(candles.at(-1)?.time);
  const staleIntervals = expected && Number.isFinite(lastTime) ? Math.max(0, (nowSeconds - lastTime) / expected - 2) : 0;
  const gapRatio = missing / Math.max(1, candles.length + missing);
  const score = Math.max(0, Math.round(100 - invalid * 15 - nonIncreasing * 20 - gapRatio * 100 - Math.min(25, staleIntervals * 5)));
  const label = score >= 95 ? "عالی" : score >= 85 ? "خوب" : score >= 65 ? "محدود" : "ضعیف";
  return { score, label, invalid, nonIncreasing, missing, staleIntervals, candleCount: candles.length };
}

export function qualitySummary(quality) {
  return `${quality.score}/100 (${quality.label}) · کندل ${quality.candleCount} · شکاف تخمینی ${quality.missing} · نامعتبر ${quality.invalid}`;
}

export function assertUsableCandles(candles, timeframe) {
  const quality = assessCandleQuality(candles, timeframe);
  if (quality.invalid > 0 || quality.nonIncreasing > 0 || quality.score < 50) {
    throw new Error(`کیفیت داده برای تحلیل کافی نیست: ${qualitySummary(quality)}`);
  }
  return quality;
}
