import { existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { json } from "../src/core/serialization.js";
import { ReturnMonitorStore } from "../src/state/return-monitor.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { readRecordedReturnLot } from "../src/testnet/return-context.js";
import { readEconomicsEvidence } from "../src/testnet/return-economics.js";
import { readFixtureExclusions } from "../src/testnet/return-economics-input.js";
import { monitorReturnOnce, runMonitorLoop } from "../src/testnet/return-monitor.js";
import { defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";

if (existsSync(".env")) process.loadEnvFile(".env");
async function main() {
  const [mode = "watch", option, value, ...rest] = process.argv.slice(2);
  if (
    !["watch", "once", "status"].includes(mode) ||
    rest.length ||
    (option !== undefined && (mode !== "watch" || option !== "--samples" || value === undefined))
  )
    throw Error("Use once, status, or watch [--samples 1–1440]");
  const maxSamples = mode === "once" ? 1 : value === undefined ? undefined : Number(value);
  if (
    maxSamples !== undefined &&
    (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 1440)
  )
    throw Error("Invalid sample limit");
  const store = new ReturnMonitorStore("artifacts/testnet-return-monitor.sqlite");
  const clock = () => Math.floor(Date.now() / 1000),
    runId = randomUUID();
  if (mode === "status") {
    try {
      const record = store.read();
      console.log(
        json({
          record,
          ageSeconds: record ? clock() - record.updatedAt : null,
          historicalOnly: true,
          broadcasts: 0,
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
  let history: ReturnObservationStore | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();
  let leaseFailed = false,
    acquired = false;
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
    if (!owner || !isAddress(owner)) throw Error("Verified testnet owner required");
    store.acquire(runId, clock());
    acquired = true;
    heartbeat = setInterval(() => {
      try {
        store.renew(runId, clock());
      } catch {
        leaseFailed = true;
        abort.abort();
      }
    }, 30000);
    const client = testnetReturnClient();
    history = new ReturnObservationStore("artifacts/testnet-return-observations.sqlite");
    const observationStore = history;
    let completed = 0;
    await runMonitorLoop({
      signal: abort.signal,
      maxSamples,
      tick: async () => {
        const report = await monitorReturnOnce({
          lot: () => readRecordedReturnLot(owner),
          snapshot: (lot) => readReturnSnapshot(client, lot, defaultReturnPolicy),
          economics: async (snapshot) =>
            readEconomicsEvidence(
              client,
              snapshot,
              defaultReturnPolicy,
              await readFixtureExclusions(),
            ),
          blockHash: async (number) => (await client.getBlock({ blockNumber: number })).hash,
          clock,
          history: observationStore,
          commit: (now, make) => {
            if (abort.signal.aborted) throw Error("Monitor stopping");
            return store.commit(runId, now, () => ({ ...make(), runId }));
          },
        });
        completed++;
        console.log(
          json({
            sample: completed,
            status: report.status,
            action: report.decision?.action ?? "NO_DECISION",
            reasons: report.decision?.reasons ?? report.errors,
            broadcasts: 0,
          }),
        );
      },
    });
    if (leaseFailed) throw Error("Monitor lease lost");
  } catch (e) {
    if (!abort.signal.aborted || leaseFailed) throw e;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    history?.close();
    try {
      if (acquired && !leaseFailed) {
        store.commit(
          runId,
          clock(),
          () => ({
            mode: "READ_ONLY_RETURN_MONITOR",
            status: "STOPPED",
            runId,
            decision: null,
            economics: null,
            broadcasts: 0,
          }),
          false,
        );
        const exportPath = "artifacts/testnet-return-monitor.json",
          temp = `${exportPath}.${runId}.tmp`;
        await writeFile(
          temp,
          json({
            mode: "READ_ONLY_RETURN_MONITOR_HISTORY",
            runId,
            broadcasts: 0,
            stoppedAt: clock(),
            samples: store.samples(),
            status: store.read(),
            notice: "Historical observations, not a live service or reusable execution approval",
          }),
        );
        await rename(temp, exportPath);
      }
    } finally {
      if (acquired) store.release(runId);
      store.close();
    }
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error && error.message === "Another RETURN monitor holds the lease"
      ? "Another RETURN monitor is running; this process stopped without changing its status."
      : "RETURN monitor stopped: invalid configuration, unavailable journal, or lost lease. No broadcasts. Inspect local monitor status.",
  );
  process.exitCode = 1;
});
