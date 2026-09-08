import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  slice,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { requireTestnetChain, BASE_SEPOLIA as config } from "./config.js";
import { TestnetDepositStore, executionResponseSchema } from "./execution.js";
import { gasStationAbi, TESTNET_GAS_STATION } from "./receipt.js";
import {
  PARK_STEPS,
  validateParkStep,
  type ParkStepId,
  type TestnetStep,
} from "./park-plan.js";

export function parkIntent(owner: Address, id: ParkStepId) {
  return createHash("sha256")
    .update(`rangepark-sepolia-park-v1|84532|${owner.toLowerCase()}|${id}`)
    .digest("hex");
}
export function checkStepDependencies(
  store: TestnetDepositStore,
  owner: Address,
  id: ParkStepId,
) {
  const index = PARK_STEPS.indexOf(id);
  if (index < 0) throw new Error("Unknown rehearsal step");
  for (const prior of PARK_STEPS.slice(0, index))
    if (store.get(parkIntent(owner, prior))?.status !== "CONFIRMED")
      throw new Error(`Reconcile ${prior} before ${id}`);
}
const simulated = z.object({
  success: z.literal(true),
  status: z.literal("simulated"),
  wouldRevert: z.literal(false),
  from: z.string(),
  to: z.string(),
  value: z.literal("0"),
  gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
});

export async function submitParkStep(
  args: {
    step: TestnetStep;
    owner: Address;
    chainId: number;
    apiKey: string;
    baseline: string;
    store: TestnetDepositStore;
  },
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(args.chainId);
  requireTestnetChain(args.step.request.chainId);
  validateParkStep(args.step, args.owner);
  checkStepDependencies(args.store, args.owner, args.step.id);
  const intent = parkIntent(args.owner, args.step.id);
  if (args.store.get(intent))
    throw new Error("Step already started; only reconcile, never resend");
  // Snapshot and bind the body before the simulation. Never reconstruct it after a write.
  const request = JSON.stringify(args.step.request);
  const body = JSON.parse(request) as TestnetStep["request"];
  if (
    body.value !== "0" ||
    ![config.weth, config.positionManager, config.aavePool].some((a) =>
      isAddressEqual(a, body.contractAddress),
    )
  )
    throw new Error("Unsupported testnet target/value");
  const calldata = encodeFunctionData({
    abi: JSON.parse(body.abi) as Abi,
    functionName: body.functionName,
    args: JSON.parse(body.functionArgs),
  });
  if (calldata !== args.step.calldata)
    throw new Error("Calldata differs from frozen request");
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
      body: JSON.stringify({ ...body, simulate: true }),
    },
  );
  const raw: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      `KeeperHub simulation HTTP ${response.status}: ${JSON.stringify(raw)}`,
    );
  const proof = simulated.parse(raw);
  if (
    !isAddressEqual(proof.from as Address, args.owner) ||
    !isAddressEqual(proof.to as Address, body.contractAddress)
  )
    throw new Error("Simulation signer/target mismatch");
  // Check again after the asynchronous simulation so a competing process cannot skip dependencies.
  checkStepDependencies(args.store, args.owner, args.step.id);
  args.store.claim(intent, request, args.baseline);
  const write = await fetcher(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: { ...headers, "Idempotency-Key": intent },
      body: request,
    },
  );
  const result: unknown = await write.json();
  args.store.recordResponse(intent, { httpStatus: write.status, body: result });
  if (!write.ok)
    throw new Error(
      `KeeperHub submission HTTP ${write.status}; reconcile without resending`,
    );
  return executionResponseSchema.parse(result);
}

export function verifyParkTransaction(
  tx: {
    chainId?: number;
    from: Address;
    to: Address | null;
    input: Hex;
    value: bigint;
  },
  owner: Address,
  step: TestnetStep,
  sponsored: boolean,
) {
  requireTestnetChain(tx.chainId ?? 0);
  requireTestnetChain(step.request.chainId);
  if (!tx.to || tx.value !== 0n)
    throw new Error("Unexpected testnet transaction value/target");
  if (!sponsored) {
    if (
      !isAddressEqual(tx.from, owner) ||
      !isAddressEqual(tx.to, step.request.contractAddress) ||
      tx.input !== step.calldata
    )
      throw new Error("Direct testnet calldata mismatch");
    return;
  }
  if (!isAddressEqual(tx.to, TESTNET_GAS_STATION))
    throw new Error("Unsupported relay");
  const {
    args: [sender, target, value, data],
  } = decodeFunctionData({ abi: gasStationAbi, data: tx.input });
  if (
    !isAddressEqual(sender, owner) ||
    !isAddressEqual(target, step.request.contractAddress) ||
    value !== 0n ||
    data.length !== 170 + step.calldata.length ||
    slice(data, 85) !== step.calldata
  )
    throw new Error("Sponsored testnet inner call mismatch");
}
