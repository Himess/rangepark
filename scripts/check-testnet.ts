import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { testnetReadiness } from "../src/testnet/readiness.js";
import { json } from "../src/core/serialization.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
if (!owner || !isAddress(owner))
  throw new Error("Verified KeeperHub sender required");
try {
  const report = await testnetReadiness(owner);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/testnet-readiness.json", json(report));
  console.log(json(report));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet check failed",
  );
  process.exitCode = 1;
}
