import { describe, expect, it, vi } from "vitest";
import { TickMath } from "@uniswap/v3-sdk";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  type Hex,
} from "viem";
import { ReturnRunStore, decodeRun } from "../src/state/return-runs.js";
import { hash } from "../src/core/serialization.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import {
  buildReturnIncreaseStage,
  buildReturnSwapStage,
  verifyStage,
  type StageDraft,
  type ReturnStepId,
} from "../src/testnet/return-stages.js";
import { submitReturnStep, validateReturnCall } from "../src/testnet/return-executor.js";
import {
  verifyReturnDelta,
  type ReturnBaseline,
  type ReturnWalletState,
} from "../src/testnet/return-receipts.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
import { positionManagerAbi, routerAbi } from "../src/chain/abis.js";
import { eligibleReturnInput, returnFixture } from "./fixtures/return.js";

const txHash = `0x${"ab".repeat(32)}` as Hex;
function client() {
  const input = eligibleReturnInput();
  return {
    getChainId: vi.fn().mockResolvedValue(84532),
    getBlock: vi.fn().mockResolvedValue(input.position.block),
    simulateContract: vi
      .fn()
      .mockResolvedValue({
        result: [1500000n, BigInt(TickMath.getSqrtRatioAtTick(-196201).toString()), 0, 100000n],
      }),
  } as unknown as TestnetReturnClient;
}
function wallet(): ReturnWalletState {
  return {
    snapshot: returnFixture(),
    wallet0: 987654321n,
    wallet1: 77777n,
    nftCount: 1n,
    swapAllowance: 0n,
    lp0Allowance: 0n,
    lp1Allowance: 0n,
  };
}
async function phases() {
  const input = eligibleReturnInput(),
    db = new ReturnRunStore(":memory:");
  const withdrawal = db.create(input);
  const capital = { amount0: input.lot.principal, amount1: 0n };
  const swap = await buildReturnSwapStage(client(), input, capital, input.policy, 10000);
  const afterSwap = { amount0: capital.amount0 - swap.amounts.input, amount1: 1500000n };
  const increase = buildReturnIncreaseStage(input, afterSwap, input.policy, 10000);
  return { input, db, withdrawal, swap, increase, afterSwap };
}
const eventAbi = parseAbi([
  "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
function withdrawLog(amount: bigint) {
  const owner = eligibleReturnInput().lot.owner;
  return {
    address: config.aavePool,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "Withdraw",
      args: { reserve: config.weth, user: owner, to: owner },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}
function swapLog(input: bigint, output: bigint) {
  const lot = eligibleReturnInput().lot;
  return {
    address: lot.pool,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "Swap",
      args: { sender: config.swapRouter, recipient: lot.owner },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: "int256" },
        { type: "int256" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
      ],
      [input, -output, BigInt(TickMath.getSqrtRatioAtTick(-196201).toString()), 123n, -196201],
    ),
  };
}
function increaseLog(tokenId: bigint, amount0: bigint, amount1: bigint) {
  return {
    address: config.positionManager,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "IncreaseLiquidity",
      args: { tokenId },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
      [555n, amount0, amount1],
    ),
  };
}
describe("staged same-NFT testnet RETURN", () => {
  it("quotes only after withdrawal and freezes price limit, output minimum and original recipient", async () => {
    const { input, db, swap } = await phases();
    try {
      const wrapped = decodeFunctionData({ abi: routerAbi, data: swap.calls[1]!.calldata });
      if (wrapped.functionName !== "multicall") throw Error("deadline wrapper required");
      expect(wrapped.args[0]).toBe(10060n);
      const call = decodeFunctionData({ abi: routerAbi, data: wrapped.args[1][0]! });
      if (call.functionName !== "exactInputSingle") throw Error("direct swap required");
      expect(call.args[0]).toMatchObject({
        tokenIn: config.weth,
        tokenOut: config.aaveUsdc,
        recipient: input.lot.owner,
        fee: 500,
        amountOutMinimum: 1495500n,
      });
      expect(call.args[0].sqrtPriceLimitX96).toBeGreaterThan(0n);
      expect(call.args[0].amountIn).toBeGreaterThan(0n);
      expect(call.args[0].amountIn).toBeLessThan(input.lot.principal);
      swap.calls.forEach((c) => validateReturnCall(input, swap, c));
    } finally {
      db.close();
    }
  });
  it("rejects a foreign chain, contaminated wallet totals, stale data and quotes crossing the inner boundary", async () => {
    const i = eligibleReturnInput(),
      c = client(),
      cap = { amount0: i.lot.principal, amount1: 0n };
    vi.mocked(c.getChainId).mockResolvedValueOnce(8453);
    await expect(buildReturnSwapStage(c, i, cap, i.policy, 10000)).rejects.toThrow("chain");
    await expect(
      buildReturnSwapStage(c, i, { ...cap, amount0: cap.amount0 + 1n }, i.policy, 10000),
    ).rejects.toThrow("principal");
    await expect(buildReturnSwapStage(c, i, cap, i.policy, 10060)).rejects.toThrow("STALE");
    vi.mocked(c.simulateContract).mockResolvedValueOnce({
      result: [1500000n, BigInt(TickMath.getSqrtRatioAtTick(-196221).toString()), 0, 1n],
    } as never);
    await expect(buildReturnSwapStage(c, i, cap, i.policy, 10000)).rejects.toThrow("price limit");
  });
  it("refuses a reorged quote", async () => {
    const i = eligibleReturnInput(),
      c = client();
    vi.mocked(c.getBlock).mockResolvedValueOnce({ ...i.position.block, hash: txHash } as never);
    await expect(
      buildReturnSwapStage(c, i, { amount0: i.lot.principal, amount1: 0n }, i.policy, 10000),
    ).rejects.toThrow("block changed");
  });
  it("creates the LP increase from confirmed output and preserves both nonzero minima", async () => {
    const { input, db, increase, afterSwap } = await phases();
    try {
      const call = decodeFunctionData({
        abi: positionManagerAbi,
        data: increase.calls[2]!.calldata,
      });
      if (call.functionName !== "increaseLiquidity") throw Error("wrong call");
      expect(call.args[0]).toMatchObject({
        tokenId: 82083n,
        amount0Desired: afterSwap.amount0,
        amount1Desired: afterSwap.amount1,
        deadline: 10060n,
      });
      expect(call.args[0].amount0Min).toBeGreaterThan(0n);
      expect(call.args[0].amount1Min).toBeGreaterThan(0n);
      increase.calls.forEach((c) => validateReturnCall(input, increase, c));
      expect(() =>
        buildReturnIncreaseStage(input, { amount0: 1n, amount1: 0n }, input.policy, 10000),
      ).toThrow("Two confirmed");
    } finally {
      db.close();
    }
  });
  it("detects changed hashes and rejects an attacker-selected target even with a recomputed hash", async () => {
    const { input, db, swap } = await phases();
    try {
      const bad = structuredClone(swap);
      bad.calls[0]!.request.contractAddress = input.lot.owner;
      expect(() => verifyStage(bad, 10000)).toThrow("hash");
      const { planHash: _, ...body } = bad;
      bad.planHash = hash(body);
      expect(() => validateReturnCall(input, bad, bad.calls[0]!)).toThrow("allowlisted");
      expect(() => verifyStage(swap, 10060)).toThrow("expired");
    } finally {
      db.close();
    }
  });
  it("keeps unrelated balances out of attribution and matches withdrawal/increase event amounts", async () => {
    const { input, db, withdrawal, swap, increase, afterSwap } = await phases();
    try {
      const before = wallet(),
        after = structuredClone(before);
      after.wallet0 += input.lot.principal;
      after.snapshot.aTokenBalance = 100n;
      const w = verifyReturnDelta(
        "withdraw",
        { state: before, capital: { amount0: 0n, amount1: 0n }, plan: withdrawal },
        after,
        [withdrawLog(input.lot.principal)],
      );
      expect(w).toEqual({ amount0: input.lot.principal, amount1: 0n });
      const swapped = structuredClone(after);
      swapped.wallet0 -= swap.amounts.input;
      swapped.wallet1 += 1500000n;
      expect(
        verifyReturnDelta("swap", { state: after, capital: w, plan: swap }, swapped, [
          swapLog(swap.amounts.input, 1500000n),
        ]),
      ).toEqual(afterSwap);
      const increased = structuredClone(swapped);
      increased.wallet0 -= increase.amounts.minimum0;
      increased.wallet1 -= increase.amounts.minimum1;
      increased.snapshot.position.liquidity = 555n;
      const residual = verifyReturnDelta(
        "increase",
        { state: swapped, capital: afterSwap, plan: increase },
        increased,
        [increaseLog(82083n, increase.amounts.minimum0, increase.amounts.minimum1)],
      );
      expect(residual.amount0).toBe(afterSwap.amount0 - increase.amounts.minimum0);
      expect(residual.amount1).toBe(afterSwap.amount1 - increase.amounts.minimum1);
      expect(() =>
        verifyReturnDelta(
          "increase",
          { state: swapped, capital: afterSwap, plan: increase },
          increased,
          [increaseLog(82084n, increase.amounts.minimum0, increase.amounts.minimum1)],
        ),
      ).toThrow("mismatch");
    } finally {
      db.close();
    }
  });
  it("does not attribute unrelated USDC transfers in the swap block to swap proceeds", async () => {
    const { db, swap } = await phases();
    try {
      const before = wallet();
      before.wallet0 += swap.capital.amount0;
      const after = structuredClone(before);
      after.wallet0 -= swap.amounts.input;
      after.wallet1 += 1500001n;
      expect(() =>
        verifyReturnDelta("swap", { state: before, capital: swap.capital, plan: swap }, after, [
          swapLog(swap.amounts.input, 1500000n),
        ]),
      ).toThrow("Swap");
    } finally {
      db.close();
    }
  });
});

