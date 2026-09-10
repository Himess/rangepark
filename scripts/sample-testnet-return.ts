import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { readRecordedReturnLot, readReturnEconomics } from "../src/testnet/return-context.js";
import { decideReturn, defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";

// Bounded foreground evidence collection. No broadcast path or persistent scheduler.
if (existsSync(".env")) process.loadEnvFile(".env");
const count = Number(process.argv[2] ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 12) throw Error("Sample count must be 1–12");
const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
if (!owner || !isAddress(owner)) throw Error("Verified owner required");
const client = testnetReturnClient(),
  policy = defaultReturnPolicy,
  lot = readRecordedReturnLot(owner);
const db = new ReturnObservationStore("artifacts/testnet-return-observations.sqlite"),
  samples = [];
try {
  for (let i = 0; i < count; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 60000));
    const current = readRecordedReturnLot(owner);
    if (current.cycleId !== lot.cycleId || current.status !== "PARKED")
      throw Error("Observed allocation changed");
    const snapshot = await readReturnSnapshot(client, current, policy),
      previous = db.get(lot.cycleId);
    const canonical =
      !previous ||
      (await client.getBlock({ blockNumber: previous.block.number })).hash === previous.block.hash;
    const now = Math.floor(Date.now() / 1000),
      observation = db.record(snapshot, policy, now, previous, canonical);
    const decision = decideReturn({
      ...snapshot,
      policy,
      observation,
      economics: await readReturnEconomics(),
      now,
    });
    samples.push({ snapshot, observation, decision });
    await writeFile(
      "artifacts/testnet-return-sampling.json",
      json({ mode: "BOUNDED_PUBLIC_READ_ONLY_SAMPLING", broadcasts: 0, lot, policy, samples }),
    );
    console.log(
      json({
        sample: i + 1,
        spot: snapshot.position.currentTick,
        twap: snapshot.position.twapTick,
        streakSince: observation.since,
        reasons: decision.reasons,
      }),
    );
    if (decision.reasons.every((reason) => reason === "RETURN_ECONOMICS_MISSING")) break;
  }
} finally {
  db.close();
}
