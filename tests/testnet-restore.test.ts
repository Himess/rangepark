import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import {
  buildRestoreStep,
  type RestoreContext,
} from "../src/testnet/restore-plan.js";
import {
  restoreIntent,
  submitRestoreStep,
} from "../src/testnet/restore-executor.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { aavePoolAbi, positionManagerAbi } from "../src/chain/abis.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
const context: RestoreContext = {
  owner: "0x1111111111111111111111111111111111111111",
  tokenId: 82083n,
  principal: 999999999999984n,
  lower: -196230,
  upper: -196170,
  tick: -196257,
  now: Math.floor(Date.now() / 1000),
  manualRehearsal: true,
};
describe("bounded manual restoration", () => {
  it("withdraws only the supplied principal to the owner", () => {
    const step = buildRestoreStep("withdraw-principal", context);
    expect(step.request.chainId).toBe(84532);
    const call = decodeFunctionData({ abi: aavePoolAbi, data: step.calldata });
    expect(call.functionName).toBe("withdraw");
    expect(call.args).toEqual([config.weth, context.principal, context.owner]);
  });
  it("increases the original NFT with exact principal and nonzero minimum", () => {
    const step = buildRestoreStep("restore-original-nft", context);
    const call = decodeFunctionData({
      abi: positionManagerAbi,
      data: step.calldata,
    });
    expect(call.functionName).toBe("increaseLiquidity");
    if (call.functionName !== "increaseLiquidity")
      throw new Error("Wrong call");
    expect(call.args[0]).toMatchObject({
      tokenId: 82083n,
      amount0Desired: context.principal,
      amount1Desired: 0n,
      amount0Min: (context.principal * 997n) / 1000n,
      deadline: BigInt(context.now + 120),
    });
  });
  it("cannot be mistaken for an automatic range-triggered return", () => {
    expect(() =>
      buildRestoreStep("withdraw-principal", {
        ...context,
        manualRehearsal: false,
      }),
    ).toThrow("explicitly");
  });
  it.each([-196230, -196200, -196170])(
    "refuses one-sided restoration at tick %s",
    (tick) => {
      expect(() =>
        buildRestoreStep("withdraw-principal", { ...context, tick }),
      ).toThrow("price below");
    },
  );
  it.each([0n, -1n, 1000000000000001n])(
    "rejects principal %s outside budget",
    (principal) => {
      expect(() =>
        buildRestoreStep("withdraw-principal", { ...context, principal }),
      ).toThrow("allocation");
    },
  );
  it("requires confirmed withdrawal before approval", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi.fn<typeof fetch>();
    try {
      await expect(
        submitRestoreStep(
          {
            id: "approve-restore",
            context: { ...context, now: Math.floor(Date.now() / 1000) },
            chainId: 84532,
            apiKey: "test-key",
            store,
            baseline: "{}",
          },
          fetcher,
        ),
      ).rejects.toThrow("Reconcile withdraw-principal");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it("never resends an ambiguous withdrawal", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: context.owner,
            to: config.aavePool,
            value: "0",
            gasEstimate: "160000",
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("timeout"));
    const args = {
      id: "withdraw-principal" as const,
      context: { ...context, now: Math.floor(Date.now() / 1000) },
      chainId: 84532,
      apiKey: "test-key",
      store,
      baseline: "{}",
    };
    try {
      await expect(submitRestoreStep(args, fetcher)).rejects.toThrow("timeout");
      expect(store.get(restoreIntent(context.owner, args.id))?.status).toBe(
        "SUBMITTING",
      );
      await expect(submitRestoreStep(args, fetcher)).rejects.toThrow(
        "already started",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
  it("blocks mainnet without contacting KeeperHub", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi.fn<typeof fetch>();
    try {
      await expect(
        submitRestoreStep(
          {
            id: "withdraw-principal",
            context,
            chainId: 8453,
            apiKey: "test-key",
            store,
            baseline: "{}",
          },
          fetcher,
        ),
      ).rejects.toThrow("only accepts");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
