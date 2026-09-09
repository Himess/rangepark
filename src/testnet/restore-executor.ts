import { createHash } from "node:crypto";
import { isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { requireTestnetChain } from "./config.js";
import { TestnetDepositStore, executionResponseSchema } from "./execution.js";
import {
  buildRestoreStep,
  RESTORE_STEPS,
  type RestoreContext,
  type RestoreId,
} from "./restore-plan.js";

export function restoreIntent(owner: Address, id: RestoreId) {
  return createHash("sha256")
    .update(`rangepark-sepolia-restore-v1|84532|${owner.toLowerCase()}|${id}`)
    .digest("hex");
}
const simulation = z.object({
  success: z.literal(true),
  status: z.literal("simulated"),
  wouldRevert: z.literal(false),
  from: z.string(),
  to: z.string(),
  value: z.literal("0"),
  gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
});
export async function submitRestoreStep(
  args: {
    id: RestoreId;
    context: RestoreContext;
    chainId: number;
    apiKey: string;
    store: TestnetDepositStore;
    baseline: string;
  },
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(args.chainId);
  if (!args.apiKey.trim()) throw new Error("Execution credential required");
  const step = buildRestoreStep(args.id, args.context);
  const age = Date.now() / 1000 - args.context.now;
  if (age < -5 || age > 60) throw new Error("Restoration snapshot is stale");
  const index = RESTORE_STEPS.indexOf(args.id);
  for (const prior of RESTORE_STEPS.slice(0, index))
    if (
      args.store.get(restoreIntent(args.context.owner, prior))?.status !==
      "CONFIRMED"
    )
      throw new Error(`Reconcile ${prior} first`);
  const intent = restoreIntent(args.context.owner, args.id);
  if (args.store.get(intent))
    throw new Error("Restoration already started; reconcile, never resend");
  const body = JSON.stringify(step.request);
  const headers = {
    Authorization: `Bearer ${args.apiKey}`,
    "Content-Type": "application/json",
  };
  const response = await fetcher(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers,
      body: JSON.stringify({ ...step.request, simulate: true }),
    },
  );
  const raw: unknown = await response.json();
  if (!response.ok)
    throw new Error(`Restoration simulation HTTP ${response.status}`);
  const result = simulation.parse(raw);
  if (
    !isAddressEqual(result.from as Address, args.context.owner) ||
    !isAddressEqual(result.to as Address, step.request.contractAddress)
  )
    throw new Error("Restoration simulation sender/target mismatch");
  if (Date.now() / 1000 - args.context.now > 90)
    throw new Error("Restoration simulation expired before submission");
  args.store.claim(intent, body, args.baseline);
  const write = await fetcher(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: { ...headers, "Idempotency-Key": intent },
      body,
    },
  );
  const written: unknown = await write.json();
  args.store.recordResponse(intent, {
    httpStatus: write.status,
    body: written,
  });
  if (!write.ok)
    throw new Error(
      `Restoration submission HTTP ${write.status}; no automatic retry`,
    );
  return executionResponseSchema.parse(written);
}
