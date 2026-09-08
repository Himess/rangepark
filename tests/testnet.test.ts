import { describe, expect, it, vi } from "vitest";
import {
  simulateTestnetDeposit,
  TEST_DEPOSIT_WEI,
} from "../src/testnet/preflight.js";
import { BASE_SEPOLIA, requireTestnetChain } from "../src/testnet/config.js";
import { BASE } from "../src/config/base.js";
describe("testnet boundary", () => {
  it("rejects mainnet and every other chain before contract reads", () => {
    expect(() => requireTestnetChain(84532)).not.toThrow();
    for (const id of [8453, 1, 11155111, 0, NaN])
      expect(() => requireTestnetChain(id)).toThrow(
        "only accepts Base Sepolia",
      );
  });
  it("uses the Aave test reserve, not Circle USDC or the mainnet deployment", () => {
    expect(BASE_SEPOLIA.aaveUsdc.toLowerCase()).not.toBe(
      BASE_SEPOLIA.circleUsdc.toLowerCase(),
    );
    expect(BASE_SEPOLIA.aavePool).not.toBe(BASE.aavePool);
    expect(BASE_SEPOLIA.positionManager).not.toBe(BASE.positionManager);
  });
});

describe("authenticated testnet first-step preflight", () => {
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const result = {
    success: true,
    status: "simulated",
    wouldRevert: false,
    from: owner,
    to: BASE_SEPOLIA.weth,
    value: TEST_DEPOSIT_WEI.toString(),
    gasEstimate: "45246",
  };
  const transport = (body: unknown, status = 200) =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("sends only the fixed Base Sepolia deposit simulation", async () => {
    const fetcher = transport(result);
    const report = await simulateTestnetDeposit(
      "test-key",
      owner,
      84532,
      fetcher,
    );
    expect(report.transactions).toEqual([]);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://app.keeperhub.com/api/execute/contract-call");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(options!.body as string)).toMatchObject({
      chainId: 84532,
      simulate: true,
      value: "0.001",
      functionName: "deposit",
      functionArgs: "[]",
      contractAddress: BASE_SEPOLIA.weth,
    });
  });
  it("refuses a mainnet RPC before contacting KeeperHub", async () => {
    const fetcher = transport(result);
    await expect(
      simulateTestnetDeposit("test-key", owner, 8453, fetcher),
    ).rejects.toThrow("only accepts Base Sepolia");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { from: BASE_SEPOLIA.aavePool },
    { to: BASE_SEPOLIA.aavePool },
    { value: "1000000000000001" },
    { value: "0.001" },
  ])(
    "rejects substituted sender, target or atomic value: %j",
    async (change) => {
      await expect(
        simulateTestnetDeposit(
          "test-key",
          owner,
          84532,
          transport({ ...result, ...change }),
        ),
      ).rejects.toThrow("mismatch");
    },
  );
  it.each([
    { result: "0" },
    { ...result, status: "completed" },
    { ...result, wouldRevert: true },
  ])(
    "does not accept a read, broadcast or revert as simulation proof",
    async (body) => {
      await expect(
        simulateTestnetDeposit("test-key", owner, 84532, transport(body)),
      ).rejects.toThrow();
    },
  );
  it("does not retry on a scope failure", async () => {
    const fetcher = transport({ error: "insufficient_scope" }, 403);
    await expect(
      simulateTestnetDeposit("test-key", owner, 84532, fetcher),
    ).rejects.toThrow("HTTP 403");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
