import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { returnFixture } from "./fixtures/return.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { encodeRun } from "../src/state/return-runs.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import { buildTestnetRelease } from "../src/testnet/park-plan.js";
import {
  REPARK_STEPS,
  reparkIntent,
  selectReparkLot,
  type ReparkAnchor,
} from "../src/testnet/repark-context.js";
import {
  buildReparkStep,
  reparkEvents,
  submitReparkStep,
  verifyReparkDelta,
  type ReparkBaseline,
  type ReparkState,
} from "../src/testnet/repark.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
const tx = `0x${"ab".repeat(32)}` as Hex;
function fixture() {
  const snapshot = returnFixture();
  snapshot.lot.status = "RESTORED";
  Object.assign(snapshot.position, {
    liquidity: 123n,
    principal0: snapshot.lot.principal - 70n,
    currentTick: -196257,
    twapTick: -196257,
  });
  snapshot.market.supplyCapRemaining = null;
  const state: ReparkState = {
    snapshot,
    wallet0: 68n,
    wallet1: 777n,
    nftCount: 1n,
    swapAllowance: 0n,
    lp0Allowance: 0n,
    lp1Allowance: 0n,
    aaveAllowance: 0n,
    scaledAToken: 79000000n,
  };
  const anchor: ReparkAnchor = {
    lot: structuredClone(snapshot.lot),
    restorationHash: tx,
    block: snapshot.position.block,
    liquidity: 123n,
    parentCall: buildTestnetRelease(
      snapshot.lot.owner,
      snapshot.lot.tokenId,
      123n,
      snapshot.lot.principal,
      9000,
    ),
    sponsored: false,
  };
  const amount = snapshot.position.principal0;
  const baseline: ReparkBaseline = {
    anchor,
    state,
    amount,
    createdAt: 10000,
    call: buildReparkStep("release", anchor, state, amount, 10000),
  };
  return { state, anchor, amount, baseline };
}
function released() {
  const f = fixture();
  const after = structuredClone(f.state);
  after.snapshot.position.liquidity = 0n;
  after.wallet0 += f.amount;
  return { ...f, after };
}
function releaseLogs(amount: bigint) {
  const { anchor } = fixture();
  return [
    {
      address: config.positionManager,
      topics: encodeEventTopics({
        abi: reparkEvents,
        eventName: "DecreaseLiquidity",
        args: { tokenId: anchor.lot.tokenId },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
        [123n, amount, 0n],
      ),
    },
    {
      address: config.positionManager,
      topics: encodeEventTopics({
        abi: reparkEvents,
        eventName: "Collect",
        args: { tokenId: anchor.lot.tokenId },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [anchor.lot.owner, amount, 0n],
      ),
    },
  ];
}
function supplyLogs(amount: bigint, interest = 123n, index = 10n ** 27n) {
  const { anchor, state } = fixture(),
    owner = anchor.lot.owner;
  return [
    {
      address: config.aavePool,
      topics: encodeEventTopics({
        abi: reparkEvents,
        eventName: "Supply",
        args: { reserve: config.weth, onBehalfOf: owner, referralCode: 0 },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, amount]),
    },
    {
      address: state.snapshot.market.aToken,
      topics: encodeEventTopics({
        abi: reparkEvents,
        eventName: "Mint",
        args: { caller: owner, onBehalfOf: owner },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [amount + interest, interest, index],
      ),
    },
  ];
}
describe("one-time original NFT re-PARK", () => {
  it("binds intents to original restoration, with no timestamp or new funding", () => {
    const f = fixture();
    expect(reparkIntent(f.anchor, "release")).toBe(reparkIntent(f.anchor, "release"));
    expect(
      reparkIntent({ ...f.anchor, restorationHash: `0x${"cd".repeat(32)}` }, "release"),
    ).not.toBe(reparkIntent(f.anchor, "release"));
    expect(f.baseline.call.request.value).toBe("0");
  });
  it.each([
    "chain",
    "owner",
    "pair",
    "range",
    "liquidity",
    "two-assets",
    "debt",
    "cap",
    "spot",
    "twap",
    "oracle",
    "stale",
    "future",
  ])("blocks invalid %s before execution", (kind) => {
    const { state: s, anchor, amount } = fixture();
    if (kind === "chain") s.snapshot.position.chainId = 8453;
    if (kind === "owner") s.snapshot.position.owner = s.snapshot.lot.pool;
    if (kind === "pair") s.snapshot.position.token1.address = config.weth;
    if (kind === "range") s.snapshot.position.tickUpper++;
    if (kind === "liquidity") s.snapshot.position.liquidity++;
    if (kind === "two-assets") s.snapshot.position.checkpointOwed1 = 1n;
    if (kind === "debt") s.snapshot.totalDebtBase = 1n;
    if (kind === "cap") s.snapshot.market.supplyCapRemaining = amount - 1n;
    if (kind === "spot") s.snapshot.position.currentTick = s.snapshot.lot.lower;
    if (kind === "twap") s.snapshot.position.twapTick = null;
    if (kind === "oracle") s.snapshot.oracle.cardinalityNext = 1;
    expect(() =>
      buildReparkStep(
        "release",
        anchor,
        s,
        amount,
        kind === "stale" ? 10060 : kind === "future" ? 9999 : 10000,
      ),
    ).toThrow();
  });
  it("attributes only collected WETH and preserves unrelated wallet funds and old scaled shares", () => {
    const f = released();
    expect(verifyReparkDelta("release", f.baseline, f.after, releaseLogs(f.amount))).toBe(f.amount);
    f.after.wallet0++;
    expect(() => verifyReparkDelta("release", f.baseline, f.after, releaseLogs(f.amount))).toThrow(
      "principal mismatch",
    );
  });
  it.each(["unrelated-shares", "usdc", "nft", "missing-event"])("rejects release %s", (kind) => {
    const f = released();
    if (kind === "unrelated-shares") f.after.scaledAToken++;
    if (kind === "usdc") f.after.wallet1++;
    if (kind === "nft") f.after.nftCount++;
    expect(() =>
      verifyReparkDelta(
        "release",
        f.baseline,
        f.after,
        kind === "missing-event" ? [] : releaseLogs(f.amount),
      ),
    ).toThrow();
  });
  it("requires exact allowance and only released principal", () => {
    const f = released();
    expect(() => buildReparkStep("supply", f.anchor, f.after, f.amount, 10000)).toThrow(
      "allowance",
    );
    f.after.aaveAllowance = f.amount;
    expect(
      JSON.parse(
        buildReparkStep("supply", f.anchor, f.after, f.amount, 10000).request.functionArgs,
      )[1],
    ).toBe(String(f.amount));
    expect(() =>
      buildReparkStep("supply", f.anchor, f.after, f.anchor.lot.principal + 1n, 10000),
    ).toThrow();
  });
  it("uses scaled-share delta despite a Mint event containing old accrued interest", () => {
    const f = released(),
      before = { ...f.baseline, state: f.after },
      after = structuredClone(f.after);
    after.wallet0 -= f.amount;
    after.scaledAToken += f.amount;
    expect(verifyReparkDelta("supply", before, after, supplyLogs(f.amount, 987654n))).toBe(
      f.amount,
    );
    after.scaledAToken += 987654n;
    expect(() => verifyReparkDelta("supply", before, after, supplyLogs(f.amount, 987654n))).toThrow(
      "scaled share",
    );
  });
  it("accepts only the floor/ceiling of share conversion rounding", () => {
    const f = released(),
      before = { ...f.baseline, state: f.after },
      after = structuredClone(f.after),
      index = 105n * 10n ** 25n;
    after.wallet0 -= f.amount;
    after.scaledAToken += (f.amount * 10n ** 27n) / index;
    expect(verifyReparkDelta("supply", before, after, supplyLogs(f.amount, 123n, index))).toBe(
      f.amount,
    );
    after.scaledAToken += 2n;
    expect(() =>
      verifyReparkDelta("supply", before, after, supplyLogs(f.amount, 123n, index)),
    ).toThrow();
  });
  it("holds partial allocations; starts a distinct cycle only after all three receipts", () => {
    const f = fixture(),
      db = new TestnetDepositStore(":memory:");
    try {
      expect(selectReparkLot(f.anchor.lot, f.anchor, db)).toEqual(f.anchor.lot);
      REPARK_STEPS.forEach((id, i) => {
        const intent = reparkIntent(f.anchor, id);
        db.claim(intent, "{}", "{}");
        expect(selectReparkLot(f.anchor.lot, f.anchor, db).status).toBe("RECOVERY");
        db.recordResponse(intent, {});
        db.recordEvidence(
          intent,
          encodeRun({
            id,
            anchor: f.anchor,
            amount: f.amount,
            transactionHash: `0x${String(i + 2).repeat(64)}`,
            after: {
              snapshot: { position: { block: { ...f.anchor.block, timestamp: 10001 + i } } },
            },
          }),
        );
      });
      expect(selectReparkLot(f.anchor.lot, f.anchor, db)).toMatchObject({
        status: "PARKED",
        principal: f.amount,
        parkedAt: 10003,
        cycleId: `0x${"4".repeat(64)}`,
      });
      expect(f.anchor.lot.status).toBe("RESTORED");
      expect(() => selectReparkLot({ ...f.anchor.lot, principal: 1n }, f.anchor, db)).toThrow(
        "parent allocation",
      );
    } finally {
      db.close();
    }
  });
  it("durably claims before write; a lost response blocks both retry and dependent supply", async () => {
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
            from: f.anchor.lot.owner,
            to: config.positionManager,
            value: "0",
            gasEstimate: "100000",
          }),
        ),
      )
      .mockImplementationOnce(() => {
        expect(db.get(reparkIntent(f.anchor, "release"))?.status).toBe("SUBMITTING");
        throw Error("lost response");
      });
    const args = {
      client: { getChainId: async () => 84532 } as TestnetReturnClient,
      anchor: f.anchor,
      id: "release" as const,
      store: db,
      apiKey: "test",
      manualRehearsal: true,
      fetcher,
      clock: () => 10000,
      readState: async () => f.state,
      verifyParent: async () => {},
    };
    try {
      await expect(submitReparkStep(args)).rejects.toThrow("lost response");
      await expect(submitReparkStep(args)).rejects.toThrow("already started");
      await expect(submitReparkStep({ ...args, id: "supply" })).rejects.toThrow("dependency");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
  it.each(["sender", "price-change", "expired", "not-manual"])(
    "does not write or claim on %s",
    async (kind) => {
      const f = fixture(),
        db = new TestnetDepositStore(":memory:"),
        fresh = structuredClone(f.state);
      if (kind === "price-change") fresh.snapshot.position.currentTick = f.anchor.lot.lower;
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              status: "simulated",
              wouldRevert: false,
              from: kind === "sender" ? config.weth : f.anchor.lot.owner,
              to: config.positionManager,
              value: "0",
              gasEstimate: "100000",
            }),
          ),
        );
      const clock = vi.fn().mockReturnValueOnce(10000).mockReturnValue(10060);
      try {
        await expect(
          submitReparkStep({
            client: { getChainId: async () => 84532 } as TestnetReturnClient,
            anchor: f.anchor,
            id: "release",
            store: db,
            apiKey: "test",
            manualRehearsal: kind !== "not-manual",
            fetcher,
            clock: kind === "expired" ? clock : () => 10000,
            readState: vi.fn().mockResolvedValueOnce(f.state).mockResolvedValue(fresh),
            verifyParent: async () => {},
          }),
        ).rejects.toThrow();
        expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1);
        expect(db.get(reparkIntent(f.anchor, "release"))).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );
});
