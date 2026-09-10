import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  buildOracleSetup,
  oracleSetupAbi,
  oracleSetupIntent,
  submitOracleSetup,
  verifyOracleSetupDelta,
} from "../src/testnet/oracle-setup.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import type { ReturnWalletState } from "../src/testnet/return-receipts.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
import { returnFixture } from "./fixtures/return.js";
function state(): ReturnWalletState {
  const snapshot = returnFixture();
  snapshot.oracle = { cardinality: 1, cardinalityNext: 1 };
  snapshot.position.liquidity = 123n;
  snapshot.lot.status = "RESTORED";
  return {
    snapshot,
    wallet0: 68n,
    wallet1: 0n,
    nftCount: 1n,
    swapAllowance: 0n,
    lp0Allowance: 0n,
    lp1Allowance: 0n,
  };
}
function log() {
  return {
    address: state().snapshot.lot.pool,
    topics: encodeEventTopics({
      abi: oracleSetupAbi,
      eventName: "IncreaseObservationCardinalityNext",
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint16" }, { type: "uint16" }], [1, 16]),
  };
}
describe("bounded oracle preparation", () => {
  it("only reserves sixteen observations on the original testnet pool with zero value", () => {
    const plan = buildOracleSetup(state(), 10000);
    expect(plan.request).toMatchObject({
      chainId: 84532,
      contractAddress: state().snapshot.lot.pool,
      value: "0",
      functionName: "increaseObservationCardinalityNext",
    });
    expect(JSON.parse(plan.request.functionArgs)).toEqual([16]);
  });
  it.each(["chain", "owner", "pool", "pair", "range", "stale", "ready"])(
    "rejects %s mismatches or redundant setup",
    (kind) => {
      const s = state();
      if (kind === "chain") s.snapshot.lot.chainId = 8453;
      if (kind === "owner") s.snapshot.position.owner = s.snapshot.lot.pool;
      if (kind === "pool") s.snapshot.position.pool = s.snapshot.lot.owner;
      if (kind === "pair") s.snapshot.position.token0.address = s.snapshot.lot.owner;
      if (kind === "range") s.snapshot.position.tickUpper++;
      if (kind === "ready") s.snapshot.oracle.cardinalityNext = 16;
      expect(() => buildOracleSetup(s, kind === "stale" ? 10060 : 10000)).toThrow();
    },
  );
  it("verifies the actual capacity event without claiming filled history", () => {
    const before = state(),
      after = structuredClone(before);
    after.snapshot.oracle.cardinalityNext = 16;
    expect(() => verifyOracleSetupDelta(before, after, [log()])).not.toThrow();
    expect(after.snapshot.oracle.cardinality).toBe(1);
    expect(() => verifyOracleSetupDelta(before, after, [])).toThrow("receipt/event");
  });
  it.each(["capital", "liquidity", "allowance"])("rejects unexpected %s changes", (kind) => {
    const before = state(),
      after = structuredClone(before);
    after.snapshot.oracle.cardinalityNext = 16;
    if (kind === "capital") after.wallet0++;
    if (kind === "liquidity") after.snapshot.position.liquidity++;
    if (kind === "allowance") after.lp0Allowance++;
    expect(() => verifyOracleSetupDelta(before, after, [log()])).toThrow("unexpectedly");
  });
  it("claims before a write and permanently blocks resubmission after a lost response", async () => {
    const db = new TestnetDepositStore(":memory:"),
      s = state();
    const simulation = () =>
      new Response(
        JSON.stringify({
          success: true,
          status: "simulated",
          wouldRevert: false,
          from: s.snapshot.lot.owner,
          to: s.snapshot.lot.pool,
          value: "0",
          gasEstimate: "300000",
        }),
      );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(simulation())
      .mockImplementationOnce(() => {
        expect(db.get(oracleSetupIntent(s.snapshot.lot.owner, s.snapshot.lot.pool))?.status).toBe(
          "SUBMITTING",
        );
        throw Error("lost response");
      });
    const args = {
      client: { getChainId: vi.fn().mockResolvedValue(84532) } as unknown as TestnetReturnClient,
      lot: s.snapshot.lot,
      store: db,
      apiKey: "test",
      fetcher,
      clock: () => 10000,
      readState: vi.fn().mockResolvedValue(s),
    };
    try {
      await expect(submitOracleSetup(args)).rejects.toThrow("lost response");
      await expect(submitOracleSetup(args)).rejects.toThrow("already started");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetcher.mock.calls[0]![1].body).simulate).toBe(true);
      expect(JSON.parse(fetcher.mock.calls[1]![1].body).simulate).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("does not claim if capacity changes during simulation", async () => {
    const db = new TestnetDepositStore(":memory:"),
      s = state(),
      fresh = structuredClone(s);
    fresh.snapshot.oracle.cardinalityNext = 16;
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: s.snapshot.lot.owner,
            to: s.snapshot.lot.pool,
            value: "0",
            gasEstimate: "300000",
          }),
        ),
      );
    try {
      await expect(
        submitOracleSetup({
          client: {
            getChainId: vi.fn().mockResolvedValue(84532),
          } as unknown as TestnetReturnClient,
          lot: s.snapshot.lot,
          store: db,
          apiKey: "test",
          fetcher,
          clock: () => 10000,
          readState: vi.fn().mockResolvedValueOnce(s).mockResolvedValueOnce(fresh),
        }),
      ).rejects.toThrow("already reserved");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(db.get(oracleSetupIntent(s.snapshot.lot.owner, s.snapshot.lot.pool))).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
