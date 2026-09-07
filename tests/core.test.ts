import { describe, expect, it } from "vitest";
import { BASE } from "../src/config/base.js";
import { decidePark } from "../src/core/decision.js";
import { meanTick, observePosition, rangeSide } from "../src/core/range.js";
import { hash } from "../src/core/serialization.js";
import { demoInput } from "../src/demo/fixture.js";

describe("Uniswap range semantics", () => {
  it.each([
    [-121, "BELOW"],
    [-120, "IN_RANGE"],
    [-1, "IN_RANGE"],
    [0, "ABOVE"],
    [1, "ABOVE"],
  ] as const)("tick %i is %s for [-120, 0)", (tick, expected) =>
    expect(rangeSide(tick, -120, 0)).toBe(expected),
  );
  it("rejects malformed tick ranges", () => {
    expect(() => rangeSide(0, 0, 0)).toThrow();
    expect(() => rangeSide(0.5, -10, 10)).toThrow();
  });
  it("rounds negative TWAP ticks toward minus infinity", () => {
    expect(meanTick(0n, -301n, 300)).toBe(-2);
    expect(meanTick(0n, -300n, 300)).toBe(-1);
    expect(meanTick(0n, 301n, 300)).toBe(1);
  });
});

describe("sample persistence", () => {
  it("does not infer duration from one snapshot", () => {
    const input = demoInput();
    input.observation = observePosition(input.position, null, 120);
    expect(decidePark(input).reasons).toContain("PERSISTENCE_NOT_MET");
  });
  it("resets on a monitoring gap", () => {
    const { position: p, observation } = demoInput();
    const next = {
      ...p,
      block: {
        ...p.block,
        number: p.block.number + 100n,
        timestamp: p.block.timestamp + 121,
      },
    };
    expect(observePosition(next, observation, 120).since).toBe(
      next.block.timestamp,
    );
  });
  it("resets on reorg at the same height", () => {
    const { position: p, observation } = demoInput();
    const changed = {
      ...p,
      block: { ...p.block, hash: `0x${"cd".repeat(32)}` as const },
    };
    expect(observePosition(changed, observation, 120).since).toBe(
      p.block.timestamp,
    );
  });
  it("does not accumulate time by polling the same block", () => {
    const { position, observation } = demoInput();
    expect(observePosition(position, observation, 120)).toEqual(observation);
  });
  it("resets if the NFT changes owner", () => {
    const { position, observation } = demoInput();
    expect(
      observePosition({ ...position, owner: BASE.aavePool }, observation, 120)
        .since,
    ).toBe(position.block.timestamp);
  });
});

