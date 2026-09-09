import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { TickMath } from "@uniswap/v3-sdk";
import { decodeFunctionData, type Hex } from "viem";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import {
  decideReturn,
  defaultReturnPolicy,
  observeReturn,
  type ReturnSnapshot,
  type ReturnObservation,
  type ReturnEconomics,
} from "../src/testnet/return-policy.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { buildReturnWithdrawDraft, preflightReturnWithdrawal } from "../src/testnet/return-plan.js";
import { aavePoolAbi } from "../src/chain/abis.js";

const blockHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const owner = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const policy = defaultReturnPolicy;
export function returnFixture(at = 10000): ReturnSnapshot {
  const block = { number: BigInt(at), hash: blockHash(at), timestamp: at };
  const token0 = { address: config.weth, decimals: 18, symbol: "testWETH" };
  const token1 = { address: config.aaveUsdc, decimals: 6, symbol: "Aave testUSDC" };
  return {
    lot: {
      cycleId: blockHash(1),
      chainId: 84532,
      owner,
      tokenId: 82083n,
      pool,
      token0: config.weth,
      token1: config.aaveUsdc,
      fee: 500,
      lower: -196230,
      upper: -196170,
      asset: config.weth,
      principal: 10n ** 15n,
      parkedAt: 1000,
      status: "PARKED",
    },
    position: {
      chainId: 84532,
      tokenId: 82083n,
      owner,
      pool,
      token0,
      token1,
      fee: 500,
      tickLower: -196230,
      tickUpper: -196170,
      currentTick: -196200,
      sqrtPriceX96: BigInt(TickMath.getSqrtRatioAtTick(-196200).toString()),
      liquidity: 0n,
      principal0: 0n,
      principal1: 0n,
      checkpointOwed0: 0n,
      checkpointOwed1: 0n,
      twapTick: -196200,
      twapWindowSeconds: 300,
      block,
    },
    market: {
      chainId: 84532,
      protocol: "aave-v3",
      pool: config.aavePool,
      asset: token0,
      aToken: "0x3333333333333333333333333333333333333333",
      supplyAprRay: 5n * 10n ** 25n,
      availableLiquidity: 10n ** 20n,
      supplyCapRemaining: 0n,
      active: true,
      frozen: false,
      paused: false,
      block,
    },
    aTokenBalance: 10n ** 15n + 100n,
    totalDebtBase: 0n,
  };
}
function quote(s: ReturnSnapshot): ReturnEconomics {
  return {
    chainId: 84532,
    cycleId: s.lot.cycleId,
    asset: config.weth,
    horizonSeconds: 3600,
    quotedAt: s.position.block.timestamp,
    expiresAt: s.position.block.timestamp + 120,
    expectedLpFees: 10n ** 12n,
    executionCost: 10n ** 9n,
    source: "SYNTHETIC_TEST_ONLY",
  };
}
function streak() {
  let observation: ReturnObservation | null = null;
  let snapshot = returnFixture();
  for (let i = 0; i <= 5; i++) {
    snapshot = returnFixture(10000 + i * 60);
    observation = observeReturn(snapshot, policy, observation, snapshot.position.block.timestamp);
  }
  return { snapshot, observation: observation! };
}
function decision(
  s: ReturnSnapshot,
  o: ReturnObservation | null,
  e: ReturnEconomics | null = quote(s),
  now = s.position.block.timestamp,
) {
  return decideReturn({ ...s, policy, observation: o, economics: e, now });
}

