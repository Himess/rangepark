import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export async function readFixtureExclusions() {
  const path = existsSync("artifacts/testnet-price-fixture.json")
    ? "artifacts/testnet-price-fixture.json"
    : "docs/evidence/testnet-price-fixture.json";
  const excluded = new Set<string>();
  if (!existsSync(path)) return excluded;
  const fixture = JSON.parse(await readFile(path, "utf8")) as {
    syntheticMarketIntervention?: boolean;
    steps?: { transactionHash: string }[];
  };
  if (fixture.syntheticMarketIntervention !== true || !Array.isArray(fixture.steps))
    throw Error("Expected explicit fixture exclusion evidence");
  for (const step of fixture.steps) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(step.transactionHash)) throw Error("Invalid fixture hash");
    excluded.add(step.transactionHash.toLowerCase());
  }
  return excluded;
}
