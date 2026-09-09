import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { TickMath } from "@uniswap/v3-sdk";
import { describe, expect, it, vi } from "vitest";
import { hash } from "../src/core/serialization.js";
import { ReturnRunStore, encodeRun } from "../src/state/return-runs.js";
import { resumeReturnRun } from "../src/testnet/return-recovery.js";
import {
  pollReturnReceipt,
  ReturnReceiptPending,
  type ReturnWalletState,
  verifyReturnReceipt,
} from "../src/testnet/return-receipts.js";
import { buildReturnSwapStage, type StageDraft } from "../src/testnet/return-stages.js";
import type { TestnetReturnClient } from "../src/testnet/return-reader.js";
import { eligibleReturnInput, returnFixture } from "./fixtures/return.js";

async function setup(path = ":memory:") {
  const input = eligibleReturnInput(),
    db = new ReturnRunStore(path);
  const withdrawal = db.create(input);
  const client = {
    getChainId: vi.fn().mockResolvedValue(84532),
    getBlock: vi.fn().mockResolvedValue(returnFixture(10100).position.block),
    simulateContract: vi
      .fn()
      .mockResolvedValue({
        result: [1500000n, BigInt(TickMath.getSqrtRatioAtTick(-196201).toString()), 0, 100000n],
      }),
  } as unknown as TestnetReturnClient;
  function confirm(plan: StageDraft, index: number, capital: { amount0: bigint; amount1: bigint }) {
    const call = plan.calls[index]!;
    db.claim(input.lot.cycleId, plan, call, {}, 10000);
    db.response(input.lot.cycleId, call.id, {
      httpStatus: 200,
      body: { executionId: call.id, status: "completed" },
    });
    const proof = { transactionHash: `0x${"ab".repeat(32)}`, step: call.id, synthetic: true };
    db.confirm(input.lot.cycleId, call.id, proof, capital);
  }
  const capital = { amount0: input.lot.principal, amount1: 0n };
  confirm(withdrawal, 0, capital);
  vi.mocked(client.getBlock).mockResolvedValueOnce(input.position.block as never);
  const swap = await buildReturnSwapStage(client, input, capital, input.policy, 10000);
  db.savePhase(swap, 10000);
  confirm(swap, 0, capital);
  db.pause(input.lot.cycleId);
  const state: ReturnWalletState = {
    snapshot: returnFixture(10100),
    wallet0: capital.amount0 + 20n,
    wallet1: 100n,
    nftCount: 1n,
    swapAllowance: swap.amounts.input,
    lp0Allowance: 0n,
    lp1Allowance: 0n,
  };
  const verifyReceipt = vi.fn(async (_c, row) => ({
    transactionHash: `0x${"ab".repeat(32)}`,
    step: row.id,
    synthetic: true,
  })) as unknown as typeof verifyReturnReceipt;
  const args = {
    store: db,
    cycleId: input.lot.cycleId,
    recordedLot: input.lot,
    client,
    apiKey: "test-only",
    clock: () => 10100,
    readState: vi.fn().mockResolvedValue(state),
    verifyReceipt,
  };
  return { db, input, swap, state, args };
}

