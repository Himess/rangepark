import { Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  type Address,
} from "viem";
import { BASE } from "../config/base.js";
import {
  aavePoolAbi,
  positionManagerAbi,
  quoterAbi,
  routerAbi,
} from "../chain/abis.js";
import type { ChainReader } from "../chain/client.js";
import type { PositionSnapshot } from "../core/models.js";
import { rangeSide } from "../core/range.js";
import { hash } from "../core/serialization.js";
import { call, type ContractCall, type ExecutionPlan } from "./plan.js";

export function withdrawCall(
  asset: Address,
  amount: bigint,
  owner: Address,
): ContractCall {
  if (
    ![BASE.weth, BASE.usdc].some((a) => isAddressEqual(a, asset)) ||
    amount <= 0n
  )
    throw new Error("Invalid withdrawal");
  return call(
    "withdraw",
    BASE.aavePool,
    aavePoolAbi,
    "withdraw",
    [asset, amount, owner],
    [],
  );
}

function sdkPosition(p: PositionSnapshot, amount0?: bigint, amount1?: bigint) {
  const pool = new Pool(
    new Token(8453, p.token0.address, p.token0.decimals),
    new Token(8453, p.token1.address, p.token1.decimals),
    p.fee,
    p.sqrtPriceX96.toString(),
    "0",
    p.currentTick,
  );
  return amount0 === undefined || amount1 === undefined
    ? new Position({
        pool,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: (10n ** 18n).toString(),
      })
    : Position.fromAmounts({
        pool,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        useFullPrecision: true,
      });
}

export function ratioSwap(
  p: PositionSnapshot,
  balance0: bigint,
  balance1: bigint,
) {
  if (rangeSide(p.currentTick, p.tickLower, p.tickUpper) !== "IN_RANGE")
    throw new Error("Original range is not active");
  if (balance0 < 0n || balance1 < 0n) throw new Error("Negative balance");
  const target = sdkPosition(p);
  const r0 = BigInt(target.amount0.quotient.toString()),
    r1 = BigInt(target.amount1.quotient.toString());
  const imbalance = balance0 * r1 - balance1 * r0;
  const q192 = 1n << 192n,
    price = p.sqrtPriceX96 * p.sqrtPriceX96;
  const denominator = r1 * q192 + r0 * price;
  if (denominator === 0n) throw new Error("No target liquidity");
  const zeroForOne = imbalance > 0n;
  const amountIn = zeroForOne
    ? (imbalance * q192) / denominator
    : (-imbalance * price) / denominator;
  return {
    tokenIn: zeroForOne ? p.token0.address : p.token1.address,
    tokenOut: zeroForOne ? p.token1.address : p.token0.address,
    amountIn,
    zeroForOne,
  };
}

// Build only AFTER withdrawal has confirmed. Balances must be attributable to this strategy.
export async function buildReentryPlan(
  client: ChainReader,
  p: PositionSnapshot,
  balance0: bigint,
  balance1: bigint,
  slippageBps = 30,
) {
  if (
    p.chainId !== 8453 ||
    !isAddressEqual(p.token0.address, BASE.weth) ||
    !isAddressEqual(p.token1.address, BASE.usdc)
  )
    throw new Error("Unsupported position");
  if (p.liquidity !== 0n)
    throw new Error("Return requires the original empty NFT");
  if (
    p.twapTick === null ||
    p.twapWindowSeconds < 300 ||
    Math.abs(p.currentTick - p.twapTick) > 100
  )
    throw new Error("Return price confirmation unavailable or divergent");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100)
    throw new Error("Invalid slippage");
  const deadline = p.block.timestamp + 120;
  const quote = ratioSwap(p, balance0, balance1);
  const steps: ContractCall[] = [];
  let available0 = balance0,
    available1 = balance1;
  let minimumOut = 0n;
  if (quote.amountIn > 0n) {
    const { result } = await client.simulateContract({
      address: BASE.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      blockNumber: p.block.number,
      args: [
        {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          amountIn: quote.amountIn,
          fee: p.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    minimumOut = (result[0] * BigInt(10000 - slippageBps)) / 10000n;
    if (minimumOut === 0n) throw new Error("Swap output too small");
    steps.push(
      call(
        "approve-swap",
        quote.tokenIn,
        erc20Abi,
        "approve",
        [BASE.swapRouter, quote.amountIn],
        [],
      ),
    );
    const swap = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          fee: p.fee,
          recipient: p.owner,
          amountIn: quote.amountIn,
          amountOutMinimum: minimumOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    steps.push(
      call(
        "swap",
        BASE.swapRouter,
        routerAbi,
        "multicall",
        [BigInt(deadline), [swap]],
        ["approve-swap"],
      ),
    );
    if (quote.zeroForOne) {
      available0 -= quote.amountIn;
      available1 += minimumOut;
    } else {
      available1 -= quote.amountIn;
      available0 += minimumOut;
    }
  }
  if (available0 <= 0n || available1 <= 0n)
    throw new Error("Both tokens are required for in-range return");
  const target = sdkPosition(p, available0, available1);
  const minimum0 =
    (BigInt(target.amount0.quotient.toString()) * BigInt(10000 - slippageBps)) /
    10000n;
  const minimum1 =
    (BigInt(target.amount1.quotient.toString()) * BigInt(10000 - slippageBps)) /
    10000n;
  if (minimum0 === 0n || minimum1 === 0n)
    throw new Error("Return minimum too small");
  steps.push(
    call(
      "approve-lp0",
      p.token0.address,
      erc20Abi,
      "approve",
      [BASE.positionManager, available0],
      quote.amountIn > 0n ? ["swap"] : [],
    ),
  );
  steps.push(
    call(
      "approve-lp1",
      p.token1.address,
      erc20Abi,
      "approve",
      [BASE.positionManager, available1],
      ["approve-lp0"],
    ),
  );
  steps.push(
    call(
      "increase",
      BASE.positionManager,
      positionManagerAbi,
      "increaseLiquidity",
      [
        {
          tokenId: p.tokenId,
          amount0Desired: available0,
          amount1Desired: available1,
          amount0Min: minimum0,
          amount1Min: minimum1,
          deadline: BigInt(deadline),
        },
      ],
      ["approve-lp1"],
    ),
  );
  const body = {
    version: 1 as const,
    action: "RETURN" as const,
    phase: "REENTRY",
    mode: "REVIEW_ONLY" as const,
    chainId: 8453 as const,
    sender: p.owner,
    positionId: p.tokenId.toString(),
    createdAt: p.block.timestamp,
    observedBlock: p.block,
    expiresAt: deadline,
    balances: { balance0, balance1 },
    quote: { ...quote, minimumOut },
    steps,
  };
  return { ...body, planHash: hash(body) };
}

export function buildWithdrawPlan(
  p: PositionSnapshot,
  asset: Address,
  amount: bigint,
): ExecutionPlan {
  if (p.chainId !== 8453 || p.liquidity !== 0n)
    throw new Error("Withdrawal requires a parked Base position");
  const body = {
    version: 1 as const,
    action: "RETURN" as const,
    phase: "WITHDRAW",
    mode: "REVIEW_ONLY" as const,
    chainId: 8453 as const,
    sender: p.owner,
    positionId: p.tokenId.toString(),
    createdAt: p.block.timestamp,
    expiresAt: p.block.timestamp + 120,
    steps: [withdrawCall(asset, amount, p.owner)],
  };
  return { ...body, planHash: hash(body) };
}
