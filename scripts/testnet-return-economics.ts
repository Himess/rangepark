import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { readRecordedReturnLot } from "../src/testnet/return-context.js";
import { defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";
import { readEconomicsEvidence } from "../src/testnet/return-economics.js";

if (existsSync(".env")) process.loadEnvFile(".env");
async function main() {
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw Error("Verified testnet owner required");
  const lot = readRecordedReturnLot(owner),
    client = testnetReturnClient(),
    policy = defaultReturnPolicy;
  const excludedHashes = new Set<string>();
  const path = existsSync("artifacts/testnet-price-fixture.json")
    ? "artifacts/testnet-price-fixture.json"
    : "docs/evidence/testnet-price-fixture.json";
  if (existsSync(path)) {
    const fixture = JSON.parse(await readFile(path, "utf8")) as {
      syntheticMarketIntervention?: boolean;
      steps?: { transactionHash: string }[];
    };
    if (fixture.syntheticMarketIntervention !== true || !Array.isArray(fixture.steps))
      throw Error("Expected explicit fixture exclusion evidence");
    for (const step of fixture.steps) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(step.transactionHash)) throw Error("Invalid fixture hash");
      excludedHashes.add(step.transactionHash.toLowerCase());
    }
  }
  const snapshot = await readReturnSnapshot(client, lot, policy),
    result = await readEconomicsEvidence(client, snapshot, policy, excludedHashes);
  const report = { ...result, broadcasts: 0 };
  await writeFile("artifacts/testnet-return-economics-evidence.json", json(report));
  await writeFile("artifacts/testnet-return-economics.json.tmp", json(result.quote));
  await rename(
    "artifacts/testnet-return-economics.json.tmp",
    "artifacts/testnet-return-economics.json",
  );
  console.log(
    json({
      mode: result.evidence.mode,
      observedSeconds: result.evidence.fees.elapsed,
      activityCount: result.evidence.activityCount,
      includedBlocks: result.evidence.fees.details.filter((d) => d.reason === "INCLUDED").length,
      expectedLpFees: result.quote.expectedLpFees,
      executionBudget: result.quote.executionCost,
      cost: result.evidence.cost,
      expiresAt: result.quote.expiresAt,
      broadcasts: 0,
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message.split("\n")[0] : "Economics read stopped");
  process.exitCode = 1;
});
