import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { hash, json } from "../src/core/serialization.js";
import { ReturnRunStore, decodeRun } from "../src/state/return-runs.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { readRecordedReturnLot, readReturnEconomics } from "../src/testnet/return-context.js";
import {
  decideReturn,
  defaultReturnPolicy,
  type ReturnDecisionInput,
} from "../src/testnet/return-policy.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";
import {
  buildReturnIncreaseStage,
  buildReturnSwapStage,
  RETURN_STEPS,
} from "../src/testnet/return-stages.js";
import { stageFor, submitReturnStep } from "../src/testnet/return-executor.js";
import { readReturnWalletState, verifyReturnReceipt } from "../src/testnet/return-receipts.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let db: ReturnRunStore | undefined,
  history: ReturnObservationStore | undefined,
  activeCycle: string | undefined;
async function main() {
  const mode = process.argv[2] ?? "status";
  if (!["status", "run", "reconcile", "pause"].includes(mode))
    throw new Error("Choose status, run, reconcile or pause");
  if (mode === "run" && !process.argv.includes("--execute"))
    throw new Error("Explicit --execute required for testnet broadcasting");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified organization owner required");
  const lot = readRecordedReturnLot(owner),
    policy = defaultReturnPolicy,
    client = testnetReturnClient();
  db = new ReturnRunStore("artifacts/testnet-return-runs.sqlite");
  let run = db.get(lot.cycleId);
  if (mode === "pause") {
    db.pause(lot.cycleId);
    console.log("RETURN paused. Receipt reconciliation remains available.");
    return;
  }
  if (mode === "status" || (mode === "run" && !run)) {
    const snapshot = await readReturnSnapshot(client, lot, policy);
    history = new ReturnObservationStore("artifacts/testnet-return-observations.sqlite");
    const previous = history.get(lot.cycleId);
    const canonical =
      !previous ||
      (await client.getBlock({ blockNumber: previous.block.number })).hash === previous.block.hash;
    const now = Math.floor(Date.now() / 1000),
      observation = history.record(snapshot, policy, now, previous, canonical);
    const input: ReturnDecisionInput = {
      ...snapshot,
      observation,
      policy,
      economics: await readReturnEconomics(),
      now,
    };
    const decision = decideReturn(input);
    if (mode === "status" || decision.action !== "RETURN") {
      const report = {
        mode: "BASE_SEPOLIA_RETURN_RUNNER_STATUS",
        lotStatus: lot.status,
        cycleId: lot.cycleId,
        decision,
        runStatus: run?.status ?? "NOT_STARTED",
        steps: db.steps(lot.cycleId).map((s) => ({ id: s.id, status: s.status })),
        transactions: [],
      };
      await writeFile("artifacts/testnet-return-runner-status.json", json(report));
      console.log(json(report));
      return;
    }
    if (!process.env.KEEPERHUB_TESTNET_WRITE_KEY)
      throw new Error("Testnet write credential required");
    db.create(input);
    run = db.get(lot.cycleId);
  }
  if (!run) throw new Error("No RETURN run exists for this cycle");
  if (run.status === "COMPLETE") {
    console.log("RETURN already complete. Nothing submitted.");
    return;
  }
  const key = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
  if (!key) throw new Error("KeeperHub credential required for receipt reconciliation");
  if (mode === "run" && (run.status !== "ACTIVE" || hash(lot) !== hash(run.input.lot)))
    throw new Error("Recorded cycle is paused, restored or changed");
  activeCycle = mode === "run" ? lot.cycleId : undefined;
  for (const id of RETURN_STEPS) {
    let step = db.steps(lot.cycleId).find((s) => s.id === id)!;
    if (step.status === "CONFIRMED") continue;
    if (step.status === "READY") {
      if (mode === "reconcile") break;
      run = db.get(lot.cycleId)!;
      const phase = stageFor(id);
      if (!db.phase(lot.cycleId, phase)) {
        const state = await readReturnWalletState(client, run.input.lot, run.input.policy);
        const now = Math.floor(Date.now() / 1000);
        if (state.wallet0 < run.capital.amount0 || state.wallet1 < run.capital.amount1)
          throw new Error("Strategy capital no longer available");
        const plan =
          phase === "SWAP"
            ? await buildReturnSwapStage(client, state.snapshot, run.capital, run.input.policy, now)
            : buildReturnIncreaseStage(state.snapshot, run.capital, run.input.policy, now);
        db.savePhase(plan, Math.floor(Date.now() / 1000));
      }
      await submitReturnStep({ store: db, cycleId: lot.cycleId, id, client, apiKey: key });
      step = db.steps(lot.cycleId).find((s) => s.id === id)!;
    }
    const evidence = await verifyReturnReceipt(client, step, run!.input.policy, key);
    db.confirm(lot.cycleId, id, evidence, evidence.capital);
    console.log(
      json({
        step: id,
        executionId: evidence.executionId,
        transaction: evidence.explorerUrl,
        capital: evidence.capital,
      }),
    );
    const latest = db.get(lot.cycleId)!;
    await writeFile(
      "artifacts/testnet-automatic-return.json",
      json({
        mode: "BASE_SEPOLIA_POLICY_GATED_RETURN",
        chainId: 84532,
        keeperhubExecution: true,
        policyDecision: true,
        originalLot: latest.input.lot,
        initialDecision: decideReturn(latest.input),
        capital: latest.capital,
        status: latest.status,
        steps: db
          .steps(lot.cycleId)
          .filter((s) => s.evidence)
          .map((s) => decodeRun(s.evidence!)),
      }),
    );
  }
}
main()
  .catch((error) => {
    if (activeCycle && db?.get(activeCycle)?.status === "ACTIVE") db.pause(activeCycle);
    console.error(error instanceof Error ? error.message.split("\n")[0] : "RETURN runner stopped");
    process.exitCode = 1;
  })
  .finally(() => {
    db?.close();
    history?.close();
  });