describe("controlled RETURN recovery", () => {
  it("requires fresh full eligibility before an unsent withdrawal and retains the original decision", async () => {
    const input = eligibleReturnInput(),
      db = new ReturnRunStore(":memory:");
    db.create(input);
    db.pause(input.lot.cycleId);
    const state: ReturnWalletState = {
      snapshot: returnFixture(),
      wallet0: 20n,
      wallet1: 100n,
      nftCount: 1n,
      swapAllowance: 0n,
      lp0Allowance: 0n,
      lp1Allowance: 0n,
    };
    const client = {
      getChainId: vi.fn().mockResolvedValue(84532),
      getBlock: vi.fn().mockResolvedValue(input.position.block),
    } as unknown as TestnetReturnClient;
    const args = {
      store: db,
      cycleId: input.lot.cycleId,
      recordedLot: input.lot,
      client,
      apiKey: "test-only",
      clock: () => 10001,
      readState: vi.fn().mockResolvedValue(state),
    };
    try {
      await expect(resumeReturnRun(args)).rejects.toThrow("Fresh eligibility");
      await expect(
        resumeReturnRun({ ...args, withdrawalInput: { ...input, economics: null } }),
      ).rejects.toThrow();
      expect(db.get(input.lot.cycleId)?.status).toBe("PAUSED");
      await resumeReturnRun({ ...args, withdrawalInput: input });
      expect(db.initialInput(input.lot.cycleId)).toEqual(input);
      expect(db.get(input.lot.cycleId)?.input.now).toBe(10001);
      expect(db.steps(input.lot.cycleId).every((row) => row.status === "READY")).toBe(true);
    } finally {
      db.close();
    }
  });
  it("refreshes an expired swap while preserving confirmed approval, initial input and capital across restart", async () => {
    const path = join(tmpdir(), `rangepark-return-${randomUUID()}.sqlite`);
    const s = await setup(path);
    let reopened: ReturnRunStore | undefined;
    try {
      const before = s.db.steps(s.input.lot.cycleId).slice(0, 2);
      s.db.close();
      reopened = new ReturnRunStore(path);
      const plan = await resumeReturnRun({ ...s.args, store: reopened });
      expect(plan.planHash).not.toBe(s.swap.planHash);
      expect(plan.amounts.input).toBe(s.swap.amounts.input);
      expect(plan.expiresAt).toBe(10160);
      expect(reopened.steps(s.input.lot.cycleId).slice(0, 2)).toEqual(before);
      expect(reopened.get(s.input.lot.cycleId)).toMatchObject({
        status: "ACTIVE",
        capital: s.swap.capital,
      });
      expect(reopened.initialInput(s.input.lot.cycleId)).toEqual(s.input);
      expect(reopened.recoveries(s.input.lot.cycleId)).toHaveLength(1);
      expect(s.args.verifyReceipt).toHaveBeenCalledTimes(2);
      expect(s.args.client.simulateContract).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: [expect.objectContaining({ amountIn: s.swap.amounts.input })],
        }),
      );
    } finally {
      reopened?.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
  it.each(["balance", "allowance", "range", "receipt", "reorg", "restored", "mainnet"])(
    "keeps the pause when %s changes",
    async (reason) => {
      const s = await setup();
      try {
        if (reason === "balance") s.state.wallet0 = 0n;
        if (reason === "allowance") s.state.swapAllowance++;
        if (reason === "range") s.state.snapshot.position.currentTick = -196257;
        if (reason === "receipt")
          vi.mocked(s.args.verifyReceipt).mockResolvedValueOnce({
            transactionHash: "changed",
          } as never);
        if (reason === "reorg")
          vi.mocked(s.args.client.getBlock).mockResolvedValue({ hash: "changed" } as never);
        if (reason === "restored") s.args.recordedLot = { ...s.input.lot, status: "RESTORED" };
        if (reason === "mainnet") vi.mocked(s.args.client.getChainId).mockResolvedValue(8453);
        await expect(resumeReturnRun(s.args)).rejects.toThrow();
        expect(s.db.get(s.input.lot.cycleId)?.status).toBe("PAUSED");
        expect(s.db.recoveries(s.input.lot.cycleId)).toHaveLength(0);
      } finally {
        s.db.close();
      }
    },
  );
  it("rejects an unknown submission before any RPC or quote", async () => {
    const s = await setup();
    try {
      await resumeReturnRun(s.args);
      const plan = s.db.phase(s.input.lot.cycleId, "SWAP")!;
      s.db.claim(s.input.lot.cycleId, plan, plan.calls[1]!, {}, 10100);
      s.db.pause(s.input.lot.cycleId);
      vi.mocked(s.args.client.getChainId).mockClear();
      await expect(resumeReturnRun(s.args)).rejects.toThrow("Unresolved submission");
      expect(s.args.client.getChainId).not.toHaveBeenCalled();
      expect(s.db.steps(s.input.lot.cycleId)[2]?.status).toBe("SUBMITTING");
    } finally {
      s.db.close();
    }
  });
  it("cannot replace already confirmed calls or commit against a stale recovery snapshot", async () => {
    const s = await setup();
    try {
      const oldHash = s.db.recoveryHash(s.input.lot.cycleId);
      const plan = await resumeReturnRun(s.args);
      s.db.pause(s.input.lot.cycleId);
      expect(() => s.db.resume(s.input.lot.cycleId, oldHash, plan, s.input, 10100, {})).toThrow(
        "changed",
      );
      const changed = structuredClone(plan);
      changed.calls[0]!.request.functionArgs = "[]";
      const { planHash: _, ...body } = changed;
      changed.planHash = hash(body);
      expect(() =>
        s.db.resume(
          s.input.lot.cycleId,
          s.db.recoveryHash(s.input.lot.cycleId),
          changed,
          s.input,
          10100,
          {},
        ),
      ).toThrow("confirmed call");
    } finally {
      s.db.close();
    }
  });
  it("refuses an approved amount that no longer fits the price ratio", async () => {
    const s = await setup();
    try {
      vi.mocked(s.args.client.simulateContract).mockResolvedValue({
        result: [3000000n, BigInt(TickMath.getSqrtRatioAtTick(-196201).toString()), 0, 1n],
      } as never);
      await expect(resumeReturnRun(s.args)).rejects.toThrow("balanced ratio");
      expect(s.db.get(s.input.lot.cycleId)?.status).toBe("PAUSED");
    } finally {
      s.db.close();
    }
  });
});

