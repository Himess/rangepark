import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { TickMath } from "@uniswap/v3-sdk";
import { demoInput } from "../src/demo/fixture.js";
import {
  buildReentryPlan,
  buildWithdrawPlan,
  ratioSwap,
} from "../src/keeperhub/return.js";
import { verifyPlan } from "../src/keeperhub/plan.js";
import { positionManagerAbi, routerAbi } from "../src/chain/abis.js";
import { BASE } from "../src/config/base.js";
import type { ChainReader } from "../src/chain/client.js";
import { Journal } from "../src/state/journal.js";

function fixture() {
  const p = demoInput().position;
  p.currentTick = -200010;
  p.twapTick = -200011;
  p.sqrtPriceX96 = BigInt(
    TickMath.getSqrtRatioAtTick(p.currentTick).toString(),
  );
  p.liquidity = 0n;
  return p;
}
function mock() {
  return {
    simulateContract: vi
      .fn()
      .mockResolvedValue({ result: [1000000000n, 0n, 0, 100000n] }),
  } as unknown as ChainReader;
}
describe("same-NFT return", () => {
  it("chooses the excess asset and never spends more than the attributed balance", () => {
    const p = fixture(),
      weth = ratioSwap(p, 10n ** 18n, 0n),
      usdc = ratioSwap(p, 0n, 3000n * 10n ** 6n);
    expect(weth.tokenIn).toBe(BASE.weth);
    expect(weth.amountIn).toBeGreaterThan(0n);
    expect(weth.amountIn).toBeLessThan(10n ** 18n);
    expect(usdc.tokenIn).toBe(BASE.usdc);
    expect(usdc.amountIn).toBeGreaterThan(0n);
    expect(usdc.amountIn).toBeLessThan(3000n * 10n ** 6n);
  });
  it("does not quote an occupied NFT or unconfirmed price", async () => {
    const p = fixture(),
      client = mock();
    await expect(
      buildReentryPlan(client, { ...p, liquidity: 1n }, 1n, 0n),
    ).rejects.toThrow("empty NFT");
    await expect(
      buildReentryPlan(client, { ...p, twapTick: null }, 1n, 0n),
    ).rejects.toThrow("confirmation");
    await expect(
      buildReentryPlan(client, { ...p, currentTick: p.tickUpper }, 1n, 0n),
    ).rejects.toThrow("not active");
    expect(client.simulateContract).not.toHaveBeenCalled();
  });
  it("freezes swap expiry and nonzero output minimum, then increases the original NFT", async () => {
    const p = fixture(),
      client = mock(),
      plan = await buildReentryPlan(client, p, 10n ** 18n, 0n);
    verifyPlan(plan, p.block.timestamp);
    const wrapped = decodeFunctionData({
      abi: routerAbi,
      data: plan.steps.find((s) => s.id === "swap")!.calldata,
    });
    expect(wrapped.functionName).toBe("multicall");
    if (wrapped.functionName !== "multicall")
      throw new Error("Expected deadline wrapper");
    expect(wrapped.args[0]).toBe(BigInt(plan.expiresAt));
    const swap = decodeFunctionData({
      abi: routerAbi,
      data: wrapped.args[1][0]!,
    });
    if (swap.functionName !== "exactInputSingle")
      throw new Error("Expected direct swap");
    expect(swap.args[0].amountOutMinimum).toBe(997000000n);
    expect(swap.args[0].recipient).toBe(p.owner);
    const increase = decodeFunctionData({
      abi: positionManagerAbi,
      data: plan.steps.at(-1)!.calldata,
    });
    if (increase.functionName !== "increaseLiquidity")
      throw new Error("Expected original NFT increase");
    expect(increase.args[0].tokenId).toBe(p.tokenId);
    expect(increase.args[0].amount0Min).toBeGreaterThan(0n);
    expect(increase.args[0].amount1Min).toBeGreaterThan(0n);
    expect(() => verifyPlan(plan, plan.expiresAt)).toThrow("expired");
    expect(() =>
      verifyPlan(
        { ...plan, balances: { balance0: 1n, balance1: 0n } },
        p.block.timestamp,
      ),
    ).toThrow("hash");
  });
  it("journals withdrawal and reentry as separate approvals", async () => {
    const p = fixture(),
      withdraw = buildWithdrawPlan(p, BASE.weth, 10n ** 18n),
      reentry = await buildReentryPlan(mock(), p, 10n ** 18n, 0n),
      db = new Journal(":memory:");
    db.create(withdraw, p.block.timestamp);
    db.approve(withdraw, "test-owner", p.block.timestamp);
    expect(() => db.create(reentry, p.block.timestamp)).toThrow();
    db.beginStep(withdraw, "withdraw", p.block.timestamp, {});
    const tx = `0x${"ab".repeat(32)}`;
    db.recordHash(withdraw.planHash, "withdraw", tx);
    db.confirm(withdraw.planHash, "withdraw", tx, { verified: true }, true);
    db.create(reentry, p.block.timestamp);
    expect(() =>
      db.beginStep(reentry, "approve-swap", p.block.timestamp, {}),
    ).toThrow("approval");
    db.close();
  });
});