describe("RETURN journal and execution boundaries", () => {
  function setup() {
    const input = eligibleReturnInput(),
      db = new ReturnRunStore(":memory:");
    db.create(input);
    return { input, db };
  }
  function simulation(input = eligibleReturnInput(), patch = {}) {
    return new Response(
      JSON.stringify({
        success: true,
        status: "simulated",
        wouldRevert: false,
        from: input.lot.owner,
        to: config.aavePool,
        value: "0",
        gasEstimate: "100000",
        simulatedReturnValue: input.lot.principal.toString(),
        ...patch,
      }),
    );
  }
  it("records an intent before broadcasting and refuses a second call after timeout", async () => {
    const { input, db } = setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(simulation())
      .mockImplementationOnce(() => {
        expect(db.steps(input.lot.cycleId)[0]!.status).toBe("SUBMITTING");
        throw Error("timeout");
      });
    const args = {
      store: db,
      cycleId: input.lot.cycleId,
      id: "withdraw" as const,
      client: client(),
      apiKey: "test",
      fetcher,
      clock: () => 10000,
      readState: vi.fn().mockResolvedValue(wallet()),
    };
    try {
      await expect(submitReturnStep(args)).rejects.toThrow("timeout");
      await expect(submitReturnStep(args)).rejects.toThrow("already started");
      expect(fetcher).toHaveBeenCalledTimes(2);
      const body = JSON.parse(fetcher.mock.calls[1]![1].body);
      expect(body.simulate).toBeUndefined();
      expect(fetcher.mock.calls[1]![1].headers["Idempotency-Key"]).toBe(
        db.intent(input.lot.cycleId, "withdraw"),
      );
    } finally {
      db.close();
    }
  });
  it.each(["price", "expiry", "sender", "pause"])(
    "does not broadcast when %s changes during simulation",
    async (reason) => {
      const { input, db } = setup();
      let now = 10000;
      const changed = wallet();
      if (reason === "price") changed.snapshot.position.currentTick = -196257;
      const fetcher = vi.fn().mockImplementationOnce(() => {
        if (reason === "expiry") now = 10060;
        if (reason === "pause") db.pause(input.lot.cycleId);
        return simulation(input, reason === "sender" ? { from: config.weth } : {});
      });
      const readState = vi.fn().mockResolvedValueOnce(wallet()).mockResolvedValueOnce(changed);
      try {
        await expect(
          submitReturnStep({
            store: db,
            cycleId: input.lot.cycleId,
            id: "withdraw",
            client: client(),
            apiKey: "test",
            fetcher,
            clock: () => now,
            readState,
          }),
        ).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(db.steps(input.lot.cycleId)[0]!.status).toBe("READY");
      } finally {
        db.close();
      }
    },
  );
  it("requires the previous receipt before a dependent phase and preserves pause during reconciliation", async () => {
    const { input, db, swap, withdrawal } = await phases();
    try {
      expect(() => db.savePhase(swap, 10000)).toThrow("active run");
      const call = withdrawal.calls[0]!;
      db.claim(input.lot.cycleId, withdrawal, call, { state: wallet() }, 10000);
      db.response(input.lot.cycleId, "withdraw", {
        httpStatus: 200,
        body: { executionId: "demo", status: "completed" },
      });
      db.pause(input.lot.cycleId);
      db.confirm(
        input.lot.cycleId,
        "withdraw",
        { synthetic: true },
        { amount0: input.lot.principal, amount1: 0n },
      );
      expect(db.get(input.lot.cycleId)?.status).toBe("PAUSED");
      expect(() => db.savePhase(swap, 10000)).toThrow("active run");
      expect(() => db.create(input)).toThrow();
    } finally {
      db.close();
    }
  });
  it("runs all six ordered steps with separate phase hashes and retains exact residual accounting", async () => {
    const { input, db, withdrawal, swap, increase, afterSwap } = await phases();
    try {
      let capital = { amount0: 0n, amount1: 0n };
      for (const plan of [withdrawal, swap, increase]) {
        if (plan.phase !== "WITHDRAW") db.savePhase(plan, 10000);
        for (const call of plan.calls) {
          db.claim(
            input.lot.cycleId,
            plan,
            call,
            { state: wallet(), capital, plan } satisfies ReturnBaseline,
            10000,
          );
          db.response(input.lot.cycleId, call.id, {
            httpStatus: 200,
            body: { executionId: call.id, status: "completed" },
          });
          if (call.id === "withdraw") capital = { amount0: input.lot.principal, amount1: 0n };
          if (call.id === "swap") capital = afterSwap;
          if (call.id === "increase") capital = { amount0: 1n, amount1: 2n };
          db.confirm(input.lot.cycleId, call.id, { synthetic: true }, capital);
        }
      }
      expect(db.get(input.lot.cycleId)).toMatchObject({
        status: "COMPLETE",
        capital: { amount0: 1n, amount1: 2n },
      });
      expect(db.steps(input.lot.cycleId).every((s) => s.status === "CONFIRMED")).toBe(true);
      expect(new Set(db.steps(input.lot.cycleId).map((s) => s.plan_hash)).size).toBe(3);
      const initial = decodeRun<ReturnBaseline>(db.steps(input.lot.cycleId)[0]!.baseline!);
      expect(initial.state.snapshot.position.tokenId).toBe(82083n);
    } finally {
      db.close();
    }
  });
});
