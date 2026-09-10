import { z } from "zod";

export class ExecutionReceiptPending extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ExecutionReceiptPending";
    if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0))
      throw new Error("Invalid pending receipt interval");
  }
}

// KeeperHub specifies seconds; zero identifies a terminal execution. Unknown
// status names remain pending. A terminal label never replaces receipt proof.
export function verifiedTestnetExecution(raw: unknown, executionId: string, headers: Headers) {
  const envelope = z
    .object({ executionId: z.literal(executionId), status: z.string().optional() })
    .parse(raw);
  const hint = headers.get("X-Poll-Interval-Hint")?.trim();
  let retryAfterMs: number | undefined;
  if (hint && /^\d+(?:\.\d+)?$/.test(hint)) {
    retryAfterMs = Math.ceil(Number(hint) * 1000);
    if (!Number.isSafeInteger(retryAfterMs))
      throw new Error("Invalid KeeperHub poll interval; reconcile only");
  }
  if (envelope.status === "failed") throw new Error("KeeperHub execution failed; no retry");
  if (retryAfterMs !== 0 && (retryAfterMs !== undefined || envelope.status !== "completed"))
    throw new ExecutionReceiptPending(
      "KeeperHub execution pending; check the same execution",
      retryAfterMs,
    );
  const status = z
    .object({
      executionId: z.literal(executionId),
      sponsored: z.boolean(),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      receipts: z.array(
        z.object({
          hash: z.string(),
          chainId: z.number(),
          verified: z.boolean(),
          receiptStatus: z.string(),
        }),
      ),
    })
    .parse(raw);
  const matching = status.receipts.filter(
    (r) => r.hash.toLowerCase() === status.transactionHash.toLowerCase() && r.chainId === 84532,
  );
  if (matching.some((r) => r.verified && r.receiptStatus !== "success"))
    throw new Error("KeeperHub receipt failed verification; no retry");
  if (!matching.some((r) => r.verified && r.receiptStatus === "success"))
    throw new Error("Terminal execution lacks a verified testnet receipt; reconcile only");
  return status;
}
