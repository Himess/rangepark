import { isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { toKeeperHubRequest, type ContractCall } from "./plan.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const simulationSchema = z.object({
  success: z.literal(true),
  status: z.literal("simulated"),
  wouldRevert: z.literal(false),
  from: address,
  to: address,
  value: z.literal("0"),
  gasEstimate: z.string().regex(/^[0-9]+$/),
  simulatedReturnValue: z.unknown().optional(),
});

export class KeeperHubError extends Error {
  constructor(
    readonly status: number,
    readonly details: unknown,
  ) {
    super(
      `KeeperHub preflight failed (HTTP ${status}); inspect structured details`,
    );
  }
}

// This client has no broadcast method. Simulate is always the boolean true.
export class KeeperHubClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error("KEEPERHUB_API_KEY is required");
  }

  async simulate(step: ContractCall, expectedSender: Address) {
    const response = await this.fetcher(
      "https://app.keeperhub.com/api/execute/contract-call",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...toKeeperHubRequest(step), simulate: true }),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) throw new KeeperHubError(response.status, body);
    const result = simulationSchema.parse(body);
    if (
      !isAddressEqual(result.from as Address, expectedSender) ||
      !isAddressEqual(result.to as Address, step.contractAddress)
    ) {
      throw new Error("Simulation sender/target mismatch");
    }
    return result;
  }
}
