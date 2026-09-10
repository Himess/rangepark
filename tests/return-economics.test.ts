import { describe, expect, it, vi } from "vitest";
import {
  COST_ASSUMPTIONS,
  findHistoryStart,
  growthDelta,
  modelExecutionCost,
  projectedLiquidity,
  projectHistoricalFees,
  type FeeBlock,
  type FeeState,
} from "../src/testnet/return-economics.js";
import { returnFixture } from "./fixtures/return.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
import type { Hex } from "viem";
const blockHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
function fixture() {
  const snapshot = returnFixture(),
    liquidity = projectedLiquidity(snapshot);
  const start: FeeState = {
    block: { number: 100n, hash: blockHash(100), timestamp: 6400 },
    growth0: 0n,
    growth1: 0n,
    tick: -196200,
    liquidity: 10n ** 20n,
  };
  const before = { ...start, block: { number: 199n, hash: blockHash(199), timestamp: 9998 } };
  const end: FeeState = {
    ...start,
    block: { number: 200n, hash: blockHash(200), timestamp: 10000 },
    growth0: ((1n << 128n) * 1000n) / liquidity,
  };
  const item: FeeBlock = {
    before,
    after: end,
    activity: [
      {
        blockNumber: 200n,
        blockHash: end.block.hash,
        transactionHash: blockHash(999),
        index: 1,
        kind: "Swap",
        sender: "0x4444444444444444444444444444444444444444",
        recipient: "0x5555555555555555555555555555555555555555",
        tick: -196200,
        liquidity: start.liquidity,
      },
    ],
  };
  return {
    snapshot,
    start,
    end,
    blocks: [item],
    excludedHashes: new Set<string>(),
    horizonSeconds: 3600,
  };
}
describe("observed RETURN fee projection", () => {
  it("attributes fee growth only to estimated strategy liquidity and applies dilution", () => {
    const f = fixture(),
      result = projectHistoricalFees(f);
    expect(result.historicalFees0).toBeGreaterThan(0n);
    expect(result.historicalFees0).toBeLessThan(1000n);
    expect(result.expectedLpFees).toBe(result.historicalFees0);
    expect(result.details[0]!.reason).toBe("INCLUDED");
  });
  it("reports zero income for a complete inactive window", () => {
    const f = fixture();
    f.blocks = [];
    f.end.growth0 = 0n;
    expect(projectHistoricalFees(f).expectedLpFees).toBe(0n);
  });
  it("does not interpret a missing event/block as zero income", () => {
    const f = fixture();
    f.blocks = [];
    expect(() => projectHistoricalFees(f)).toThrow("does not reconcile");
  });
  it.each(["known-fixture", "own-recipient", "own-sender"])(
    "excludes the whole block containing %s",
    (kind) => {
      const f = fixture(),
        a = f.blocks[0]!.activity[0]!;
      if (kind === "known-fixture") f.excludedHashes.add(a.transactionHash.toLowerCase());
      if (kind === "own-recipient") a.recipient = f.snapshot.lot.owner;
      if (kind === "own-sender") a.sender = f.snapshot.lot.owner;
      f.blocks[0]!.activity.push({
        ...a,
        transactionHash: blockHash(1234),
        index: 2,
        recipient: "0x6666666666666666666666666666666666666666",
      });
      const r = projectHistoricalFees(f);
      expect(r.expectedLpFees).toBe(0n);
      expect(r.details[0]!.reason).toBe("PROJECT_ACTIVITY_EXCLUDED");
    },
  );
  it.each(["Mint", "Burn"] as const)(
    "omits %s blocks rather than guessing intra-block liquidity",
    (kind) => {
      const f = fixture();
      f.blocks[0]!.activity.push({ ...f.blocks[0]!.activity[0]!, kind, index: 2 });
      expect(projectHistoricalFees(f).details[0]!.reason).toBe("LIQUIDITY_CHANGE_BLOCK_EXCLUDED");
    },
  );
  it.each(["before", "after", "intra-block"])(
    "excludes %s range crossings including reentry in the same block",
    (kind) => {
      const f = fixture();
      if (kind === "before") f.blocks[0]!.before.tick = f.snapshot.lot.lower - 1;
      if (kind === "after") f.end.tick = f.snapshot.lot.upper;
      if (kind === "intra-block")
        f.blocks[0]!.activity.push({
          ...f.blocks[0]!.activity[0]!,
          index: 2,
          tick: f.snapshot.lot.upper,
        });
      const r = projectHistoricalFees(f);
      expect(r.expectedLpFees).toBe(0n);
      expect(r.details[0]!.reason).toBe("RANGE_CROSSING_BLOCK_EXCLUDED");
    },
  );
  it("declines the historical approximation when adding our liquidity would be material", () => {
    const f = fixture();
    f.blocks[0]!.before.liquidity = projectedLiquidity(f.snapshot) * 99n;
    expect(projectHistoricalFees(f).details[0]!.reason).toBe(
      "MATERIAL_COUNTERFACTUAL_LIQUIDITY_EXCLUDED",
    );
  });
  it("handles uint256 fee-growth wrap without generating enormous income", () => {
    expect(growthDelta((1n << 256n) - 4n, 3n)).toBe(7n);
    expect(() => growthDelta(-1n, 3n)).toThrow();
    const f = fixture(),
      delta = f.end.growth0;
    f.start.growth0 = (1n << 256n) - 10n;
    f.blocks[0]!.before.growth0 = f.start.growth0;
    f.end.growth0 = delta - 10n;
    expect(projectHistoricalFees(f).expectedLpFees).toBeGreaterThan(0n);
    expect(projectHistoricalFees(f).expectedLpFees).toBeLessThan(1000n);
  });
  it.each(["duplicate", "foreign-block", "wrong-parent", "short-window"])(
    "rejects %s evidence",
    (kind) => {
      const f = fixture();
      if (kind === "duplicate") f.blocks.push(f.blocks[0]!);
      if (kind === "foreign-block") f.blocks[0]!.activity[0]!.blockHash = blockHash(123);
      if (kind === "wrong-parent") f.blocks[0]!.before.block.number--;
      if (kind === "short-window") f.start.block.timestamp = 9999;
      expect(() => projectHistoricalFees(f)).toThrow();
    },
  );
  it("uses the lower WETH valuation from spot and TWAP for token1 fees", () => {
    const f = fixture();
    f.end.growth0 = 0n;
    f.end.growth1 = ((1n << 128n) * 1000n) / projectedLiquidity(f.snapshot);
    const spot = projectHistoricalFees(f).expectedLpFees;
    f.snapshot.position.twapTick = (f.snapshot.position.twapTick ?? 0) + 100;
    expect(projectHistoricalFees(f).expectedLpFees).toBeLessThan(spot);
  });
});
describe("six-call execution budget", () => {
  it("includes L2, L1 data, operator and swap-loss components without treating sponsorship as zero", () => {
    const cost = modelExecutionCost(10000n, 5n, 7n, 3n);
    expect(cost.l2).toBe(6n * 4000000n * 10n);
    expect(cost.l1).toBe(42n);
    expect(cost.operator).toBe(18n);
    expect(cost.swapLoss).toBe(100n);
    expect(cost.total).toBe(cost.l2 + cost.l1 + cost.operator + 100n);
    expect(cost.assumptions).toEqual(COST_ASSUMPTIONS);
  });
  it("rounds the loss budget up and rejects missing gas-price data", () => {
    expect(modelExecutionCost(1n, 1n, 0n, 0n).swapLoss).toBe(1n);
    expect(() => modelExecutionCost(1n, 0n, 0n, 0n)).toThrow();
  });
  it("finds the timestamp boundary without assuming a chain block time", async () => {
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: 5000n + blockNumber * 3n,
    }));
    const client = { getBlock } as unknown as TestnetReturnClient;
    expect(
      await findHistoryStart(
        client,
        { number: 10000n, hash: blockHash(10000), timestamp: 35000 },
        3600,
      ),
    ).toBe(8800n);
    expect(getBlock.mock.calls.length).toBeLessThan(20);
  });
});
