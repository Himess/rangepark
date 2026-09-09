import { Token } from "@uniswap/sdk-core";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import { encodeFunctionData, erc20Abi, type Abi, type Address, type Hex } from "viem";
import { positionManagerAbi, quoterAbi, routerAbi } from "../chain/abis.js";
import type { BlockRef } from "../core/models.js";
import { hash, json } from "../core/serialization.js";
import { BASE_SEPOLIA as config } from "./config.js";
import {
  returnPolicySchema,
  returnSnapshotReasons,
  type ReturnPolicy,
  type ReturnSnapshot,
} from "./return-policy.js";
import type { TestnetReturnClient } from "./return-reader.js";
import { buildReturnWithdrawDraft } from "./return-plan.js";
import type { ReturnDecisionInput } from "./return-policy.js";

export const RETURN_STEPS = [
  "withdraw",
  "approve-swap",
  "swap",
  "approve-lp0",
  "approve-lp1",
  "increase",
] as const;
export type ReturnStepId = (typeof RETURN_STEPS)[number];
export type ReturnCall = {
  id: ReturnStepId;
  request: {
    chainId: 84532;
    contractAddress: Address;
    abi: string;
    functionName: string;
    functionArgs: string;
    value: "0";
  };
  calldata: Hex;
};
export type AttributedCapital = { amount0: bigint; amount1: bigint };
export type StageDraft = {
  mode: "REVIEW_ONLY";
  phase: "WITHDRAW" | "SWAP" | "INCREASE";
  cycleId: Hex;
  tokenId: bigint;
  observedBlock: BlockRef;
  createdAt: number;
  expiresAt: number;
  capital: AttributedCapital;
  calls: ReturnCall[];
  amounts: {
    input: bigint;
    minimumOut: bigint;
    desired0: bigint;
    desired1: bigint;
    minimum0: bigint;
    minimum1: bigint;
  };
  planHash: Hex;
};
export function returnCall(
  id: ReturnStepId,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): ReturnCall {
  return {
    id,
    request: {
      chainId: 84532,
      contractAddress: address,
      abi: JSON.stringify(abi),
      functionName,
      functionArgs: json(args),
      value: "0",
    },
    calldata: encodeFunctionData({ abi, functionName, args }),
  };
}
export function assertReentrySnapshot(snapshot: ReturnSnapshot, policy: ReturnPolicy, now: number) {
  const validated = returnPolicySchema.parse(policy);
  const reasons = returnSnapshotReasons(snapshot, validated, now, "REENTRY");
  if (reasons.length) throw new Error(`Reentry blocked: ${reasons.join(", ")}`);
  return validated;
}
function sdkPool(
  snapshot: ReturnSnapshot,
  sqrtPrice = snapshot.position.sqrtPriceX96,
  tick = snapshot.position.currentTick,
) {
  const p = snapshot.position;
  return new Pool(
    new Token(84532, config.weth, 18),
    new Token(84532, config.aaveUsdc, 6),
    500,
    sqrtPrice.toString(),
    "0",
    tick,
  );
}
function sealStage(body: Omit<StageDraft, "planHash">): StageDraft {
  return { ...body, planHash: hash(body) };
}
export function verifyStage(draft: StageDraft, now: number) {
  const { planHash, ...body } = draft;
  if (hash(body) !== planHash) throw new Error("Stage hash mismatch");
  if (now < draft.createdAt || now >= draft.expiresAt)
    throw new Error("Stage expired; reconcile confirmed steps before replanning");
}

export function buildReturnWithdrawalStage(input: ReturnDecisionInput): StageDraft {
  const draft = buildReturnWithdrawDraft(input);
  return sealStage({
    mode: "REVIEW_ONLY",
    phase: "WITHDRAW",
    cycleId: draft.cycleId,
    tokenId: draft.tokenId,
    observedBlock: draft.observedBlock,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    capital: { amount0: 0n, amount1: 0n },
    amounts: {
      input: input.lot.principal,
      minimumOut: 0n,
      desired0: 0n,
      desired1: 0n,
      minimum0: 0n,
      minimum1: 0n,
    },
    calls: [{ id: "withdraw", request: draft.request, calldata: draft.calldata }],
  });
}

