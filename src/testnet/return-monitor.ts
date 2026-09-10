import { hash } from "../core/serialization.js";
import { ReturnObservationStore } from "../state/return-observations.js";
import {
  decideReturn,
  defaultReturnPolicy,
  type ParkedLot,
  type ReturnEconomics,
  type ReturnSnapshot,
} from "./return-policy.js";

export type MonitorReport = {
  mode: "READ_ONLY_RETURN_MONITOR";
  status: "DEGRADED" | "OBSERVED";
  startedAt: number;
  completedAt: number;
  broadcasts: 0;
  snapshot?: ReturnSnapshot;
  observation?: ReturnType<ReturnObservationStore["record"]>;
  economics: ReturnEconomics | null;
  economicsEvidence?: unknown;
  decision: ReturnType<typeof decideReturn> | null;
  errors: string[];
};

export type MonitorDependencies = {
  lot: () => ParkedLot;
  snapshot: (lot: ParkedLot) => Promise<ReturnSnapshot>;
  economics: (snapshot: ReturnSnapshot) => Promise<{ quote: ReturnEconomics; evidence: unknown }>;
  blockHash: (number: bigint) => Promise<string>;
  clock: () => number;
  history: ReturnObservationStore;
  commit: (now: number, report: () => MonitorReport) => MonitorReport;
};

// No signer, KeeperHub client, simulation, or broadcast capability is accepted here.
export async function monitorReturnOnce(d: MonitorDependencies) {
  const startedAt = d.clock();
  let stage = "SNAPSHOT";
  try {
    const lot = d.lot(),
      snapshot = await d.snapshot(lot);
    stage = "ECONOMICS";
    let economics: ReturnEconomics | null = null,
      evidence: unknown = null;
    let economicsUnavailable = false;
    try {
      const result = await d.economics(snapshot);
      economics = result.quote;
      evidence = result.evidence;
    } catch {
      economicsUnavailable = true;
    }
    stage = "REVALIDATE";
    if (hash(lot) !== hash(d.lot()) || hash(lot) !== hash(snapshot.lot))
      throw Error("Allocation changed");
    const previous = d.history.get(lot.cycleId);
    const previousIsCanonical =
      !previous || (await d.blockHash(previous.block.number)) === previous.block.hash;
    if ((await d.blockHash(snapshot.position.block.number)) !== snapshot.position.block.hash)
      throw Error("Source block changed");
    const now = d.clock();
    if (
      now < snapshot.position.block.timestamp ||
      now - snapshot.position.block.timestamp >= defaultReturnPolicy.maxAgeSeconds
    )
      throw Error("Snapshot expired");
    stage = "COMMIT";
    return d.commit(now, () => {
      const observation = d.history.record(
        snapshot,
        defaultReturnPolicy,
        now,
        previous,
        previousIsCanonical,
      );
      const decision = decideReturn({
        ...snapshot,
        policy: defaultReturnPolicy,
        observation,
        economics,
        now,
      });
      return {
        mode: "READ_ONLY_RETURN_MONITOR",
        status: economicsUnavailable ? "DEGRADED" : "OBSERVED",
        startedAt,
        completedAt: now,
        broadcasts: 0,
        snapshot,
        observation,
        economics,
        economicsEvidence: evidence,
        decision,
        errors: economicsUnavailable ? ["ECONOMICS_UNAVAILABLE"] : [],
      };
    });
  } catch {
    // Do not retain an earlier RETURN decision or leak RPC URLs/headers in errors.
    const now = d.clock();
    return d.commit(now, () => ({
      mode: "READ_ONLY_RETURN_MONITOR",
      status: "DEGRADED",
      startedAt,
      completedAt: now,
      broadcasts: 0,
      decision: null,
      economics: null,
      errors: [`${stage}_FAILED`],
    }));
  }
}

export async function runMonitorLoop(args: {
  tick: () => Promise<unknown>;
  signal: AbortSignal;
  maxSamples?: number;
  intervalMs?: number;
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const interval = args.intervalMs ?? 60000,
    limit = args.maxSamples ?? Infinity;
  if (!Number.isInteger(interval) || interval < 60000 || interval > 90000)
    throw Error("Monitor interval must be 60–90 seconds");
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1 || limit > 1440))
    throw Error("Sample limit must be 1–1440");
  const clock = args.clock ?? Date.now;
  const sleep =
    args.sleep ??
    ((ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      }));
  for (let count = 0; !args.signal.aborted && count < limit; count++) {
    const started = clock();
    await args.tick();
    if (count + 1 >= limit || args.signal.aborted) break;
    // Never overlap or catch up missed ticks with a burst of RPC calls.
    await sleep(Math.max(1000, interval - (clock() - started)), args.signal);
  }
}
