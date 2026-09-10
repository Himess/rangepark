import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { ReturnRunStore, decodeRun } from "../src/state/return-runs.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { readOriginalReturnLot, readRecordedReturnLot } from "../src/testnet/return-context.js";
import { readReparkAnchor, reparkIntent } from "../src/testnet/repark-context.js";
import type { ReparkProof } from "../src/testnet/repark.js";
import { verifyParkTransaction } from "../src/testnet/park-executor.js";
import { TESTNET_GAS_DELEGATE } from "../src/testnet/receipt.js";
import { testnetReturnClient } from "../src/testnet/return-reader.js";
import { pollReturnReceipt } from "../src/testnet/return-receipts.js";
import {
  FIXTURE_STEPS,
  FIXTURE_TICK,
  FIXTURE_USDC,
  buildFixtureCall,
  fixtureIntent,
  quoteFixture,
  readFixtureState,
  reconcileFixtureStep,
  submitFixtureStep,
  type FixtureProof,
} from "../src/testnet/price-fixture.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let db: TestnetDepositStore | undefined;
async function main() {
  const mode = process.argv[2] ?? "status";
  if (!["status", "run", "reconcile"].includes(mode))
    throw Error("Choose status, run or reconcile");
  if (
    mode === "run" &&
    (!process.argv.includes("--execute") || !process.argv.includes("--manual-fixture"))
  )
    throw Error("Explicit --execute --manual-fixture required");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw Error("Verified owner required");
  const lot = readRecordedReturnLot(owner, true, false);
  if (lot.status !== "PARKED") throw Error("Verified new PARK cycle required");
  const runs = new ReturnRunStore("artifacts/testnet-return-runs.sqlite");
  try {
    if (runs.get(lot.cycleId)) throw Error("Do not run a price fixture concurrently with RETURN");
  } finally {
    runs.close();
  }
  const repark = new TestnetDepositStore("artifacts/testnet-repark.sqlite");
  let parent: ReparkProof;
  try {
    const anchor = readReparkAnchor(readOriginalReturnLot(owner)),
      row = repark.get(reparkIntent(anchor, "supply"));
    if (row?.status !== "CONFIRMED") throw Error("Confirmed re-PARK supply required");
    parent = decodeRun(row.evidence!);
  } finally {
    repark.close();
  }
  const client = testnetReturnClient(),
    receipt = await client.getTransactionReceipt({ hash: lot.cycleId });
  if (
    parent.transactionHash !== lot.cycleId ||
    parent.amount !== lot.principal ||
    receipt.status !== "success" ||
    receipt.blockHash !== parent.after.snapshot.position.block.hash
  )
    throw Error("Fixture parent allocation changed");
  const tx = await client.getTransaction({ hash: lot.cycleId });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    owner,
    parent.baseline.call,
    parent.sponsored,
  );
  if (
    parent.sponsored &&
    (await client.getCode({ address: owner, blockNumber: receipt.blockNumber }))?.toLowerCase() !==
      `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw Error("Parent delegate changed");
  db = new TestnetDepositStore("artifacts/testnet-price-fixture.sqlite");
  if (mode === "status") {
    const state = await readFixtureState(client, lot),
      started = FIXTURE_STEPS.some((id) => db!.get(fixtureIntent(lot, id)));
    const minimumOut = started ? null : await quoteFixture(client, state);
    if (!started) buildFixtureCall("mint-test-usdc", lot, state, Math.floor(Date.now() / 1000));
    const report = {
      mode: "READ_ONLY_TEST_PRICE_FIXTURE",
      lot,
      state,
      budgetUsdc: FIXTURE_USDC,
      targetTick: FIXTURE_TICK,
      quotedMinimumWeth: minimumOut,
      steps: FIXTURE_STEPS.map((id) => ({
        id,
        status: db!.get(fixtureIntent(lot, id))?.status ?? "NOT_STARTED",
      })),
      transactions: [],
    };
    await writeFile("artifacts/testnet-price-fixture-readiness.json", json(report));
    console.log(
      json({
        mode: report.mode,
        spot: state.snapshot.position.currentTick,
        target: FIXTURE_TICK,
        budget: FIXTURE_USDC,
        minimumOut,
        steps: report.steps,
      }),
    );
    return;
  }
  const key = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
  if (!key) throw Error("Testnet credential required");
  for (const id of FIXTURE_STEPS) {
    if (!db.get(fixtureIntent(lot, id))) {
      if (mode === "reconcile") break;
      await submitFixtureStep({ client, lot, id, store: db, apiKey: key, manualFixture: true });
    }
    const proof = await pollReturnReceipt(() => reconcileFixtureStep(client, lot, id, db!, key));
    console.log(
      json({
        id,
        transaction: proof.explorerUrl,
        executionId: proof.executionId,
        spot: proof.after.snapshot.position.currentTick,
      }),
    );
    const proofs = FIXTURE_STEPS.map((step) => db!.get(fixtureIntent(lot, step)))
      .filter((row) => row?.status === "CONFIRMED")
      .map((row) => decodeRun<FixtureProof>(row!.evidence!));
    await writeFile(
      "artifacts/testnet-price-fixture.json",
      json({
        mode: "MANUAL_BASE_SEPOLIA_PRICE_FIXTURE",
        keeperhubExecution: true,
        syntheticMarketIntervention: true,
        profitabilityClaim: false,
        lot,
        budgetUsdc: FIXTURE_USDC,
        targetTick: FIXTURE_TICK,
        steps: proofs,
        complete: proofs.length === 4,
      }),
    );
  }
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message.split("\n")[0] : "Fixture stopped");
    process.exitCode = 1;
  })
  .finally(() => db?.close());