describe("bounded receipt polling", () => {
  it.each(["pending", "failed", "foreign"])(
    "classifies the actual %s status envelope without a chain read",
    async (kind) => {
      const input = eligibleReturnInput(),
        db = new ReturnRunStore(":memory:");
      const plan = db.create(input),
        state: ReturnWalletState = {
          snapshot: input,
          wallet0: 0n,
          wallet1: 0n,
          nftCount: 1n,
          swapAllowance: 0n,
          lp0Allowance: 0n,
          lp1Allowance: 0n,
        };
      db.claim(
        input.lot.cycleId,
        plan,
        plan.calls[0]!,
        { state, capital: plan.capital, plan },
        10000,
      );
      db.response(input.lot.cycleId, "withdraw", {
        httpStatus: 200,
        body: { executionId: "known", status: "pending" },
      });
      const row = db.steps(input.lot.cycleId)[0]!;
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              executionId: kind === "foreign" ? "other" : "known",
              status: kind === "failed" ? "failed" : "pending",
              transactionHash: null,
            }),
          ),
        );
      try {
        const call = verifyReturnReceipt(
          {} as TestnetReturnClient,
          row,
          input.policy,
          "test-only",
          fetcher,
        );
        if (kind === "pending") await expect(call).rejects.toBeInstanceOf(ReturnReceiptPending);
        else await expect(call).rejects.not.toBeInstanceOf(ReturnReceiptPending);
        expect(encodeRun(db.steps(input.lot.cycleId)[0])).toBe(encodeRun(row));
      } finally {
        db.close();
      }
    },
  );
  it("rechecks a pending execution and returns only the verified result", async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new ReturnReceiptPending("pending"))
      .mockResolvedValueOnce({ verified: true });
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(pollReturnReceipt(verify, { wait })).resolves.toEqual({ verified: true });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });
  it("does not retry mismatches or unrecognized transport errors", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("wrong owner"));
    await expect(pollReturnReceipt(verify)).rejects.toThrow("wrong owner");
    expect(verify).toHaveBeenCalledOnce();
  });
  it("stops after its polling budget without changing a submission", async () => {
    const verify = vi.fn().mockRejectedValue(new ReturnReceiptPending("pending"));
    await expect(pollReturnReceipt(verify, { attempts: 3, wait: async () => {} })).rejects.toThrow(
      "pending",
    );
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
