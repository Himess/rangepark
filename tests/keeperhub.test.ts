import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { aavePoolAbi, positionManagerAbi } from "../src/chain/abis.js";
import { BASE } from "../src/config/base.js";
import { demoInput } from "../src/demo/fixture.js";
import { buildParkPlan, verifyPlan } from "../src/keeperhub/plan.js";
import { KeeperHubClient, KeeperHubError } from "../src/keeperhub/client.js";

describe("frozen plan", () => {
  it("atomically decreases and collects to the owner, then supplies the exact approved minimum", () => {
    const input = demoInput();
    const plan = buildParkPlan(input, input.position.owner);
    const [release, approve, supply] = plan.steps;
    const outer = decodeFunctionData({
      abi: positionManagerAbi,
      data: release!.calldata,
    });
    expect(outer.functionName).toBe("multicall");
    if (outer.functionName !== "multicall")
      throw new Error("Expected multicall");
    const [decreaseData, collectData] = outer.args[0];
    const decrease = decodeFunctionData({
      abi: positionManagerAbi,
      data: decreaseData!,
    });
    expect(decrease.functionName).toBe("decreaseLiquidity");
    if (decrease.functionName !== "decreaseLiquidity")
      throw new Error("Expected decrease");
    expect(decrease.args[0]).toMatchObject({
      tokenId: input.position.tokenId,
      amount0Min: 0n,
      amount1Min: 9970000000n,
      deadline: BigInt(plan.expiresAt),
    });
    const collect = decodeFunctionData({
      abi: positionManagerAbi,
      data: collectData!,
    });
    if (collect.functionName !== "collect") throw new Error("Expected collect");
    expect(collect.args[0].recipient.toLowerCase()).toBe(
      input.position.owner.toLowerCase(),
    );
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: approve!.calldata,
    });
    expect(approval.args).toEqual([BASE.aavePool, 9970000000n]);
    const deposit = decodeFunctionData({
      abi: aavePoolAbi,
      data: supply!.calldata,
    });
    expect(deposit.args).toEqual([
      BASE.usdc,
      9970000000n,
      input.position.owner,
      0,
    ]);
    expect(supply!.dependsOn).toEqual(["approve"]);
    expect(() => verifyPlan(plan, input.now)).not.toThrow();
  });
  it("rejects a different execution wallet", () => {
    expect(() => buildParkPlan(demoInput(), BASE.factory)).toThrow("must own");
  });
  it("refuses to build a plan for HOLD", () => {
    const input = demoInput();
    input.market.paused = true;
    expect(() => buildParkPlan(input, input.position.owner)).toThrow(
      "PARK refused",
    );
  });
  it("rejects mutation and the exact expiry boundary", () => {
    const input = demoInput();
    const plan = buildParkPlan(input, input.position.owner);
    expect(() => verifyPlan({ ...plan, supplyAmount: "1" }, input.now)).toThrow(
      "hash mismatch",
    );
    expect(() => verifyPlan(plan, plan.expiresAt)).toThrow("expired");
    expect(() => verifyPlan(plan, plan.createdAt - 1)).toThrow();
  });
});

describe("KeeperHub single-call preflight transport", () => {
  function setup(body: unknown, status = 200) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
    return {
      client: new KeeperHubClient("kh_test_not_a_real_key", fetcher),
      fetcher,
    };
  }
  const input = demoInput();
  const step = buildParkPlan(input, input.position.owner).steps[0]!;
  const ok = {
    success: true,
    status: "simulated",
    wouldRevert: false,
    from: input.position.owner,
    to: BASE.positionManager,
    value: "0",
    gasEstimate: "150000",
  };
  it("always sets the boolean simulate and the real REST ABI argument names", async () => {
    const { client, fetcher } = setup(ok);
    await client.simulate(step, input.position.owner);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://app.keeperhub.com/api/execute/contract-call");
    const request = JSON.parse(options!.body as string);
    expect(request.simulate).toBe(true);
    expect(request.chainId).toBe(8453);
    expect(request.functionName).toBe("multicall");
    expect(typeof request.functionArgs).toBe("string");
    expect(typeof request.abi).toBe("string");
  });
  it("keeps revert details and never retries or falls through to broadcast", async () => {
    const failure = {
      success: false,
      failureKind: "revert",
      wouldRevert: true,
      error: "Not approved",
    };
    const { client, fetcher } = setup(failure, 400);
    await expect(
      client.simulate(step, input.position.owner),
    ).rejects.toMatchObject({ status: 400, details: failure });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a simulation from the wrong organization wallet", async () => {
    const { client } = setup({ ...ok, from: BASE.factory });
    await expect(client.simulate(step, input.position.owner)).rejects.toThrow(
      "mismatch",
    );
  });
  it("does not treat unavailable simulation as success", async () => {
    const { client } = setup(
      { success: false, wouldRevert: false, failureKind: "unavailable" },
      503,
    );
    await expect(
      client.simulate(step, input.position.owner),
    ).rejects.toBeInstanceOf(KeeperHubError);
  });
  it("rejects a live execution response instead of labelling it simulated", async () => {
    const { client } = setup({
      status: "completed",
      executionId: "direct_123",
    });
    await expect(client.simulate(step, input.position.owner)).rejects.toThrow();
  });
});
