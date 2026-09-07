import { WorkflowEntrypoint } from "cloudflare:workers";
import { STRATEGIES, currentSignalState } from "../lib/strategies.js";
import { calculateATR, positionSize as calculatePositionSize } from "../lib/risk.js";
import { fitOneStrategy, fitOneStrategyOptimized, pickBest, labelText } from "../lib/singleStrategyFit.js";
import { fetchCandles } from "../marketData.js";
import { sendMessage, escapeHtml } from "../telegram.js";
import * as db from "../db.js";
import { capPositionSize, calculateSignalLevels, formatSignalMessage, formatNoStrategyMessage, formatFlatMessage } from "../signalFormat.js";
import { assertUsableCandles, qualitySummary } from "../dataQuality.js";

const PERIODS_PER_DAY = { "15m": 96, "1h": 24, "4h": 6, "1d": 1 };
const STRATEGY_ENTRIES = Object.entries(STRATEGIES).filter(([, strategy]) => strategy.category !== "benchmark");
const BASIS_LABELS = {
  return: "بیشترین بازده",
  sharpe: "بهترین Sharpe",
  winrate: "بیشترین نرخ برد",
  drawdown: "کمترین افت سرمایه",
  profitfactor: "بهترین Profit Factor",
};
const CATEGORY_LABELS = {
  trend: "روند", momentum: "مومنتوم", reversion: "بازگشتی", hybrid: "ترکیبی",
  quant: "کمّی/شبیه‌سازی", volatility: "نوسانی", income: "درآمدی", hedge: "پوششی", spread: "اسپرد",
};

