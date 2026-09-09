import { encodeFunctionData, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { aavePoolAbi } from "../chain/abis.js";
import { hash, json } from "../core/serialization.js";
import { BASE_SEPOLIA as config } from "./config.js";
import { decideReturn, type ReturnDecisionInput } from "./return-policy.js";

export function buildReturnWithdrawDraft(input: ReturnDecisionInput) {
  const decision = decideReturn(input);
  if (decision.action !== "RETURN" || input.now >= decision.expiresAt)
    throw new Error(`RETURN blocked: ${decision.reasons.join(", ")}`);
  const args = [input.lot.asset, input.lot.principal, input.lot.owner] as const;
  const body = {
    mode: "REVIEW_ONLY" as const,
    chainId: 84532 as const,
    phase: "WITHDRAW" as const,
    cycleId: input.lot.cycleId,
    tokenId: input.lot.tokenId,
    decisionHash: decision.decisionHash,
    observedBlock: input.position.block,
    createdAt: input.now,
    expiresAt: decision.expiresAt,
    request: {
      chainId: 84532 as const,
      contractAddress: config.aavePool,
      functionName: "withdraw",
      functionArgs: json(args),
      abi: JSON.stringify(aavePoolAbi),
      value: "0" as const,
    },
    calldata: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args }),
    requiredNextStage:
      "Confirm withdrawal delta, then build a fresh swap and same-NFT increase plan",
  };
  return { ...body, planHash: hash(body) };
}

// Read-scope only. No broadcast method exists in this module.
export async function preflightReturnWithdrawal(
  input: ReturnDecisionInput,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  clock: () => number = () => Math.floor(Date.now() / 1000),
) {
  const now = clock();
  const plan = buildReturnWithdrawDraft({ ...input, now });
  if (!apiKey.trim()) throw new Error("Read-only KeeperHub credential required");
  const response = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...plan.request, simulate: true }),
  });
  if (!response.ok) throw new Error(`RETURN simulation HTTP ${response.status}`);
  const result = z
    .object({
      success: z.literal(true),
      status: z.literal("simulated"),
      wouldRevert: z.literal(false),
      from: z.string(),
      to: z.string(),
      value: z.literal("0"),
      simulatedReturnValue: z.literal(input.lot.principal.toString()),
      gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
    })
    .parse(await response.json());
  if (
    !isAddressEqual(result.from as Address, input.lot.owner) ||
    !isAddressEqual(result.to as Address, config.aavePool)
  )
    throw new Error("RETURN simulation sender/target mismatch");
  const completedAt = clock();
  if (completedAt < now || completedAt >= plan.expiresAt)
    throw new Error("RETURN preflight expired; refresh all inputs");
  return {
    mode: "SIMULATION_ONLY" as const,
    broadcastEnabled: false as const,
    plan,
    simulation: result,
    completedAt,
    transactions: [],
  };
}
