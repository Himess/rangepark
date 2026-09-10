import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { returnFixture } from "./fixtures/return.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import {
  FIXTURE_USDC,
  TEST_FAUCET,
  buildFixtureCall,
  fixtureIntent,
  submitFixtureStep,
  verifyFixtureDelta,
  type FixtureBaseline,
  type FixtureState,
} from "../src/testnet/price-fixture.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
function fixture() {
  const snapshot = returnFixture();
  snapshot.position.currentTick = -196257;
  snapshot.position.twapTick = -196257;
  const state: FixtureState = {
    snapshot,
    wallet0: 68n,
    wallet1: 555n,
    nftCount: 1n,
    swapAllowance: 0n,
    lp0Allowance: 53n,
    lp1Allowance: 0n,
    usdcAllowance: 0n,
    scaledAToken: 123456789n,
    tokenOwner: TEST_FAUCET,
    permissioned: false,
    mintCooldown: 3600n,
    maxMint: 10n ** 12n,
    lastMint: 0n,
  };
  const lot = structuredClone(snapshot.lot),
    call = buildFixtureCall("mint-test-usdc", lot, state, 10000);
  return {
    state,
    lot,
    baseline: { lot, state, call, createdAt: 10000, minimumOut: 0n } satisfies FixtureBaseline,
  };
}
describe("bounded public test-price fixture", () => {
  it("mints at most 100 test USDC to the existing owner with zero native value", () => {
    const f = fixture();
    expect(f.baseline.call.request.contractAddress).toBe(TEST_FAUCET);
    expect(JSON.parse(f.baseline.call.request.functionArgs)).toEqual([
      config.aaveUsdc,
      f.lot.owner,
      String(FIXTURE_USDC),
    ]);
    expect(f.baseline.call.request.value).toBe("0");
  });
  it.each([
    "chain",
    "nft",
    "owner",
    "principal",
    "shares",
    "debt",
    "range",
    "inside",
    "faucet",
    "permission",
    "cooldown",
    "cap",
    "stale",
  ])("blocks %s changes", (kind) => {
    const { state: s, lot } = fixture();
    if (kind === "chain") s.snapshot.position.chainId = 8453;
    if (kind === "nft") s.snapshot.position.liquidity = 1n;
    if (kind === "owner") s.snapshot.position.owner = config.weth;
    if (kind === "principal") lot.principal = 10n ** 15n + 1n;
    if (kind === "shares") s.snapshot.aTokenBalance = 1n;
    if (kind === "debt") s.snapshot.totalDebtBase = 1n;
    if (kind === "range") s.snapshot.position.tickUpper++;
    if (kind === "inside") s.snapshot.position.currentTick = lot.lower;
    if (kind === "faucet") s.tokenOwner = config.weth;
    if (kind === "permission") s.permissioned = true;
    if (kind === "cooldown") s.lastMint = 9999n;
    if (kind === "cap") s.maxMint = FIXTURE_USDC - 1n;
    expect(() =>
      buildFixtureCall("mint-test-usdc", lot, s, kind === "stale" ? 10060 : 10000),
    ).toThrow();
  });
  it("requires exact swap approval and nonzero output minimum", () => {
    const f = fixture();
    f.state.wallet1 += FIXTURE_USDC;
    expect(() => buildFixtureCall("move-test-price", f.lot, f.state, 10000, 1n)).toThrow();
    f.state.usdcAllowance = FIXTURE_USDC;
    expect(() => buildFixtureCall("move-test-price", f.lot, f.state, 10000, 0n)).toThrow();
    expect(
      buildFixtureCall("move-test-price", f.lot, f.state, 10000, 1n).request.functionName,
    ).toBe("multicall");
  });
  it("can revoke the residual allowance after reaching the range", () => {
    const f = fixture();
    f.state.snapshot.position.currentTick = -196198;
    f.state.usdcAllowance = 77n;
    const call = buildFixtureCall("revoke-test-usdc", f.lot, f.state, 10000);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.calldata }).args).toEqual([
      config.swapRouter,
      0n,
    ]);
  });
  it("requires a real mint event plus exact balance growth, preserving prior wallet and Aave shares", () => {
    const f = fixture(),
      after = structuredClone(f.state);
    after.wallet1 += FIXTURE_USDC;
    const abi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const logs = [
      {
        address: config.aaveUsdc,
        topics: encodeEventTopics({
          abi,
          eventName: "Transfer",
          args: { from: zeroAddress, to: f.lot.owner },
        }) as Hex[],
        data: encodeAbiParameters([{ type: "uint256" }], [FIXTURE_USDC]),
      },
    ];
    expect(() => verifyFixtureDelta(f.baseline, after, logs)).not.toThrow();
    after.scaledAToken--;
    expect(() => verifyFixtureDelta(f.baseline, after, logs)).toThrow("parked shares");
    after.scaledAToken++;
    after.wallet1++;
    expect(() => verifyFixtureDelta(f.baseline, after, logs)).toThrow("mint receipt");
  });
  it("does not replay an ambiguous mint or approve before its confirmation", async () => {
    const f = fixture(),
      db = new TestnetDepositStore(":memory:");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: f.lot.owner,
            to: TEST_FAUCET,
            value: "0",
            gasEstimate: "100000",
          }),
        ),
      )
      .mockImplementationOnce(() => {
        expect(db.get(fixtureIntent(f.lot, "mint-test-usdc"))?.status).toBe("SUBMITTING");
        throw Error("lost response");
      });
    const args = {
      client: { getChainId: async () => 84532 } as TestnetReturnClient,
      lot: f.lot,
      id: "mint-test-usdc" as const,
      store: db,
      apiKey: "test",
      manualFixture: true,
      fetcher,
      clock: () => 10000,
      readState: async () => f.state,
    };
    try {
      await expect(submitFixtureStep(args)).rejects.toThrow("lost response");
      await expect(submitFixtureStep(args)).rejects.toThrow("already submitted");
      await expect(submitFixtureStep({ ...args, id: "approve-test-usdc" })).rejects.toThrow(
        "dependency",
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
  it("rejects changed capital between simulation and submission without claiming", async () => {
    const f = fixture(),
      db = new TestnetDepositStore(":memory:"),
      fresh = structuredClone(f.state);
    fresh.wallet0++;
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: f.lot.owner,
            to: TEST_FAUCET,
            value: "0",
            gasEstimate: "100000",
          }),
        ),
      );
    try {
      await expect(
        submitFixtureStep({
          client: { getChainId: async () => 84532 } as TestnetReturnClient,
          lot: f.lot,
          id: "mint-test-usdc",
          store: db,
          apiKey: "test",
          manualFixture: true,
          fetcher,
          clock: () => 10000,
          readState: vi.fn().mockResolvedValueOnce(f.state).mockResolvedValue(fresh),
        }),
      ).rejects.toThrow("capital changed");
      expect(db.get(fixtureIntent(f.lot, "mint-test-usdc"))).toBeUndefined();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
