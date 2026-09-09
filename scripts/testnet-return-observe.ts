import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { decideReturn, defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { readRecordedReturnLot, readReturnEconomics } from "../src/testnet/return-context.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { json } from "../src/core/serialization.js";
import { buildReturnWithdrawDraft, preflightReturnWithdrawal } from "../src/testnet/return-plan.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let history: ReturnObservationStore | undefined;
try {
  const mode = process.argv[2] ?? "observe";
  if (mode !== "observe" && mode !== "preflight")
    throw new Error("Choose observe or preflight; neither broadcasts");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified testnet owner required");
  const lot = readRecordedReturnLot(owner);
  const economics = await readReturnEconomics();
  const policy = defaultReturnPolicy,
    client = testnetReturnClient();
  const snapshot = await readReturnSnapshot(client, lot, policy);
  history = new ReturnObservationStore("artifacts/testnet-return-observations.sqlite");
  const previous = history.get(lot.cycleId);
  const previousIsCanonical =
    !previous ||
    (await client.getBlock({ blockNumber: previous.block.number })).hash === previous.block.hash;
  const now = Math.floor(Date.now() / 1000);
  const observation = history.record(snapshot, policy, now, previous, previousIsCanonical);
  const decision = decideReturn({ ...snapshot, observation, policy, economics, now });
  const withdrawalDraft =
    decision.action === "RETURN"
      ? buildReturnWithdrawDraft({ ...snapshot, observation, policy, economics, now })
      : null;
  const preflight =
    mode === "preflight" && withdrawalDraft
      ? await preflightReturnWithdrawal(
          { ...snapshot, observation, policy, economics, now },
          process.env.KEEPERHUB_API_KEY ?? "",
        )
      : null;
  const report = {
    mode: "BASE_SEPOLIA_RETURN_POLICY_READ_ONLY",
    broadcastEnabled: false,
    snapshot,
    observation,
    previousIsCanonical,
    policy,
    economics,
    decision,
    withdrawalDraft,
    preflight,
    remainingExecutionGates: [
      "Live fee/cost estimate and eligible parked cycle",
      "Public testnet validation of the staged RETURN runner",
    ],
    transactions: [],
  };
  await writeFile("artifacts/testnet-return-observation.json", json(report));
  console.log(
    json({
      mode: report.mode,
      broadcastEnabled: false,
      tokenId: lot.tokenId,
      lotStatus: lot.status,
      spot: snapshot.position.currentTick,
      twap: snapshot.position.twapTick,
      observation,
      decision,
      withdrawalDraft,
      preflight,
      transactions: [],
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message.split("\n")[0] : "RETURN observation failed",
  );
  process.exitCode = 1;
} finally {
  history?.close();
}
