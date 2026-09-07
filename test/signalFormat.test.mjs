import { test } from "node:test";
import assert from "node:assert/strict";
import { capPositionSize, calculateSignalLevels } from "../src/signalFormat.js";

test("futures ROI stop and target are converted to underlying price movement using leverage", () => {
  const levels = calculateSignalLevels({
    entryPrice: 79151.9,
    direction: "long",
    marketType: "futures",
    leverage: 10,
    exitMode: "roi",
    stopLossPercent: 10,
    takeProfitPercent: 50,
  });
  assert.equal(Number(levels.stopLossPrice.toFixed(2)), 78360.38);
  assert.ok(Math.abs(levels.takeProfitPrice - 83109.495) < 1e-8);
  assert.equal(levels.stopMovePercent, 1);
  assert.equal(levels.targetMovePercent, 5);
  assert.equal(Number(levels.stopRoiPercent.toFixed(2)), 10);
  assert.equal(Number(levels.targetRoiPercent.toFixed(2)), 50);
});

test("short futures levels move in the opposite price direction", () => {
  const levels = calculateSignalLevels({
    entryPrice: 100,
    direction: "short",
    marketType: "futures",
    leverage: 5,
    exitMode: "roi",
    stopLossPercent: 10,
    takeProfitPercent: 25,
  });
  assert.equal(levels.stopLossPrice, 102);
  assert.equal(levels.takeProfitPrice, 95);
});

test("position sizing is capped by available futures buying power", () => {
  const result = capPositionSize({
    sizing: { units: 2, positionValue: 200, riskAmount: 10, perUnitRisk: 5 },
    accountSize: 100,
    entryPrice: 100,
    marketType: "futures",
    leverage: 1,
  });
  assert.equal(result.units, 1);
  assert.equal(result.positionValue, 100);
  assert.equal(result.riskAmount, 5);
  assert.equal(result.marginRequired, 100);
  assert.equal(result.capped, true);
});
