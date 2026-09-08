import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
} from "viem";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import { TEST_DEPOSIT_WEI as amount } from "../src/testnet/preflight.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import {
  buildPositionApproval,
  buildTestnetMint,
  buildTestnetRelease,
  buildAaveApproval,
  buildTestnetSupply,
  validateParkStep,
} from "../src/testnet/park-plan.js";
import {
  parkIntent,
  submitParkStep,
  verifyParkTransaction,
} from "../src/testnet/park-executor.js";
import { positionManagerAbi } from "../src/chain/abis.js";
import { gasStationAbi, TESTNET_GAS_STATION } from "../src/testnet/receipt.js";
const owner = "0x1111111111111111111111111111111111111111" as const;
const stranger = "0x2222222222222222222222222222222222222222" as const;
describe("testnet park constraints", () => {
  it("mints only original principal into an out-of-range, tick-aligned Aave-USDC pair", () => {
    const { step, params } = buildTestnetMint(owner, -196257, 1000);
    expect(params.tickLower).toBeGreaterThan(-196257);
    expect(Math.abs(params.tickLower % 10)).toBe(0);
    expect(params.tickUpper - params.tickLower).toBe(60);
    expect(params.amount0Desired).toBe(amount);
    expect(params.amount1Desired).toBe(0n);
    expect(params.token1).toBe(config.aaveUsdc);
    expect(params.deadline).toBe(1120n);
    expect(() => validateParkStep(step, owner)).not.toThrow();
    expect(() => validateParkStep(step, stranger)).toThrow();
  });
  it("atomically releases and collects the same NFT back to its owner", () => {
    const step = buildTestnetRelease(owner, 123n, 555n, amount - 1n, 1000);
    validateParkStep(step, owner);
    const outer = decodeFunctionData({
      abi: positionManagerAbi,
      data: step.calldata,
    });
    expect(outer.functionName).toBe("multicall");
    if (outer.functionName !== "multicall") throw new Error("Wrong call");
    expect(outer.args[0]).toHaveLength(2);
    const one = decodeFunctionData({
      abi: positionManagerAbi,
      data: outer.args[0][0]!,
    });
    const two = decodeFunctionData({
      abi: positionManagerAbi,
      data: outer.args[0][1]!,
    });
    expect(one.functionName).toBe("decreaseLiquidity");
    expect(two.functionName).toBe("collect");
    expect(() => validateParkStep(step, stranger)).toThrow();
  });
  it.each([0n, -1n, amount + 1n])(
    "rejects amount %s outside the original budget",
    (bad) => {
      expect(() => buildAaveApproval(bad)).toThrow();
      expect(() => buildTestnetSupply(owner, bad)).toThrow();
      expect(() => buildTestnetRelease(owner, 1n, 1n, bad, 1)).toThrow();
    },
  );
  it("refuses a transfer disguised as an approval", () => {
    const step = buildPositionApproval();
    step.calldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [stranger, amount],
    });
    expect(() => validateParkStep(step, owner)).toThrow("Approval");
  });
  it("refuses approval to an unapproved spender", () => {
    const step = buildPositionApproval();
    step.calldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [stranger, amount],
    });
    expect(() => validateParkStep(step, owner)).toThrow("spender");
  });
  it("checks exact sponsored inner calldata", () => {
    const step = buildPositionApproval();
    const data = `0x${"00".repeat(85)}${step.calldata.slice(2)}` as Hex;
    const tx = {
      chainId: 84532,
      from: stranger,
      to: TESTNET_GAS_STATION,
      value: 0n,
      input: encodeFunctionData({
        abi: gasStationAbi,
        functionName: "execute",
        args: [owner, config.weth, 0n, data],
      }),
    };
    expect(() => verifyParkTransaction(tx, owner, step, true)).not.toThrow();
    expect(() => verifyParkTransaction(tx, stranger, step, true)).toThrow();
    expect(() =>
      verifyParkTransaction({ ...tx, chainId: 8453 }, owner, step, true),
    ).toThrow();
  });
  it("simulates a frozen body, persists before broadcast and will never resend", async () => {
    const store = new TestnetDepositStore(":memory:");
    const step = buildPositionApproval();
    let simulatedBody: unknown;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_, options) => {
        const body = JSON.parse(options!.body as string);
        if (body.simulate === true) {
          const { simulate: _, ...rest } = body;
          simulatedBody = rest;
          return new Response(
            JSON.stringify({
              success: true,
              status: "simulated",
              wouldRevert: false,
              from: owner,
              to: config.weth,
              value: "0",
              gasEstimate: "26000",
            }),
          );
        }
        expect(body).toEqual(simulatedBody);
        expect(store.get(parkIntent(owner, step.id))?.status).toBe(
          "SUBMITTING",
        );
        return new Response(
          JSON.stringify({ executionId: "test_123", status: "completed" }),
        );
      });
    const args = {
      step,
      owner,
      chainId: 84532,
      apiKey: "test-key",
      baseline: "{}",
      store,
    };
    try {
      await submitParkStep(args, fetcher);
      await expect(submitParkStep(args, fetcher)).rejects.toThrow(
        "already started",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
  it("cannot mint before approval is confirmed", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi.fn<typeof fetch>();
    try {
      await expect(
        submitParkStep(
          {
            step: buildTestnetMint(owner, -196257, 1000).step,
            owner,
            chainId: 84532,
            apiKey: "test-key",
            baseline: "{}",
            store,
          },
          fetcher,
        ),
      ).rejects.toThrow("Reconcile approve-position");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it("refuses request/calldata drift before even simulating", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi.fn<typeof fetch>();
    const step = buildPositionApproval();
    step.request.functionArgs = JSON.stringify([config.positionManager, "1"]);
    try {
      await expect(
        submitParkStep(
          {
            step,
            owner,
            chainId: 84532,
            apiKey: "test-key",
            baseline: "{}",
            store,
          },
          fetcher,
        ),
      ).rejects.toThrow("Calldata differs");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it("keeps an ambiguous submission blocked", async () => {
    const store = new TestnetDepositStore(":memory:");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: owner,
            to: config.weth,
            value: "0",
            gasEstimate: "26000",
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("timeout"));
    const args = {
      step: buildPositionApproval(),
      owner,
      chainId: 84532,
      apiKey: "test-key",
      baseline: "{}",
      store,
    };
    try {
      await expect(submitParkStep(args, fetcher)).rejects.toThrow("timeout");
      await expect(submitParkStep(args, fetcher)).rejects.toThrow(
        "already started",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
});
