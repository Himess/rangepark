import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { readRecordedReturnLot } from "../src/testnet/return-context.js";
import { testnetReturnClient } from "../src/testnet/return-reader.js";
import { defaultReturnPolicy } from "../src/testnet/return-policy.js";
import {
  buildOracleSetup,
  oracleSetupIntent,
  reconcileOracleSetup,
  readOracleSetupState,
  submitOracleSetup,
} from "../src/testnet/oracle-setup.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let db: TestnetDepositStore | undefined;
async function main() {
  const mode = process.argv[2] ?? "status";
  if (!["status", "submit", "reconcile"].includes(mode))
    throw new Error("Choose status, submit or reconcile");
  if (mode === "submit" && !process.argv.includes("--execute"))
    throw new Error("Explicit testnet --execute required");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified KeeperHub owner required");
  const lot = readRecordedReturnLot(owner),
    client = testnetReturnClient();
  db = new TestnetDepositStore("artifacts/testnet-oracle-setup.sqlite");
  if (mode === "status") {
    const state = await readOracleSetupState(client, lot, defaultReturnPolicy);
    const report = {
      mode: "BASE_SEPOLIA_ORACLE_READ_ONLY",
      pool: lot.pool,
      oracle: state.snapshot.oracle,
      block: state.snapshot.position.block,
      originalNft: lot.tokenId,
      runStatus: db.get(oracleSetupIntent(owner, lot.pool))?.status ?? "NOT_STARTED",
      draft:
        state.snapshot.oracle.cardinalityNext < 16
          ? buildOracleSetup(state, Math.floor(Date.now() / 1000))
          : null,
      transactions: [],
    };
    await writeFile("artifacts/testnet-oracle-readiness.json", json(report));
    console.log(json(report));
    return;
  }
  const key = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
  if (!key) throw new Error("Testnet write credential required");
  if (mode === "submit") {
    const result = await submitOracleSetup({ client, lot, store: db, apiKey: key });
    console.log(json({ executionId: result.executionId, status: result.status }));
  }
  const proof = await reconcileOracleSetup(client, lot, db, key);
  await writeFile("artifacts/testnet-oracle-setup.json", json(proof));
  console.log(json(proof));
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message.split("\n")[0] : "Oracle setup stopped");
    process.exitCode = 1;
  })
  .finally(() => db?.close());
