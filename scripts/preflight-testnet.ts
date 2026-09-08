import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, http, isAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA } from "../src/testnet/config.js";
import { simulateTestnetDeposit } from "../src/testnet/preflight.js";
import { json } from "../src/core/serialization.js";

if (existsSync(".env")) process.loadEnvFile(".env");
try {
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  const key = process.env.KEEPERHUB_API_KEY;
  if (!owner || !isAddress(owner) || !key)
    throw new Error("Verified KeeperHub sender and API key required");
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA.rpc),
  });
  const report = await simulateTestnetDeposit(
    key,
    owner,
    await client.getChainId(),
  );
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/testnet-deposit-preflight.json",
    json({ ...report, checkedAt: new Date().toISOString() }),
  );
  console.log(json(report));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet preflight failed",
  );
  process.exitCode = 1;
}
