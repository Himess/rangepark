import { hash } from "../core/serialization.js";
import {
  decodeHostedObservation,
  HostedReturnMonitorStore,
} from "../state/hosted-return-monitor.js";
import {
  decideReturn,
  defaultReturnPolicy,
  observeReturn,
  type ParkedLot,
  type ReturnEconomics,
  type ReturnSnapshot,
} from "./return-policy.js";

export async function authorizedMonitorRequest(header: string | null, secret: string | undefined) {
  if (!secret || !/^[a-f0-9]{64}$/.test(secret) || !header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(supplied), digest(secret)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

export async function hostedReturnTick(d: {
  store: HostedReturnMonitorStore;
  lot: ParkedLot;
  snapshot: () => Promise<ReturnSnapshot>;
  economics: (s: ReturnSnapshot) => Promise<{ quote: ReturnEconomics; evidence: unknown }>;
  blockHash: (number: bigint) => Promise<string>;
  clock: () => number;
}) {
  const startedAt = d.clock(),
    owner = crypto.randomUUID();
  if (!(await d.store.acquire(owner, startedAt)))
    return { status: "SKIPPED", reason: "ALREADY_CLAIMED_MINUTE", broadcasts: 0 };
  const row = await d.store.get();
  if (!row || row.lease_owner !== owner) throw Error("Hosted monitor lease lost");
  const previous = decodeHostedObservation(row);
  let stage = "SNAPSHOT";
  let sourceBlock: ReturnSnapshot["position"]["block"] | null = null;
  let observation = previous;
  let report: Record<string, unknown>;
  try {
    const snapshot = await d.snapshot();
    sourceBlock = snapshot.position.block;
    if (hash(snapshot.lot) !== hash(d.lot)) throw Error("Allocation mismatch");
    stage = "ECONOMICS";
    let economics: ReturnEconomics | null = null,
      economicsEvidence: unknown = null;
    let unavailable = false;
    try {
      const result = await d.economics(snapshot);
      economics = result.quote;
      economicsEvidence = result.evidence;
    } catch {
      unavailable = true;
    }
    stage = "REVALIDATE";
    // Let the HTTP transport batch both canonicality reads in one round trip.
    const [previousHash, sourceHash] = await Promise.all([
      previous ? d.blockHash(previous.block.number) : Promise.resolve(null),
      d.blockHash(snapshot.position.block.number),
    ]);
    const canonical = !previous || previousHash === previous.block.hash;
    if (sourceHash !== snapshot.position.block.hash)
      throw Error("Reorg");
    const now = d.clock();
    if (now < snapshot.position.block.timestamp || now - snapshot.position.block.timestamp >= 60)
      throw Error("Expired snapshot");
    stage = "OBSERVATION";
    observation = observeReturn(snapshot, defaultReturnPolicy, previous, now, canonical);
    stage = "DECISION";
    const decision = decideReturn({
      ...snapshot,
      policy: defaultReturnPolicy,
      observation,
      economics,
      now,
    });
    report = {
      status: unavailable ? "DEGRADED" : "OBSERVED",
      startedAt,
      completedAt: now,
      snapshot,
      observation,
      economics,
      economicsEvidence,
      decision,
      errors: unavailable ? ["ECONOMICS_UNAVAILABLE"] : [],
      broadcasts: 0,
    };
  } catch (error) {
    observation = previous;
    const message = error instanceof Error ? error.message : "";
    const failureReason = /Too many (subrequests|API requests)/i.test(message) ? "RPC_SUBREQUEST_LIMIT"
      : /rate limit|rate.limit.exceeded/i.test(message) ? "RPC_RATE_LIMIT"
      : /different request|Cannot perform I\/O/i.test(message) ? "RPC_REQUEST_CONTEXT"
      : /block.+could not be found/i.test(message) ? "RPC_BLOCK_NOT_FOUND"
      : message === "Reorg" ? "SOURCE_BLOCK_CHANGED"
      : message === "Expired snapshot" ? "SNAPSHOT_TIME_INVALID"
      : message === "Allocation mismatch" ? "ALLOCATION_CHANGED" : "READ_FAILED";
    const knownErrors = ["TypeError", "RangeError", "HttpRequestError", "RpcRequestError", "TimeoutError", "UnknownRpcError", "BlockNotFoundError", "InternalRpcError", "LimitExceededRpcError", "InvalidInputRpcError", "ResourceUnavailableRpcError"];
    const failureType = error instanceof Error && knownErrors.includes(error.name) ? error.name : "Error";
    report = {
      status: "DEGRADED",
      startedAt,
      completedAt: d.clock(),
      decision: null,
      economics: null,
      errors: [`${stage}_FAILED`],
      failureReason,
      failureType,
      sourceBlock,
      broadcasts: 0,
    };
  }
  const recent = JSON.parse(row.recent) as unknown[];
  recent.push({
    status: report.status,
    at: report.completedAt,
    decision: report.decision,
    errors: report.errors,
  });
  await d.store.complete(owner, d.clock(), observation, report, recent);
  return report;
}