function candleLookback(timeframe, backtestDays) {
  const days = Number(backtestDays);
  if (!Number.isFinite(days) || days <= 0) return 300;
  return Math.max(60, Math.ceil(days * (PERIODS_PER_DAY[timeframe] ?? 1)));
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function compactRow(row) {
  return {
    key: row.key,
    label: row.label,
    description: row.description,
    category: row.category,
    params: row.params,
    fit: row.fit ?? { testedCount: 1, improved: false, baselineReturnPercent: row.result.totalReturnPercent },
    result: {
      totalReturnPercent: row.result.totalReturnPercent,
      winRate: row.result.winRate,
      tradeCount: row.result.tradeCount,
      sharpe: finiteOrNull(row.result.sharpe),
      sortino: finiteOrNull(row.result.sortino),
      maxDrawdownPercent: row.result.maxDrawdownPercent,
      profitFactor: finiteOrNull(row.result.profitFactor),
      profitFactorInfinite: row.result.profitFactor === Infinity,
      benchmarkReturnPercent: row.result.benchmarkReturnPercent,
      wasLiquidated: Boolean(row.result.wasLiquidated),
    },
  };
}

function priceRiskParams(config, candles) {
  if (config.exitMode === "atr") {
    const atr = calculateATR(candles, 14);
    const close = Number(candles.at(-1)?.close);
    if (!(atr > 0) || !(close > 0)) return null;
    return {
      stopLossPercent: (atr * 1.5 / close) * 100,
      takeProfitPercent: (atr * 3 / close) * 100,
    };
  }
  if (config.exitMode !== "roi") return null;
  const leverage = config.marketType === "futures" ? Math.max(1, Number(config.leverage) || 1) : 1;
  return {
    stopLossPercent: Number(config.stopLossPercent) / leverage,
    takeProfitPercent: Number(config.takeProfitPercent) / leverage,
  };
}

function fitArgs(candles, key, strategy, config) {
  const riskParams = priceRiskParams(config, candles);
  return {
    candles,
    key,
    strategy,
    leverage: config.marketType === "futures" ? Number(config.leverage) || 1 : 1,
    direction: config.marketType === "spot" ? "long" : config.direction || "both",
    feePercent: Number(config.feePercent) || 0,
    fillTiming: config.fillTiming === "close" ? "close" : "nextOpen",
    riskParams,
    sizing: config.accountSize > 0 && config.riskPercent > 0 && riskParams
      ? { mode: "riskPercent", riskPercent: Number(config.riskPercent) }
      : null,
  };
}

function fmt(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
}

async function sendFitReport(env, chatId, requestId, rows, config) {
  const pages = [];
  for (let i = 0; i < rows.length; i += 4) pages.push(rows.slice(i, i + 4));
  for (let page = 0; page < pages.length; page++) {
    const lines = [
      `<b>نتایج فیت استراتژی‌ها · ${page + 1}/${pages.length}</b>`,
      `${escapeHtml(config.symbol)} · ${config.timeframe} · ${config.backtestDays} روز · ${config.marketType === "spot" ? "Spot" : `Futures ${config.leverage}x`}`,
      config.dataQuality ? `کیفیت داده: ${qualitySummary(config.dataQuality)}` : "",
      "",
    ];
    for (const row of pages[page]) {
      const result = row.result;
      lines.push(
        `<b>${escapeHtml(labelText(row.label))}</b> · ${escapeHtml(CATEGORY_LABELS[row.category] ?? row.category)}`,
        escapeHtml(labelText(row.description)),
        `بازده: ${fmt(result.totalReturnPercent)}٪ | برد: ${fmt(result.winRate)}٪ | معاملات: ${result.tradeCount}`,
        `Sharpe: ${fmt(result.sharpe, 2)} | Sortino: ${fmt(result.sortino, 2)} | Max DD: ${fmt(result.maxDrawdownPercent)}٪`,
        `Profit Factor: ${result.profitFactorInfinite ? "∞" : fmt(result.profitFactor, 2)} | Buy & Hold: ${fmt(result.benchmarkReturnPercent)}٪`,
        `پارامتر فیت‌شده: <code>${escapeHtml(JSON.stringify(row.params))}</code>`,
        `تعداد ترکیب آزمایش‌شده: ${row.fit.testedCount}${row.fit.improved ? " · پارامترها روی بخش آموزش تغییر کردند" : " · تنظیم پیش‌فرض حفظ شد"}`,
        row.fit.validation?.available
          ? `Walk-Forward: فیت‌شده ${fmt(row.fit.validation.fittedReturnPercent)}٪ در برابر پیش‌فرض ${fmt(row.fit.validation.defaultReturnPercent)}٪ · ${row.fit.validation.passed ? "✅ پایدارتر" : "⚠️ برتری تأیید نشد"}`
          : "Walk-Forward: داده‌ی کافی برای جداسازی آموزش/آزمون نبود",
        result.wasLiquidated ? "⚠️ در بک‌تست لیکویید شده" : "",
        ""
      );
    }
    await sendMessage(env, chatId, lines.filter((line) => line !== "").join("\n\n"));
  }
  await sendMessage(env, chatId,
    "<b>مرحله‌ی انتخاب</b>\n\nاول مشخص کن استراتژی‌ها بر چه معیاری مرتب شوند. بعد فهرست مرتب‌شده می‌آید و خودت استراتژی نهایی را انتخاب می‌کنی.",
    { reply_markup: { inline_keyboard: [
      [{ text: "📈 بیشترین بازده", callback_data: `fit:basis:${requestId}:return` }, { text: "⚖️ بهترین Sharpe", callback_data: `fit:basis:${requestId}:sharpe` }],
      [{ text: "🎯 بیشترین نرخ برد", callback_data: `fit:basis:${requestId}:winrate` }, { text: "🛡 کمترین افت", callback_data: `fit:basis:${requestId}:drawdown` }],
      [{ text: "💹 Profit Factor", callback_data: `fit:basis:${requestId}:profitfactor` }],
      [{ text: "❌ لغو", callback_data: `fit:cancel:${requestId}` }],
    ] } }
  );
}

async function notifyFailure(step, env, { requestId, chatId, symbol } = {}, err, stepName = "notify-unexpected-error") {
  const message = err?.message ?? String(err);
  console.error("SignalFitWorkflow failed", err);
  try {
    await step.do(stepName, async () => {
      if (requestId) {
        await db.updateSignalRequestStatus(env, requestId, "failed");
        await db.finishSignalFitRun(env, requestId, "failed").catch(() => {});
      }
      if (chatId) await sendMessage(env, chatId, `⚠️ یک خطای غیرمنتظره رخ داد و تحلیل ${escapeHtml(symbol || "درخواست")} کامل نشد.\n\nعلت: ${escapeHtml(message)}\n\nتنظیماتت از بین نرفته؛ دوباره از منوی سیگنال شروع کن.`);
    });
  } catch (notifyError) {
    console.error("Could not notify signal fit failure", notifyError);
  }
}

export class SignalFitWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload;
    if (payload.operation === "finalize") return this.finalize(payload, step);
    return this.fit(payload, step);
  }

  async fit(payload, step) {
    const config = {
      marketType: payload.marketType ?? (Number(payload.leverage) > 1 ? "futures" : "spot"),
      direction: payload.direction ?? (Number(payload.leverage) > 1 ? "both" : "long"),
      feePercent: payload.feePercent ?? 0.1,
      fillTiming: payload.fillTiming ?? "close",
      exitMode: payload.exitMode ?? "roi",
      accountSize: payload.accountSize ?? 0,
      riskPercent: payload.riskPercent ?? 0,
      ...payload,
    };
    let candles;
    try {
      candles = await step.do("fetch-candles", async () => fetchCandles(config.symbol, config.timeframe, candleLookback(config.timeframe, config.backtestDays)));
      config.dataQuality = await step.do("validate-candles", async () => assertUsableCandles(candles, config.timeframe));
    } catch (err) {
      await notifyFailure(step, this.env, config, err, "notify-fetch-failed");
      return { outcome: "fetch_failed" };
    }

    try {
      const rows = [];
      for (const [key, strategy] of STRATEGY_ENTRIES) {
        const row = await step.do(`fit-${key}`, async () => {
          const args = fitArgs(candles, key, strategy, config);
          return compactRow(payload.operation === "fit" ? fitOneStrategyOptimized(args) : fitOneStrategy(args));
        });
        rows.push(row);
      }

      // Backward compatibility for old Workflow payloads and tests: before
      // the interactive chooser existed, the highest positive return was
      // selected automatically.
      if (payload.operation !== "fit") {
        const best = await step.do("pick-best", async () => pickBest(rows));
        if (!best) {
          await step.do("notify-no-strategy", async () => {
            await db.updateSignalRequestStatus(this.env, config.requestId, "no_profitable_strategy");
            await sendMessage(this.env, config.chatId, formatNoStrategyMessage(config));
          });
          return { outcome: "no_profitable_strategy" };
        }
        return this.issueFromSelection({ config, selected: best, candles }, step, false);
      }

      await step.do("save-fit-results", async () => {
        await db.saveSignalFitRun(this.env, { requestId: config.requestId, userId: config.userId, config, results: rows });
        await db.updateSignalRequestStatus(this.env, config.requestId, "awaiting_selection");
      });
      await step.do("send-fit-results", async () => sendFitReport(this.env, config.chatId, config.requestId, rows, config));
      return { outcome: "awaiting_selection", strategies: rows.length };
    } catch (err) {
      await notifyFailure(step, this.env, config, err);
      return { outcome: "error", error: String(err?.message ?? err) };
    }
  }

  async finalize(payload, step) {
    let run;
    try {
      run = await step.do("load-selection", async () => db.getSignalFitRun(this.env, payload.requestId));
      if (!run || String(run.user_id) !== String(payload.userId)) throw new Error("نتیجه‌ی فیت پیدا نشد یا متعلق به این کاربر نیست.");
      const selected = run.results.find((row) => row.key === payload.strategyKey);
      if (!selected) throw new Error("استراتژی انتخاب‌شده در نتیجه‌ی فیت وجود ندارد.");
      run.config.selectedBasis = run.selected_basis;
      const candles = await step.do("refetch-candles", async () => fetchCandles(run.config.symbol, run.config.timeframe, candleLookback(run.config.timeframe, run.config.backtestDays)));
      return await this.issueFromSelection({ config: run.config, selected, candles }, step, true);
    } catch (err) {
      await notifyFailure(step, this.env, run?.config ?? payload, err, "notify-finalize-error");
      return { outcome: "error", error: String(err?.message ?? err) };
    }
  }

  async issueFromSelection({ config, selected, candles }, step, interactive) {
    const decision = await step.do("decide", async () => currentSignalState(
      STRATEGIES[selected.key], candles, selected.params,
      config.marketType === "spot" ? "long" : config.direction || "both"
    ));
    if (!decision || decision.state === "flat") {
      await step.do("notify-flat", async () => {
        await db.updateSignalRequestStatus(this.env, config.requestId, "flat");
        if (interactive) await db.finishSignalFitRun(this.env, config.requestId, "flat");
        await sendMessage(this.env, config.chatId, formatFlatMessage({ ...config, strategyLabel: labelText(selected.label) }));
      });
      return { outcome: "flat" };
    }

    const signalId = await step.do("save-and-notify", async () => {
      const entryPrice = decision.lastClose;
      const leverage = config.marketType === "futures" ? Math.max(1, Number(config.leverage) || 1) : 1;
      const atr = calculateATR(candles, 14);
      const levels = calculateSignalLevels({ ...config, entryPrice, direction: decision.state, leverage, atr });
      let sizing = null;
      if (Number(config.accountSize) > 0 && Number(config.riskPercent) > 0) {
        const result = calculatePositionSize({
          accountSize: Number(config.accountSize), riskPercent: Number(config.riskPercent),
          entryPrice, stopPrice: levels.stopLossPrice,
        });
        if (!result.error) sizing = capPositionSize({
          sizing: result,
          accountSize: Number(config.accountSize),
          entryPrice,
          marketType: config.marketType,
          leverage,
        });
      }
      const id = await db.saveSignal(this.env, {
        requestId: config.requestId,
        userId: config.userId,
        symbol: config.symbol,
        timeframe: config.timeframe,
        leverage,
        strategyKey: selected.key,
        strategyLabel: labelText(selected.label),
        direction: decision.state,
        entryPrice,
        stopLossPrice: levels.stopLossPrice,
        takeProfitPrice: levels.takeProfitPrice,
        backtestReturnPercent: selected.result.totalReturnPercent,
        backtestWinRate: selected.result.winRate,
        backtestTradeCount: selected.result.tradeCount,
        backtestSharpe: selected.result.sharpe,
        backtestDetailJson: JSON.stringify({ ...selected.result, params: selected.params, fit: selected.fit }),
      });
      await db.saveSignalMetadata(this.env, id, { ...config, levels, sizing, selectedBasis: payloadBasis(config, selected) });
      await db.updateSignalRequestStatus(this.env, config.requestId, "done");
      if (interactive) await db.finishSignalFitRun(this.env, config.requestId, "done");
      const roiStop = config.exitMode === "atr" ? levels.stopRoiPercent : Number(config.stopLossPercent);
      const roiTarget = config.exitMode === "atr" ? levels.targetRoiPercent : Number(config.takeProfitPercent);
      await sendMessage(this.env, config.chatId, formatSignalMessage({
        ...config,
        leverage,
        direction: decision.state,
        strategyLabel: labelText(selected.label),
        entryPrice,
        stopLossPrice: levels.stopLossPrice,
        takeProfitPrice: levels.takeProfitPrice,
        stopLossPercent: roiStop,
        takeProfitPercent: roiTarget,
        stopMovePercent: levels.stopMovePercent,
        targetMovePercent: levels.targetMovePercent,
        liquidationPrice: levels.liquidationPrice,
        positionSize: sizing?.units,
        positionValue: sizing?.positionValue,
        accountRiskAmount: sizing?.riskAmount,
        positionCapped: sizing?.capped,
        marginRequired: sizing?.marginRequired,
        backtestReturnPercent: selected.result.totalReturnPercent,
        backtestWinRate: selected.result.winRate,
        backtestTradeCount: selected.result.tradeCount,
      }), { reply_markup: { inline_keyboard: [
        [{ text: "📊 جزئیات کامل بک‌تست", callback_data: `detail:${id}` }],
        [{ text: "🔔 مدیریت اتوماسیون", callback_data: "menu:automation" }, { text: "🏠 منوی اصلی", callback_data: "menu:home" }],
      ] } });
      return id;
    });
    return { outcome: "signal", signalId };
  }
}

function payloadBasis(config) {
  return config.selectedBasis ? fitBasisLabel(config.selectedBasis) : null;
}

export function sortFitResults(rows, basis) {
  const copy = [...rows];
  if (basis === "sharpe") return copy.sort((a, b) => (b.result.sharpe ?? -Infinity) - (a.result.sharpe ?? -Infinity));
  if (basis === "winrate") return copy.sort((a, b) => (b.result.winRate ?? 0) - (a.result.winRate ?? 0));
  if (basis === "drawdown") return copy.sort((a, b) => (a.result.maxDrawdownPercent ?? Infinity) - (b.result.maxDrawdownPercent ?? Infinity));
  if (basis === "profitfactor") return copy.sort((a, b) => {
    if (a.result.profitFactorInfinite !== b.result.profitFactorInfinite) return a.result.profitFactorInfinite ? -1 : 1;
    return (b.result.profitFactor ?? -Infinity) - (a.result.profitFactor ?? -Infinity);
  });
  return copy.sort((a, b) => (b.result.totalReturnPercent ?? -Infinity) - (a.result.totalReturnPercent ?? -Infinity));
}

export function fitBasisLabel(basis) {
  return BASIS_LABELS[basis] ?? BASIS_LABELS.return;
}
