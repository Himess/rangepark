import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { readOriginalReturnLot } from "../src/testnet/return-context.js";
import { testnetReturnClient } from "../src/testnet/return-reader.js";
import {
  readReparkAnchor,
  REPARK_STEPS,
  reparkIntent,
  selectReparkLot,
} from "../src/testnet/repark-context.js";
import {
  buildReparkStep,
  readReparkState,
  reconcileReparkStep,
  submitReparkStep,
  verifyReparkParent,
} from "../src/testnet/repark.js";
import { decodeRun } from "../src/state/return-runs.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let db: TestnetDepositStore | undefined;
async function main() {
  const mode = process.argv[2] ?? "status";
  if (!["status", "run", "reconcile"].includes(mode))
    throw new Error("Choose status, run or reconcile");
  if (
    mode === "run" &&
    (!process.argv.includes("--execute") || !process.argv.includes("--manual-rehearsal"))
  )
    throw new Error("Explicit --execute --manual-rehearsal required");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified KeeperHub owner required");
  const lot = readOriginalReturnLot(owner),
    anchor = readReparkAnchor(lot),
    client = testnetReturnClient();
  db = new TestnetDepositStore("artifacts/testnet-repark.sqlite");
  if (mode === "status") {
    await verifyReparkParent(client, anchor);
    const state = await readReparkState(client, anchor);
    const report = {
      mode: "READ_ONLY_REPARK_READINESS",
      anchor,
      state,
      selectedLot: selectReparkLot(lot, anchor, db),
      steps: REPARK_STEPS.map((id) => ({
        id,
        status: db!.get(reparkIntent(anchor, id))?.status ?? "NOT_STARTED",
      })),
      draft: db.get(reparkIntent(anchor, "release"))
        ? null
        : buildReparkStep(
            "release",
            anchor,
            state,
            state.snapshot.position.principal0,
            Math.floor(Date.now() / 1000),
          ),
      transactions: [],
    };
    await writeFile("artifacts/testnet-repark-readiness.json", json(report));
    console.log(
      json({
        mode: report.mode,
        selectedLot: report.selectedLot,
        steps: report.steps,
        draftAvailable: report.draft !== null,
      }),
    );
    return;
  }
  const key = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
  if (!key) throw new Error("Testnet write credential required");
  for (const id of REPARK_STEPS) {
    const row = db.get(reparkIntent(anchor, id));
    if (!row) {
      if (mode === "reconcile") break;
      await submitReparkStep({ client, anchor, id, store: db, apiKey: key, manualRehearsal: true });
    }
    const proof = await reconcileReparkStep(client, anchor, id, db, key);
    console.log(
      json({
        step: id,
        executionId: proof.executionId,
        transaction: proof.explorerUrl,
        attributedWeth: proof.amount,
      }),
    );
    const proofs = REPARK_STEPS.map((step) => db!.get(reparkIntent(anchor, step)))
      .filter((row) => row?.status === "CONFIRMED")
      .map((row) => decodeRun(row!.evidence!));
    await writeFile(
      "artifacts/testnet-repark.json",
      json({
        mode: "MANUAL_BASE_SEPOLIA_REPARK",
        chainId: 84532,
        keeperhubExecution: true,
        policyDecision: false,
        parentRestoration: anchor.restorationHash,
        originalLot: lot,
        selectedLot: selectReparkLot(lot, anchor, db),
        steps: proofs,
        complete: proofs.length === 3,
      }),
    );
  }
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message.split("\n")[0] : "Re-PARK stopped");
    process.exitCode = 1;
  })
  .finally(() => db?.close());
