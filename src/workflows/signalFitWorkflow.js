import { WorkflowEntrypoint } from "cloudflare:workers";
import { STRATEGIES, currentSignalState } from "../lib/strategies.js";
import { fitOneStrategy, pickBest, labelText } from "../lib/singleStrategyFit.js";
import { fetchCandles } from "../marketData.js";
import { sendMessage, escapeHtml } from "../telegram.js";
import * as db from "../db.js";
import { formatSignalMessage, formatNoStrategyMessage, formatFlatMessage } from "../signalFormat.js";

// Lookback chosen from a real benchmark against this repo's own strategies
// (see the PR description / chat history): at 300 candles the single
// slowest strategy (donchianBreakout) averaged ~2.4ms warm, comfortably
// under the 10ms-per-step budget with headroom for a colder isolate. Bump
// this only after re-benchmarking the slowest strategy at the new size.
const CANDLE_LOOKBACK = 300;

const STRATEGY_ENTRIES = Object.entries(STRATEGIES).filter(([, s]) => s.category !== "benchmark");

export class SignalFitWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { requestId, userId, chatId, symbol, timeframe, leverage, stopLossPercent, takeProfitPercent } = event.payload;
    const riskParams = { stopLossPercent, takeProfitPercent };

    let candles;
    try {
      candles = await step.do("fetch-candles", async () => fetchCandles(symbol, timeframe, CANDLE_LOOKBACK));
    } catch (err) {
      await step.do("notify-fetch-failed", async () => {
        await db.updateSignalRequestStatus(this.env, requestId, "failed");
        await sendMessage(this.env, chatId, `⚠️ نشد کندل ${escapeHtml(symbol)} رو بگیرم: ${escapeHtml(err.message)}`);
      });
      return { outcome: "fetch_failed" };
    }

    // One step per strategy -- see module comment. Each fit-<key> step gets
    // its own fresh 10ms CPU budget on the free plan, instead of all ~20
    // strategies sharing a single 10ms invocation the way a plain Worker
    // handler would.
    const rows = [];
    for (const [key, strategy] of STRATEGY_ENTRIES) {
      const row = await step.do(`fit-${key}`, async () => {
        const r = fitOneStrategy({ candles, key, strategy, leverage, direction: "both", riskParams });
        // Keep step output small (well under the 1MiB/step limit) and
        // return only what pick-best/decide/save actually need.
        return {
          key: r.key,
          label: r.label,
          category: r.category,
          params: r.params,
          result: {
            totalReturnPercent: r.result.totalReturnPercent,
            winRate: r.result.winRate,
            tradeCount: r.result.tradeCount,
            sharpe: r.result.sharpe,
            sortino: r.result.sortino,
            maxDrawdownPercent: r.result.maxDrawdownPercent,
            profitFactor: Number.isFinite(r.result.profitFactor) ? r.result.profitFactor : null,
            benchmarkReturnPercent: r.result.benchmarkReturnPercent,
          },
        };
      });
      rows.push(row);
    }

    const best = await step.do("pick-best", async () => pickBest(rows));

    if (!best) {
      await step.do("notify-no-strategy", async () => {
        await db.updateSignalRequestStatus(this.env, requestId, "no_profitable_strategy");
        await sendMessage(this.env, chatId, formatNoStrategyMessage({ symbol, timeframe }));
      });
      return { outcome: "no_profitable_strategy" };
    }

    const decision = await step.do("decide", async () => {
      // The step-1 fit rows only carry serializable data (no function refs),
      // so re-look-up the actual strategy object (with generateSignals) from
      // the static registry by key -- cheap, no re-fit, no re-fetch.
      const strategyDef = STRATEGIES[best.key];
      return currentSignalState(strategyDef, candles, best.params, "both");
    });

    if (!decision || decision.state === "flat") {
      await step.do("notify-flat", async () => {
        await db.updateSignalRequestStatus(this.env, requestId, "flat");
        await sendMessage(this.env, chatId, formatFlatMessage({ symbol, timeframe, strategyLabel: labelText(best.label) }));
      });
      return { outcome: "flat" };
    }

    const signalId = await step.do("save-and-notify", async () => {
      const direction = decision.state; // "long" | "short"
      const entryPrice = decision.lastClose;
      const slMult = direction === "long" ? 1 - stopLossPercent / 100 : 1 + stopLossPercent / 100;
      const tpMult = direction === "long" ? 1 + takeProfitPercent / 100 : 1 - takeProfitPercent / 100;
      const stopLossPrice = entryPrice * slMult;
      const takeProfitPrice = entryPrice * tpMult;

      const id = await db.saveSignal(this.env, {
        requestId,
        userId,
        symbol,
        timeframe,
        leverage,
        strategyKey: best.key,
        strategyLabel: labelText(best.label),
        direction,
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        backtestReturnPercent: best.result.totalReturnPercent,
        backtestWinRate: best.result.winRate,
        backtestTradeCount: best.result.tradeCount,
        backtestSharpe: best.result.sharpe,
        backtestDetailJson: JSON.stringify(best.result),
      });
      await db.updateSignalRequestStatus(this.env, requestId, "done");

      await sendMessage(
        this.env,
        chatId,
        formatSignalMessage({
          symbol,
          timeframe,
          leverage,
          direction,
          strategyLabel: labelText(best.label),
          entryPrice,
          stopLossPrice,
          takeProfitPrice,
          stopLossPercent,
          takeProfitPercent,
          backtestReturnPercent: best.result.totalReturnPercent,
          backtestWinRate: best.result.winRate,
          backtestTradeCount: best.result.tradeCount,
        }),
        { reply_markup: { inline_keyboard: [[{ text: "جزئیات بیشتر", callback_data: `detail:${id}` }]] } }
      );

      return id;
    });

    return { outcome: "signal", signalId };
  }
}
