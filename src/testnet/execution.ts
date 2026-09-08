import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { requireTestnetChain } from "./config.js";
import { testnetDepositRequest } from "./preflight.js";

export type DepositRecord = {
  intent: string;
  request: string;
  baseline: string;
  response: string | null;
  evidence: string | null;
  status: string;
};

// One principal allocation per wallet. No time bucket: restarting tomorrow must
// not allocate another 0.001 ETH after KeeperHub's 24-hour replay window expires.
export function depositIntent(owner: Address, chainId: number) {
  requireTestnetChain(chainId);
  if (!isAddress(owner)) throw new Error("Invalid testnet owner");
  return createHash("sha256")
    .update(
      `rangepark-testnet-v1|${chainId}|${owner.toLowerCase()}|deposit-0.001`,
    )
    .digest("hex");
}

export class TestnetDepositStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS deposits (intent TEXT PRIMARY KEY, request TEXT NOT NULL, baseline TEXT NOT NULL, response TEXT, evidence TEXT, status TEXT NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  get(intent: string) {
    return this.db
      .prepare("SELECT * FROM deposits WHERE intent=?")
      .get(intent) as DepositRecord | undefined;
  }
  claim(intent: string, request: string, baseline: string) {
    // The committed unique insert is before the HTTP write. A competing process
    // or interrupted request can only reconcile, never broadcast again.
    this.db
      .prepare(
        "INSERT INTO deposits(intent,request,baseline,status) VALUES (?,?,?,'SUBMITTING')",
      )
      .run(intent, request, baseline);
  }
  recordResponse(intent: string, response: unknown) {
    this.db
      .prepare(
        "UPDATE deposits SET response=?,status='RECONCILE' WHERE intent=? AND status='SUBMITTING'",
      )
      .run(JSON.stringify(response), intent);
  }
  recordEvidence(intent: string, evidence: string) {
    const result = this.db
      .prepare(
        "UPDATE deposits SET evidence=?,status='CONFIRMED' WHERE intent=? AND status='RECONCILE'",
      )
      .run(evidence, intent);
    if (!result.changes)
      throw new Error("Deposit is not ready for reconciliation");
  }
}

export const executionResponseSchema = z
  .object({
    executionId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    status: z.enum([
      "completed",
      "failed",
      "unconfirmed",
      "pending",
      "running",
    ]),
    transactionHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
  })
  .passthrough();

export async function submitTestnetDepositOnce(
  args: {
    apiKey: string;
    owner: Address;
    chainId: number;
    simulationAt: number;
    baseline: string;
    store: TestnetDepositStore;
  },
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(args.chainId);
  if (!args.apiKey.trim()) throw new Error("Testnet execution key required");
  const age = Date.now() - args.simulationAt;
  if (!Number.isFinite(age) || age < 0 || age > 30000)
    throw new Error("Deposit simulation must be less than 30 seconds old");
  const intent = depositIntent(args.owner, args.chainId);
  if (args.store.get(intent))
    throw new Error(
      "Deposit already started; reconcile the existing intent, never resend",
    );
  const { simulate: _, ...body } = testnetDepositRequest();
  const request = JSON.stringify(body);
  args.store.claim(intent, request, args.baseline);
  const response = await fetcher(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": intent,
      },
      body: request,
    },
  );
  const raw: unknown = await response.json();
  args.store.recordResponse(intent, { httpStatus: response.status, body: raw });
  if (!response.ok)
    throw new Error(
      `KeeperHub submission returned HTTP ${response.status}; reconcile without resending`,
    );
  return { intent, result: executionResponseSchema.parse(raw) };
}
