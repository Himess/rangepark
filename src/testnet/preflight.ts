import { isAddress, isAddressEqual, parseAbi, type Address } from "viem";
import { z } from "zod";
import { BASE_SEPOLIA, requireTestnetChain } from "./config.js";

export const TEST_DEPOSIT_WEI = 1_000_000_000_000_000n;
const depositAbi = parseAbi(["function deposit() payable"]);

// A fixed first step: wrap 0.001 test ETH in the existing organization's wallet.
// There is deliberately no broadcast method or caller-supplied transaction body.
export function testnetDepositRequest() {
  return {
    chainId: BASE_SEPOLIA.chainId,
    contractAddress: BASE_SEPOLIA.weth,
    functionName: "deposit",
    functionArgs: "[]",
    abi: JSON.stringify(depositAbi),
    value: "0.001",
    simulate: true as const,
  };
}

const address = z.string().refine(isAddress);
const simulation = z.object({
  success: z.literal(true),
  status: z.literal("simulated"),
  wouldRevert: z.literal(false),
  from: address,
  to: address,
  value: z.string(),
  gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
});

export async function simulateTestnetDeposit(
  apiKey: string,
  owner: Address,
  rpcChainId: number,
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(rpcChainId);
  if (!isAddress(owner) || !apiKey.trim())
    throw new Error("Verified wallet and API key required");
  const request = testnetDepositRequest();
  const response = await fetcher(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok)
    throw new Error(
      `Testnet simulation failed (HTTP ${response.status}); no broadcast attempted`,
    );
  const result = simulation.parse(await response.json());
  // KeeperHub's envelope reports value in wei, while its request uses ETH.
  if (
    !isAddressEqual(result.from as Address, owner) ||
    !isAddressEqual(result.to as Address, request.contractAddress) ||
    result.value !== TEST_DEPOSIT_WEI.toString()
  ) {
    throw new Error("Testnet simulation sender/target/value mismatch");
  }
  return {
    mode: "KEEPERHUB_TESTNET_SIMULATION_ONLY",
    request,
    result,
    transactions: [],
  };
}