// Called only after the runner verifies the withdrawal receipt and exact principal delta.
// The only supported initial capital is the withdrawn WETH; wallet totals are never inputs.
export async function buildReturnSwapStage(
  client: Pick<TestnetReturnClient, "getChainId" | "simulateContract" | "getBlock">,
  snapshot: ReturnSnapshot,
  capital: AttributedCapital,
  policy: ReturnPolicy,
  now: number,
): Promise<StageDraft> {
  const checked = assertReentrySnapshot(snapshot, policy, now);
  if ((await client.getChainId()) !== 84532) throw new Error("Wrong quote chain");
  if (capital.amount0 !== snapshot.lot.principal || capital.amount1 !== 0n)
    throw new Error("Swap capital must equal confirmed withdrawn principal");
  const p = snapshot.position;
  const target = new Position({
    pool: sdkPool(snapshot),
    liquidity: (10n ** 18n).toString(),
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
  });
  const r0 = BigInt(target.amount0.quotient.toString()),
    r1 = BigInt(target.amount1.quotient.toString());
  const q192 = 1n << 192n,
    price = p.sqrtPriceX96 * p.sqrtPriceX96;
  // Start near the fee-adjusted spot ratio, then solve against the quoted
  // post-swap price. A spot-only ratio left substantial idle USDC in the fork.
  let candidate =
    (capital.amount0 * r1 * q192 * 1000000n) / (r1 * q192 * 1000000n + r0 * price * 999500n);
  let low = 1n,
    high = capital.amount0 - 1n;
  const lowerTick = p.tickLower + checked.edgeBufferTicks;
  const sqrtLimit = BigInt(TickMath.getSqrtRatioAtTick(lowerTick).toString());
  const upperSqrt = BigInt(
    TickMath.getSqrtRatioAtTick(p.tickUpper - checked.edgeBufferTicks).toString(),
  );
  let best: { input: bigint; output: bigint; error: bigint; scale: bigint } | null = null;
  for (let attempt = 0; attempt < 14 && low <= high; attempt++) {
    if (candidate < low || candidate > high) candidate = (low + high) / 2n;
    const { result } = await client.simulateContract({
      address: config.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      blockNumber: p.block.number,
      args: [
        {
          tokenIn: config.weth,
          tokenOut: config.aaveUsdc,
          amountIn: candidate,
          fee: 500,
          sqrtPriceLimitX96: sqrtLimit,
        },
      ],
    });
    const afterSqrt = result[1];
    if (afterSqrt < sqrtLimit || afterSqrt > p.sqrtPriceX96 || afterSqrt >= upperSqrt)
      throw new Error("Swap quote violates the price limit or direction");
    if (afterSqrt === sqrtLimit) {
      high = candidate - 1n;
      candidate = (low + high) / 2n;
      continue;
    }
    if (result[0] <= 0n) {
      low = candidate + 1n;
      candidate = (low + high) / 2n;
      continue;
    }
    let tickLow = lowerTick,
      tickHigh = p.currentTick;
    while (tickLow < tickHigh) {
      const middle = Math.ceil((tickLow + tickHigh) / 2);
      if (BigInt(TickMath.getSqrtRatioAtTick(middle).toString()) <= afterSqrt) tickLow = middle;
      else tickHigh = middle - 1;
    }
    const post = new Position({
      pool: sdkPool(snapshot, afterSqrt, tickLow),
      liquidity: (10n ** 18n).toString(),
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    });
    const left = (capital.amount0 - candidate) * BigInt(post.amount1.quotient.toString());
    const right = result[0] * BigInt(post.amount0.quotient.toString());
    const difference = left - right,
      error = difference < 0n ? -difference : difference,
      scale = left + right;
    if (scale <= 0n) throw new Error("No post-swap target liquidity");
    if (!best || error * best.scale < best.error * scale)
      best = { input: candidate, output: result[0], error, scale };
    if (error * 10000n <= scale * 5n) break;
    if (difference > 0n) low = candidate + 1n;
    else high = candidate - 1n;
    candidate = (low + high) / 2n;
  }
  if (!best || best.error * 10000n > best.scale * 10n)
    throw new Error("No sufficiently balanced ratio quote within price limits");
  const amountIn = best.input,
    minimumOut = (best.output * 997n) / 1000n;
  if (minimumOut <= 0n) throw new Error("Swap minimum is too small");
  if ((await client.getBlock({ blockNumber: p.block.number })).hash !== p.block.hash)
    throw new Error("Swap quote block changed");
  const expiresAt = Math.min(now + checked.ttlSeconds, p.block.timestamp + checked.maxAgeSeconds);
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: config.weth,
        tokenOut: config.aaveUsdc,
        fee: 500,
        recipient: snapshot.lot.owner,
        amountIn,
        amountOutMinimum: minimumOut,
        sqrtPriceLimitX96: sqrtLimit,
      },
    ],
  });
  return sealStage({
    mode: "REVIEW_ONLY",
    phase: "SWAP",
    cycleId: snapshot.lot.cycleId,
    tokenId: snapshot.lot.tokenId,
    observedBlock: p.block,
    createdAt: now,
    expiresAt,
    capital,
    amounts: {
      input: amountIn,
      minimumOut,
      desired0: 0n,
      desired1: 0n,
      minimum0: 0n,
      minimum1: 0n,
    },
    calls: [
      returnCall("approve-swap", config.weth, erc20Abi, "approve", [config.swapRouter, amountIn]),
      returnCall("swap", config.swapRouter, routerAbi, "multicall", [BigInt(expiresAt), [swap]]),
    ],
  });
}