describe("PARK economic and protocol gates", () => {
  it("accepts the conservative fixed-amount scenario", () => {
    const receipt = decidePark(demoInput());
    expect(receipt.action).toBe("PARK");
    expect(receipt.supplyAmount).toBe(9970000000n);
    expect(receipt.expectedYield).toBe(7648219n);
    expect(receipt.requiredBenefit).toBe(7000000n);
    expect(receipt.simulation).toBe("NOT_RUN");
  });
  it.each([
    [
      "wrong chain",
      "WRONG_CHAIN",
      (i: ReturnType<typeof demoInput>) => {
        i.position.chainId = 1;
      },
    ],
    [
      "wrong token",
      "ASSET_MISMATCH",
      (i: ReturnType<typeof demoInput>) => {
        i.market.asset = i.position.token0;
      },
    ],
    [
      "different market",
      "VENUE_NOT_ALLOWED",
      (i: ReturnType<typeof demoInput>) => {
        i.market.pool = BASE.factory;
      },
    ],
    [
      "paused reserve",
      "RESERVE_UNAVAILABLE",
      (i: ReturnType<typeof demoInput>) => {
        i.market.paused = true;
      },
    ],
    [
      "frozen reserve",
      "RESERVE_UNAVAILABLE",
      (i: ReturnType<typeof demoInput>) => {
        i.market.frozen = true;
      },
    ],
    [
      "cap full",
      "SUPPLY_CAP",
      (i: ReturnType<typeof demoInput>) => {
        i.market.supplyCapRemaining = 1n;
      },
    ],
    [
      "illiquid reserve",
      "WITHDRAWAL_LIQUIDITY",
      (i: ReturnType<typeof demoInput>) => {
        i.market.availableLiquidity = 1n;
      },
    ],
    [
      "zero APR",
      "NOT_ECONOMIC",
      (i: ReturnType<typeof demoInput>) => {
        i.market.supplyAprRay = 0n;
      },
    ],
    [
      "high cost",
      "NOT_ECONOMIC",
      (i: ReturnType<typeof demoInput>) => {
        i.economics.roundTripCost = 100000000n;
      },
    ],
    [
      "opportunity cost",
      "NOT_ECONOMIC",
      (i: ReturnType<typeof demoInput>) => {
        i.economics.foregoneLpFees = 100000000n;
      },
    ],
    [
      "stale data",
      "STALE_DATA",
      (i: ReturnType<typeof demoInput>) => {
        i.now += 61;
      },
    ],
    [
      "future block",
      "STALE_DATA",
      (i: ReturnType<typeof demoInput>) => {
        i.now -= 1;
      },
    ],
    [
      "missing TWAP",
      "TWAP_UNAVAILABLE",
      (i: ReturnType<typeof demoInput>) => {
        i.position.twapTick = null;
      },
    ],
    [
      "TWAP too short",
      "TWAP_UNAVAILABLE",
      (i: ReturnType<typeof demoInput>) => {
        i.position.twapWindowSeconds = 1;
      },
    ],
    [
      "manipulated spot",
      "TWAP_DISAGREEMENT",
      (i: ReturnType<typeof demoInput>) => {
        i.position.currentTick += 101;
      },
    ],
    [
      "TWAP in range",
      "TWAP_DISAGREEMENT",
      (i: ReturnType<typeof demoInput>) => {
        i.position.twapTick = -200000;
      },
    ],
    [
      "mixed blocks",
      "MIXED_BLOCKS",
      (i: ReturnType<typeof demoInput>) => {
        i.market.block = { ...i.market.block, number: 1n };
      },
    ],
    [
      "recent action",
      "COOLDOWN",
      (i: ReturnType<typeof demoInput>) => {
        i.lastActionAt = i.now - 1;
      },
    ],
    [
      "empty position",
      "NO_PARKABLE_PRINCIPAL",
      (i: ReturnType<typeof demoInput>) => {
        i.position.liquidity = 0n;
      },
    ],
  ] as const)("refuses %s", (_, reason, mutate) => {
    const input = demoInput();
    mutate(input);
    const result = decidePark(input);
    expect(result.action).toBe("HOLD");
    expect(result.reasons).toContain(reason);
  });
  it("does not treat an uncapped market as unavailable", () => {
    const input = demoInput();
    input.market.supplyCapRemaining = null;
    expect(decidePark(input).action).toBe("PARK");
  });
  it("returns no break-even when there is no net yield", () => {
    const input = demoInput();
    input.market.supplyAprRay = 0n;
    expect(decidePark(input).breakEvenSeconds).toBeNull();
  });
  it("rejects NaN policy and negative costs instead of accidentally passing", () => {
    const input = demoInput();
    input.policy.horizonSeconds = NaN;
    expect(() => decidePark(input)).toThrow();
    const another = demoInput();
    another.economics.roundTripCost = -1n;
    expect(() => decidePark(another)).toThrow();
  });
  it("hashes objects independently of insertion order without losing bigint precision", () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ amount: 9007199254740993n })).not.toBe(
      hash({ amount: 9007199254740992n }),
    );
    expect(() => hash({ amount: NaN })).toThrow();
  });
});