describe("testnet automatic RETURN policy", () => {
  it("requires sampled persistence, matching TWAP, cooldown and fresh positive economics", () => {
    const { snapshot: s, observation: o } = streak();
    expect(decision(s, o)).toMatchObject({
      action: "RETURN",
      mode: "REVIEW_ONLY",
      simulation: "NOT_RUN",
    });
    expect(o.samples).toBe(6);
    expect(o.since).toBe(10000);
    expect(decision(s, o).foregoneAaveYield).toBe(5707762558n);
    expect(decision(s, o).expiresAt).toBe(10360);
  });
  it("does not infer persistence from a single fresh snapshot or duplicate block reads", () => {
    const s = returnFixture(),
      first = observeReturn(s, policy, null, 10000);
    expect(observeReturn(s, policy, first, 10020)).toEqual(first);
    expect(decision(s, first).reasons).toContain("RETURN_PERSISTENCE_NOT_MET");
  });
  it.each([-196231, -196230, -196221, -196180, -196170, -196169])(
    "holds at spot tick %s outside buffered range",
    (tick) => {
      const { snapshot: s, observation: o } = streak();
      s.position.currentTick = tick;
      expect(decision(s, o).reasons).toContain("SPOT_OUTSIDE_RETURN_BAND");
    },
  );
  it.each([-196220, -196181])("accepts inner tick %s with matching TWAP", (tick) => {
    const { snapshot: s, observation: o } = streak();
    s.position.currentTick = s.position.twapTick = tick;
    expect(decision(s, o).action).toBe("RETURN");
  });
  it("resets the streak when TWAP disagrees even though spot stays in range", () => {
    const { snapshot: s, observation: o } = streak();
    const bad = returnFixture(10360);
    bad.position.twapTick = -196225;
    const reset = observeReturn(bad, policy, o, 10360);
    expect(reset.since).toBeNull();
    expect(decision(bad, reset).reasons).toContain("TWAP_OUTSIDE_RETURN_BAND");
    const recovered = returnFixture(10420);
    expect(observeReturn(recovered, policy, reset, 10420).since).toBe(10420);
    s.position.twapTick = null;
    expect(decision(s, o).reasons).toContain("TWAP_UNAVAILABLE");
  });
  it("resets after a monitoring gap, same-height reorg or noncanonical previous block", () => {
    const { observation: o } = streak();
    const gap = returnFixture(10421);
    expect(observeReturn(gap, policy, o, 10421).since).toBe(10421);
    const reorg = returnFixture(10300);
    reorg.position.block.hash = blockHash(99);
    expect(observeReturn(reorg, policy, o, 10300).samples).toBe(1);
    const next = returnFixture(10360);
    expect(observeReturn(next, policy, o, 10360, false).since).toBe(10360);
  });
  it("separates cycles and policies so old observations cannot authorize a new return", () => {
    const { snapshot: s, observation: o } = streak();
    s.lot.cycleId = blockHash(2);
    expect(decision(s, o).reasons).toContain("RETURN_PERSISTENCE_NOT_MET");
    expect(observeReturn(s, policy, o, 10300).samples).toBe(1);
    expect(
      observeReturn(returnFixture(10300), { ...policy, edgeBufferTicks: 11 }, o, 10300).samples,
    ).toBe(1);
  });
  it.each([
    [
      "LOT_NOT_PARKED",
      (s: ReturnSnapshot) => {
        s.lot.status = "RESTORED";
      },
    ],
    [
      "LOT_NOT_PARKED",
      (s: ReturnSnapshot) => {
        s.lot.status = "RECOVERY";
      },
    ],
    [
      "ORIGINAL_NFT_NOT_EMPTY",
      (s: ReturnSnapshot) => {
        s.position.liquidity = 1n;
      },
    ],
    [
      "ORIGINAL_POSITION_CHANGED",
      (s: ReturnSnapshot) => {
        s.position.owner = pool;
      },
    ],
    [
      "ORIGINAL_POSITION_CHANGED",
      (s: ReturnSnapshot) => {
        s.position.tokenId++;
      },
    ],
    [
      "ORIGINAL_POSITION_CHANGED",
      (s: ReturnSnapshot) => {
        s.position.tickLower -= 10;
      },
    ],
    [
      "WRONG_CHAIN",
      (s: ReturnSnapshot) => {
        s.position.chainId = 8453;
      },
    ],
    [
      "UNSUPPORTED_PAIR",
      (s: ReturnSnapshot) => {
        s.position.token1.address = config.circleUsdc;
      },
    ],
    [
      "MIXED_BLOCKS",
      (s: ReturnSnapshot) => {
        s.market.block = { ...s.market.block, hash: blockHash(99) };
      },
    ],
    [
      "WITHDRAWAL_UNAVAILABLE",
      (s: ReturnSnapshot) => {
        s.market.paused = true;
      },
    ],
    [
      "PRINCIPAL_UNAVAILABLE",
      (s: ReturnSnapshot) => {
        s.aTokenBalance = s.lot.principal - 1n;
      },
    ],
    [
      "INSUFFICIENT_RESERVE_LIQUIDITY",
      (s: ReturnSnapshot) => {
        s.market.availableLiquidity = 1n;
      },
    ],
    [
      "ACCOUNT_HAS_DEBT",
      (s: ReturnSnapshot) => {
        s.totalDebtBase = 1n;
      },
    ],
    [
      "RETURN_COOLDOWN",
      (s: ReturnSnapshot) => {
        s.lot.parkedAt = 9999;
      },
    ],
  ] as const)("holds for %s", (reason, mutate) => {
    const { snapshot: s, observation: o } = streak();
    mutate(s);
    expect(decision(s, o).action).toBe("HOLD");
    expect(decision(s, o).reasons).toContain(reason);
  });
  it("allows withdrawal from a frozen reserve and ignores the supply cap", () => {
    const { snapshot: s, observation: o } = streak();
    s.market.frozen = true;
    expect(decision(s, o).action).toBe("RETURN");
  });
  it("holds on stale and future snapshots", () => {
    const { snapshot: s, observation: o } = streak();
    expect(decision(s, o, quote(s), 10361).reasons).toContain("STALE_DATA");
    expect(decision(s, o, quote(s), 10360).reasons).toContain("STALE_DATA");
    expect(decision(s, o, quote(s), 10299).reasons).toContain("STALE_DATA");
  });
  it("does not invent missing economics or accept zero expected advantage", () => {
    const { snapshot: s, observation: o } = streak();
    expect(decision(s, o, null).reasons).toContain("RETURN_ECONOMICS_MISSING");
    expect(decision(s, o, { ...quote(s), expectedLpFees: 0n }).reasons).toContain(
      "RETURN_NOT_ECONOMIC",
    );
  });
  it.each([
    { chainId: 8453 },
    { cycleId: blockHash(123) },
    { asset: config.circleUsdc },
    { horizonSeconds: 86400 },
    { quotedAt: 10301 },
    { expiresAt: 10300 },
    { expiresAt: 10421 },
    { executionCost: -1n },
    { source: " " },
  ])("refuses a mismatched or stale cost quote: %s", (patch) => {
    const { snapshot: s, observation: o } = streak();
    expect(decision(s, o, { ...quote(s), ...patch }).reasons).toContain(
      "RETURN_ECONOMICS_INVALID_OR_STALE",
    );
  });
  it("hashes every input and caps decision lifetime at quote expiry", () => {
    const { snapshot: s, observation: o } = streak();
    const e = { ...quote(s), expiresAt: 10310 };
    const result = decision(s, o, e);
    expect(result.expiresAt).toBe(10310);
    expect(decision(s, o, { ...e, executionCost: e.executionCost + 1n }).decisionHash).not.toBe(
      result.decisionHash,
    );
  });
});

