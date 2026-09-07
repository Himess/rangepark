import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { aavePoolAbi, positionManagerAbi } from "../chain/abis.js";
import { BASE } from "../config/base.js";
import { decidePark, type DecisionInput } from "../core/decision.js";
import type { PositionSnapshot } from "../core/models.js";
import { rangeSide } from "../core/range.js";
import { hash, json } from "../core/serialization.js";

export type ContractCall = {
  id: string;
  chainId: 8453;
  contractAddress: Address;
  functionName: string;
  functionArgs: string;
  abi: string;
  value: "0";
  calldata: Hex;
  dependsOn: string[];
};
export type ExecutionPlan = {
  version: 1;
  mode: "REVIEW_ONLY";
  action: "PARK" | "RETURN";
  chainId: 8453;
  sender: Address;
  positionId: string;
  createdAt: number;
  expiresAt: number;
  steps: ContractCall[];
  planHash: Hex;
};
export type ParkPlan = ExecutionPlan & {
  action: "PARK";
  decisionHash: Hex;
  policyHash: Hex;
  supplyAsset: Address;
  supplyAmount: string;
  requiredPreconditions: string[];
  residualPolicy: string;
};

export function call(
  id: ContractCall["id"],
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  dependsOn: string[],
): ContractCall {
  return {
    id,
    chainId: BASE.chainId,
    contractAddress: address,
    functionName,
    functionArgs: json(args),
    abi: json(abi),
    value: "0",
    dependsOn,
    calldata: encodeFunctionData({ abi, functionName, args }),
  };
}

export function buildReleaseCall(
  p: PositionSnapshot,
  deadline: number,
  slippageBps: number,
): ContractCall {
  const side = rangeSide(p.currentTick, p.tickLower, p.tickUpper);
  if (p.chainId !== BASE.chainId || side === "IN_RANGE" || p.liquidity <= 0n)
    throw new Error("Position cannot be released by PARK");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100)
    throw new Error("Invalid slippage");
  if (
    !Number.isSafeInteger(deadline) ||
    deadline <= p.block.timestamp ||
    deadline > p.block.timestamp + 300
  )
    throw new Error("Invalid deadline");
  const minimum0 = (p.principal0 * BigInt(10000 - slippageBps)) / 10000n;
  const minimum1 = (p.principal1 * BigInt(10000 - slippageBps)) / 10000n;
  if (minimum0 === 0n && minimum1 === 0n)
    throw new Error("No principal minimum");
  const decrease = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: p.tokenId,
        liquidity: p.liquidity,
        amount0Min: minimum0,
        amount1Min: minimum1,
        deadline: BigInt(deadline),
      },
    ],
  });
  const collect = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId: p.tokenId,
        recipient: p.owner,
        amount0Max: (1n << 128n) - 1n,
        amount1Max: (1n << 128n) - 1n,
      },
    ],
  });
  return call(
    "release",
    BASE.positionManager,
    positionManagerAbi,
    "multicall",
    [[decrease, collect]],
    [],
  );
}

export function buildParkPlan(input: DecisionInput, sender: Address): ParkPlan {
  const decision = decidePark(input);
  if (decision.action !== "PARK" || !decision.asset)
    throw new Error(`PARK refused: ${decision.reasons.join(", ")}`);
  // First iteration intentionally supports an NFT owned by the execution EOA.
  if (!isAddressEqual(sender, input.position.owner))
    throw new Error("Execution wallet must own this NFT");
  const p = input.position;
  const body: Omit<ParkPlan, "planHash"> = {
    version: 1,
    mode: "REVIEW_ONLY",
    action: "PARK",
    chainId: BASE.chainId,
    sender,
    positionId: p.tokenId.toString(),
    createdAt: decision.createdAt,
    expiresAt: decision.expiresAt,
    decisionHash: hash(decision),
    policyHash: decision.policyHash,
    supplyAsset: decision.asset,
    supplyAmount: decision.supplyAmount.toString(),
    steps: [
      buildReleaseCall(p, decision.expiresAt, input.policy.maxSlippageBps),
      call(
        "approve",
        decision.asset,
        erc20Abi,
        "approve",
        [BASE.aavePool, decision.supplyAmount],
        ["release"],
      ),
      call(
        "supply",
        BASE.aavePool,
        aavePoolAbi,
        "supply",
        [decision.asset, decision.supplyAmount, sender, 0],
        ["approve"],
      ),
    ],
    requiredPreconditions: [
      "Confirm organization uses the NFT-owner EOA, not Safe routing",
      "Re-read owner, liquidity, spot/TWAP and reserve state before submitting",
      "Recheck receipt expiry and economics with current gas/service fees",
      "Verify release receipt and underlying balance DELTA before approving/supplying",
      "Simulate each next step after its dependencies have confirmed",
      "Verify aToken balance DELTA before marking PARKED",
    ],
    residualPolicy:
      "Supply the frozen principal minimum only. Remaining principal and both fee tokens stay in the owner wallet and must be reported.",
  };
  return { ...body, planHash: hash(body) };
}

export function verifyPlan<P extends ExecutionPlan>(
  plan: P,
  now: number,
): void {
  const { planHash, ...body } = plan;
  if (hash(body) !== planHash) throw new Error("Plan hash mismatch");
  if (
    !Number.isSafeInteger(now) ||
    now < plan.createdAt ||
    now >= plan.expiresAt
  )
    throw new Error("Plan expired or not yet valid");
  if (plan.chainId !== BASE.chainId || plan.mode !== "REVIEW_ONLY")
    throw new Error("Unsupported plan");
  if (!plan.steps.length) throw new Error("Empty execution plan");
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.id) || step.dependsOn.some((id) => !seen.has(id)))
      throw new Error("Invalid step dependency order");
    seen.add(step.id);
    const encoded = encodeFunctionData({
      abi: JSON.parse(step.abi) as Abi,
      functionName: step.functionName,
      args: JSON.parse(step.functionArgs) as unknown[],
    });
    if (
      encoded !== step.calldata ||
      step.chainId !== BASE.chainId ||
      step.value !== "0"
    )
      throw new Error("Calldata does not match plan");
  }
}

export function toKeeperHubRequest(step: ContractCall) {
  return {
    chainId: step.chainId,
    contractAddress: step.contractAddress,
    functionName: step.functionName,
    functionArgs: step.functionArgs,
    abi: step.abi,
    value: step.value,
  };
}