// Must be rebuilt after swap confirmation using actual deltas and a fresh pool state.
export function buildReturnIncreaseStage(
  snapshot: ReturnSnapshot,
  capital: AttributedCapital,
  policy: ReturnPolicy,
  now: number,
): StageDraft {
  const checked = assertReentrySnapshot(snapshot, policy, now);
  if (capital.amount0 <= 0n || capital.amount0 >= snapshot.lot.principal || capital.amount1 <= 0n)
    throw new Error("Two confirmed strategy token balances required");
  const p = snapshot.position;
  const position = Position.fromAmounts({
    pool: sdkPool(snapshot),
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    amount0: capital.amount0.toString(),
    amount1: capital.amount1.toString(),
    useFullPrecision: true,
  });
  const minimum0 = (BigInt(position.amount0.quotient.toString()) * 997n) / 1000n;
  const minimum1 = (BigInt(position.amount1.quotient.toString()) * 997n) / 1000n;
  if (minimum0 <= 0n || minimum1 <= 0n) throw new Error("Increase minimum is too small");
  const expiresAt = Math.min(now + checked.ttlSeconds, p.block.timestamp + checked.maxAgeSeconds);
  return sealStage({
    mode: "REVIEW_ONLY",
    phase: "INCREASE",
    cycleId: snapshot.lot.cycleId,
    tokenId: snapshot.lot.tokenId,
    observedBlock: p.block,
    createdAt: now,
    expiresAt,
    capital,
    amounts: {
      input: 0n,
      minimumOut: 0n,
      desired0: capital.amount0,
      desired1: capital.amount1,
      minimum0,
      minimum1,
    },
    calls: [
      returnCall("approve-lp0", config.weth, erc20Abi, "approve", [
        config.positionManager,
        capital.amount0,
      ]),
      returnCall("approve-lp1", config.aaveUsdc, erc20Abi, "approve", [
        config.positionManager,
        capital.amount1,
      ]),
      returnCall("increase", config.positionManager, positionManagerAbi, "increaseLiquidity", [
        {
          tokenId: snapshot.lot.tokenId,
          amount0Desired: capital.amount0,
          amount1Desired: capital.amount1,
          amount0Min: minimum0,
          amount1Min: minimum1,
          deadline: BigInt(expiresAt),
        },
      ]),
    ],
  });
}