describe("durable RETURN observations", () => {
  it("survives reopening and rejects a racing writer's unchecked previous sample", () => {
    const folder = mkdtempSync(join(tmpdir(), "rangepark-return-"));
    let db = new ReturnObservationStore(join(folder, "history.sqlite"));
    try {
      const first = returnFixture();
      const recorded = db.record(first, policy, 10000, null, true);
      db.close();
      db = new ReturnObservationStore(join(folder, "history.sqlite"));
      expect(db.get(first.lot.cycleId)).toEqual(recorded);
      const next = returnFixture(10060);
      expect(() => db.record(next, policy, 10060, null, true)).toThrow("concurrently");
      const second = db.record(next, policy, 10060, recorded, true);
      expect(second.since).toBe(10000);
      expect(db.record(returnFixture(10120), policy, 10120, second, false).since).toBe(10120);
    } finally {
      db.close();
      const target = realpathSync(folder);
      const child = relative(realpathSync(tmpdir()), target);
      if (!isAbsolute(child) && !child.startsWith("..") && child.startsWith("rangepark-return-"))
        rmSync(target, { recursive: true, force: true });
      else throw new Error("Unexpected test cleanup path");
    }
  });
});

describe("guarded RETURN withdrawal preflight", () => {
  function input() {
    const { snapshot, observation } = streak();
    return { ...snapshot, observation, policy, economics: quote(snapshot), now: 10300 };
  }
  function response(patch = {}) {
    return new Response(
      JSON.stringify({
        success: true,
        status: "simulated",
        wouldRevert: false,
        from: owner,
        to: config.aavePool,
        value: "0",
        gasEstimate: "123456",
        simulatedReturnValue: (10n ** 15n).toString(),
        ...patch,
      }),
      { status: 200 },
    );
  }
  it("freezes the exact original allocation, owner, chain and decision", () => {
    const i = input(),
      draft = buildReturnWithdrawDraft(i);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: draft.calldata }).args).toEqual([
      config.weth,
      i.lot.principal,
      owner,
    ]);
    expect(draft).toMatchObject({
      chainId: 84532,
      tokenId: 82083n,
      mode: "REVIEW_ONLY",
      expiresAt: 10360,
    });
    expect(draft.decisionHash).toBe(decideReturn(i).decisionHash);
    expect(draft.request.contractAddress).toBe(config.aavePool);
  });
  it("contacts KeeperHub only with simulate=true after the complete policy passes", async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const result = await preflightReturnWithdrawal(input(), "test-key", fetcher, () => 10300);
    const request = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(request).toMatchObject({
      chainId: 84532,
      simulate: true,
      value: "0",
      functionName: "withdraw",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "SIMULATION_ONLY",
      broadcastEnabled: false,
      transactions: [],
    });
  });
  it.each(["mainnet", "restored", "missing-cost", "expired"])(
    "makes no API request for %s",
    async (scenario) => {
      const i = input(),
        fetcher = vi.fn();
      if (scenario === "mainnet") i.position.chainId = 8453;
      if (scenario === "restored") i.lot.status = "RESTORED";
      if (scenario === "missing-cost") i.economics.source = "";
      await expect(
        preflightReturnWithdrawal(i, "test-key", fetcher, () =>
          scenario === "expired" ? 10500 : 10300,
        ),
      ).rejects.toThrow("blocked");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    { from: pool },
    { to: config.weth },
    { wouldRevert: true },
    { simulatedReturnValue: "1" },
    { status: "completed" },
  ])("rejects a simulation with mismatched proof %s", async (patch) => {
    await expect(
      preflightReturnWithdrawal(
        input(),
        "test-key",
        vi.fn().mockResolvedValue(response(patch)),
        () => 10300,
      ),
    ).rejects.toThrow();
  });
  it("discards a successful simulation that consumed the remaining decision lifetime", async () => {
    const clock = vi.fn().mockReturnValueOnce(10300).mockReturnValueOnce(10360);
    await expect(
      preflightReturnWithdrawal(input(), "test-key", vi.fn().mockResolvedValue(response()), clock),
    ).rejects.toThrow("expired");
  });
});
