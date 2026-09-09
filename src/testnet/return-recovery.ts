import { hash } from "../core/serialization.js";
import { ReturnRunStore, decodeRun } from "../state/return-runs.js";
import { requireTestnetChain } from "./config.js";
import { stageFor, validateReturnCall } from "./return-executor.js";
import type { ParkedLot, ReturnDecisionInput } from "./return-policy.js";
import type { TestnetReturnClient } from "./return-reader.js";
import { readReturnWalletState, verifyReturnReceipt } from "./return-receipts.js";
import {
  assertReentrySnapshot,
  buildReturnIncreaseStage,
  buildReturnSwapStage,
  buildReturnWithdrawalStage,
  verifyStage,
} from "./return-stages.js";

// Reopens only a fully reconciled journal. No API write occurs here. The regular
// executor still simulates and guards every remaining call before claiming it.
export async function resumeReturnRun(args: {
  store: ReturnRunStore;
  cycleId: string;
  recordedLot: ParkedLot;
  client: TestnetReturnClient;
  apiKey: string;
  withdrawalInput?: ReturnDecisionInput;
  clock?: () => number;
  readState?: typeof readReturnWalletState;
  verifyReceipt?: typeof verifyReturnReceipt;
}) {
  const { store, cycleId, client } = args;
  const clock = args.clock ?? (() => Math.floor(Date.now() / 1000));
  const run = store.get(cycleId),
    rows = store.steps(cycleId);
  const expectedHash = store.recoveryHash(cycleId);
  if (!run || run.status !== "PAUSED") throw new Error("Explicitly paused RETURN required");
  if (args.recordedLot.status !== "PARKED" || hash(args.recordedLot) !== hash(run.input.lot))
    throw new Error("External allocation changed, restored or in recovery");
  if (rows.some((r) => r.status === "SUBMITTING" || r.status === "RECONCILE"))
    throw new Error("Unresolved submission; reconcile without resending");
  const next = rows.find((r) => r.status === "READY");
  if (!next) throw new Error("No remaining RETURN step");
  requireTestnetChain(await client.getChainId());
  const verify = args.verifyReceipt ?? verifyReturnReceipt;
  const verified: string[] = [];
  for (const row of rows.filter((r) => r.status === "CONFIRMED")) {
    const proof = await verify(
      client,
      { ...row, status: "RECONCILE" },
      run.input.policy,
      args.apiKey,
    );
    if (!row.evidence || hash(proof) !== hash(decodeRun(row.evidence)))
      throw new Error("Confirmed receipt changed during recovery");
    verified.push(proof.transactionHash);
  }
  const state = await (args.readState ?? readReturnWalletState)(
    client,
    run.input.lot,
    run.input.policy,
  );
  if (
    hash(state.snapshot.lot) !== hash(run.input.lot) ||
    state.wallet0 < run.capital.amount0 ||
    state.wallet1 < run.capital.amount1
  )
    throw new Error("Recovery identity or attributed balances changed");
  const now = clock(),
    phase = stageFor(next.id);
  let input = run.input;
  let plan;
  if (phase === "WITHDRAW") {
    if (!args.withdrawalInput)
      throw new Error("Fresh eligibility and economics required before withdrawal recovery");
    input = { ...args.withdrawalInput, ...state.snapshot, now };
    plan = buildReturnWithdrawalStage(input);
  } else {
    assertReentrySnapshot(state.snapshot, run.input.policy, now);
    if (phase === "SWAP") {
      const approved = rows.find((r) => r.id === "approve-swap")!.status === "CONFIRMED";
      const fixedInput = approved ? store.phase(cycleId, "SWAP")?.amounts.input : undefined;
      if (approved && (fixedInput === undefined || state.swapAllowance !== fixedInput))
        throw new Error("Confirmed swap allowance changed");
      plan = await buildReturnSwapStage(
        client,
        state.snapshot,
        run.capital,
        run.input.policy,
        now,
        fixedInput,
      );
    } else {
      if (
        (rows.find((r) => r.id === "approve-lp0")!.status === "CONFIRMED" &&
          state.lp0Allowance !== run.capital.amount0) ||
        (rows.find((r) => r.id === "approve-lp1")!.status === "CONFIRMED" &&
          state.lp1Allowance !== run.capital.amount1)
      )
        throw new Error("Confirmed LP allowance changed");
      plan = buildReturnIncreaseStage(state.snapshot, run.capital, run.input.policy, now);
    }
  }
  plan.calls.forEach((call) => validateReturnCall(input, plan, call));
  verifyStage(plan, clock());
  if (
    (await client.getBlock({ blockNumber: state.snapshot.position.block.number })).hash !==
    state.snapshot.position.block.hash
  )
    throw new Error("Recovery source block changed");
  verifyStage(plan, clock());
  // The compare-and-set also catches another process reconciling, resuming or pausing.
  store.resume(cycleId, expectedHash, plan, input, now, { verified, state });
  return plan;
}
