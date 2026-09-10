import { Token } from "@uniswap/sdk-core";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import { decodeEventLog, isAddressEqual, parseAbi, type Address, type Hex } from "viem";
import { hash } from "../core/serialization.js";
import type { BlockRef } from "../core/models.js";
import { poolAbi } from "../chain/abis.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import type { ReturnEconomics, ReturnPolicy, ReturnSnapshot } from "./return-policy.js";
import type { TestnetReturnClient } from "./return-reader.js";

const Q128 = 1n << 128n,
  Q192 = 1n << 192n,
  MOD = 1n << 256n;
export const COST_ASSUMPTIONS = {
  calls: 6,
  gasPerCall: 4000000n,
  unsignedBytesPerCall: 8192n,
  gasPriceMultiplier: 2n,
  swapLossBps: 100n,
  allocatedValueBps: 9900n,
} as const;
export const gasOracle = "0x420000000000000000000000000000000000000F" as const;
const feeAbi = parseAbi([
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
]);
const gasAbi = parseAbi([
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);
const events = parseAbi([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Flash(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1,uint256 paid0,uint256 paid1)",
]);
export type FeeState = {
  block: BlockRef;
  growth0: bigint;
  growth1: bigint;
  tick: number;
  liquidity: bigint;
};
export type Activity = {
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  index: number;
  kind: "Swap" | "Mint" | "Burn" | "Flash";
  sender?: Address;
  recipient?: Address;
  tick?: number;
  liquidity?: bigint;
};
export type FeeBlock = { before: FeeState; after: FeeState; activity: Activity[] };
export function growthDelta(before: bigint, after: bigint) {
  if (before < 0n || after < 0n || before >= MOD || after >= MOD)
    throw Error("Invalid fee growth counter");
  return (after - before + MOD) % MOD;
}
export function projectedLiquidity(snapshot: ReturnSnapshot) {
  const p = snapshot.position;
  const pool = new Pool(
    new Token(84532, config.weth, 18),
    new Token(84532, config.aaveUsdc, 6),
    500,
    p.sqrtPriceX96.toString(),
    "0",
    p.currentTick,
  );
  const unit = 10n ** 18n,
    position = new Position({
      pool,
      liquidity: unit.toString(),
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    });
  const amount0 = BigInt(position.mintAmounts.amount0.toString()),
    amount1 = BigInt(position.mintAmounts.amount1.toString());
  const price = p.sqrtPriceX96 * p.sqrtPriceX96,
    value = amount0 + (amount1 * Q192 + price - 1n) / price;
  if (value <= 0n) throw Error("Cannot size hypothetical RETURN liquidity");
  return (snapshot.lot.principal * COST_ASSUMPTIONS.allocatedValueBps * unit) / (10000n * value);
}
export function projectHistoricalFees(args: {
  snapshot: ReturnSnapshot;
  start: FeeState;
  end: FeeState;
  blocks: FeeBlock[];
  excludedHashes: ReadonlySet<string>;
  horizonSeconds: number;
}) {
  const { snapshot, start, end, blocks, excludedHashes, horizonSeconds } = args;
  const elapsed = end.block.timestamp - start.block.timestamp;
  if (
    elapsed < 600 ||
    elapsed > 7200 ||
    end.block.number <= start.block.number ||
    !Number.isInteger(horizonSeconds) ||
    horizonSeconds < 300 ||
    horizonSeconds > 86400
  )
    throw Error("Invalid fee history window");
  const liquidity = projectedLiquidity(snapshot);
  if (liquidity <= 0n) throw Error("No projected liquidity");
  let sum0 = 0n,
    sum1 = 0n,
    earned0 = 0n,
    earned1 = 0n;
  const details: { block: BlockRef; reason: string; fees0: bigint; fees1: bigint }[] = [];
  const seen = new Set<string>();
  for (const item of blocks) {
    const { before, after, activity } = item,
      key = after.block.number.toString();
    if (
      seen.has(key) ||
      after.block.number <= start.block.number ||
      after.block.number > end.block.number ||
      before.block.number + 1n !== after.block.number ||
      activity.some((a) => a.blockNumber !== after.block.number || a.blockHash !== after.block.hash)
    )
      throw Error("Fee block identity or ordering mismatch");
    seen.add(key);
    const d0 = growthDelta(before.growth0, after.growth0),
      d1 = growthDelta(before.growth1, after.growth1);
    sum0 += d0;
    sum1 += d1;
    const inRange = (tick: number) => tick >= snapshot.lot.lower && tick < snapshot.lot.upper;
    let reason = "INCLUDED",
      minimumLiquidity = before.liquidity;
    if (
      activity.some(
        (a) =>
          excludedHashes.has(a.transactionHash.toLowerCase()) ||
          (a.sender && isAddressEqual(a.sender, snapshot.lot.owner)) ||
          (a.recipient && isAddressEqual(a.recipient, snapshot.lot.owner)),
      )
    )
      reason = "PROJECT_ACTIVITY_EXCLUDED";
    else if (activity.some((a) => a.kind === "Mint" || a.kind === "Burn"))
      reason = "LIQUIDITY_CHANGE_BLOCK_EXCLUDED";
    else if (
      !inRange(before.tick) ||
      !inRange(after.tick) ||
      activity.some((a) => a.kind === "Swap" && (a.tick === undefined || !inRange(a.tick)))
    )
      reason = "RANGE_CROSSING_BLOCK_EXCLUDED";
    for (const a of activity)
      if (a.liquidity !== undefined && a.liquidity < minimumLiquidity)
        minimumLiquidity = a.liquidity;
    if (after.liquidity < minimumLiquidity) minimumLiquidity = after.liquidity;
    if (reason === "INCLUDED" && (minimumLiquidity <= 0n || liquidity * 100n > minimumLiquidity))
      reason = "MATERIAL_COUNTERFACTUAL_LIQUIDITY_EXCLUDED";
    const fees0 =
      reason === "INCLUDED"
        ? (d0 * liquidity * minimumLiquidity) / (Q128 * (minimumLiquidity + liquidity))
        : 0n;
    const fees1 =
      reason === "INCLUDED"
        ? (d1 * liquidity * minimumLiquidity) / (Q128 * (minimumLiquidity + liquidity))
        : 0n;
    earned0 += fees0;
    earned1 += fees1;
    details.push({ block: after.block, reason, fees0, fees1 });
  }
  // Detect missing fee-bearing blocks rather than turning an incomplete log read into zero income.
  if (
    sum0 % MOD !== growthDelta(start.growth0, end.growth0) ||
    sum1 % MOD !== growthDelta(start.growth1, end.growth1)
  )
    throw Error("Fee history does not reconcile to global counters");
  const sqrt = snapshot.position.sqrtPriceX96,
    twap = snapshot.position.twapTick;
  if (twap === null) throw Error("TWAP required for fee valuation");
  const twapSqrt = BigInt(TickMath.getSqrtRatioAtTick(twap).toString());
  const valuationPrice = sqrt > twapSqrt ? sqrt * sqrt : twapSqrt * twapSqrt;
  const valueWeth = earned0 + (earned1 * Q192) / valuationPrice;
  return {
    elapsed,
    projectedLiquidity: liquidity,
    historicalFees0: earned0,
    historicalFees1: earned1,
    historicalValueWeth: valueWeth,
    expectedLpFees: (valueWeth * BigInt(horizonSeconds)) / BigInt(elapsed),
    details,
    model: "Conditional historical fee-rate projection; not guaranteed future earnings",
  };
}
export function modelExecutionCost(
  principal: bigint,
  gasPrice: bigint,
  l1PerCall: bigint,
  operatorPerCall: bigint,
) {
  if (
    principal <= 0n ||
    principal > 10n ** 15n ||
    gasPrice <= 0n ||
    l1PerCall < 0n ||
    operatorPerCall < 0n
  )
    throw Error("Invalid cost inputs");
  const a = COST_ASSUMPTIONS,
    gasPriceBudget = gasPrice * a.gasPriceMultiplier;
  const l2 = BigInt(a.calls) * a.gasPerCall * gasPriceBudget,
    l1 = BigInt(a.calls) * l1PerCall,
    operator = BigInt(a.calls) * operatorPerCall;
  const swapLoss = (principal * a.swapLossBps + 9999n) / 10000n;
  return {
    l2,
    l1,
    operator,
    swapLoss,
    gasPrice,
    gasPriceBudget,
    total: l2 + l1 + operator + swapLoss,
    assumptions: a,
    model:
      "Conservative planning budget, not an invoice or guaranteed transaction gas limit; sponsorship not assumed free",
  };
}
async function readFeeState(
  client: TestnetReturnClient,
  pool: Address,
  number: bigint,
): Promise<FeeState> {
  const [block, growth0, growth1, slot, liquidity] = await Promise.all([
    client.getBlock({ blockNumber: number }),
    client.readContract({
      address: pool,
      abi: feeAbi,
      functionName: "feeGrowthGlobal0X128",
      blockNumber: number,
    }),
    client.readContract({
      address: pool,
      abi: feeAbi,
      functionName: "feeGrowthGlobal1X128",
      blockNumber: number,
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: number,
    }),
    client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "liquidity",
      blockNumber: number,
    }),
  ]);
  return {
    block: { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) },
    growth0,
    growth1,
    tick: slot[1],
    liquidity,
  };
}
export async function findHistoryStart(
  client: Pick<TestnetReturnClient, "getBlock">,
  end: BlockRef,
  seconds: number,
) {
  const target = end.timestamp - seconds;
  if (target <= 0) throw Error("History window precedes chain time");
  let distance = 3600n,
    high = end.number,
    low = high > distance ? high - distance : 0n;
  let lower = await client.getBlock({ blockNumber: low });
  for (let i = 0; Number(lower.timestamp) > target && low > 0n; i++) {
    if (i >= 8) throw Error("History search budget exhausted");
    distance *= 2n;
    low = end.number > distance ? end.number - distance : 0n;
    lower = await client.getBlock({ blockNumber: low });
  }
  if (Number(lower.timestamp) > target) throw Error("Insufficient chain history");
  for (let i = 0; high - low > 1n; i++) {
    if (i >= 32) throw Error("History search budget exhausted");
    const mid = (low + high) / 2n,
      block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) <= target) low = mid;
    else high = mid;
  }
  return low;
}
export async function readEconomicsEvidence(
  client: TestnetReturnClient,
  snapshot: ReturnSnapshot,
  policy: ReturnPolicy,
  excludedHashes: ReadonlySet<string>,
  clock = () => Math.floor(Date.now() / 1000),
) {
  requireTestnetChain(await client.getChainId());
  const lot = snapshot.lot;
  requireTestnetChain(lot.chainId);
  if (
    !isAddressEqual(lot.asset, config.weth) ||
    !isAddressEqual(lot.token0, config.weth) ||
    !isAddressEqual(lot.token1, config.aaveUsdc) ||
    lot.fee !== 500
  )
    throw Error("Unsupported economics allocation");
  const endNumber = snapshot.position.block.number,
    startNumber = await findHistoryStart(client, snapshot.position.block, 3600);
  if (endNumber - startNumber > 20000n) throw Error("Fee log window exceeds read budget");
  const all: Activity[] = [];
  for (let from = startNumber + 1n; from <= endNumber; from += 1000n) {
    const to = from + 999n < endNumber ? from + 999n : endNumber;
    const logs = await client.getLogs({ address: lot.pool, fromBlock: from, toBlock: to });
    for (const log of logs) {
      let d;
      try {
        d = decodeEventLog({ abi: events, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (
        log.removed ||
        log.blockNumber === null ||
        log.blockHash === null ||
        log.transactionHash === null ||
        log.logIndex === null
      )
        throw Error("Unsettled fee log");
      const a: Activity = {
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        index: log.logIndex,
        kind: d.eventName,
      };
      if ("sender" in d.args) a.sender = d.args.sender;
      if ("recipient" in d.args) a.recipient = d.args.recipient;
      if (d.eventName === "Swap") {
        a.tick = d.args.tick;
        a.liquidity = d.args.liquidity;
      }
      all.push(a);
    }
  }
  const numbers = [
    ...new Set(
      all.filter((a) => a.kind === "Swap" || a.kind === "Flash").map((a) => a.blockNumber),
    ),
  ];
  if (numbers.length > 24)
    throw Error("Fee activity exceeds bounded reader capacity; no partial quote");
  const cache = new Map<bigint, Promise<FeeState>>();
  const read = (n: bigint) => {
    if (!cache.has(n)) cache.set(n, readFeeState(client, lot.pool, n));
    return cache.get(n)!;
  };
  const [start, end, gasPrice, l1PerCall, operatorPerCall] = await Promise.all([
    read(startNumber),
    read(endNumber),
    client.getGasPrice(),
    client.readContract({
      address: gasOracle,
      abi: gasAbi,
      functionName: "getL1FeeUpperBound",
      args: [COST_ASSUMPTIONS.unsignedBytesPerCall],
      blockNumber: endNumber,
    }),
    client.readContract({
      address: gasOracle,
      abi: gasAbi,
      functionName: "getOperatorFee",
      args: [COST_ASSUMPTIONS.gasPerCall],
      blockNumber: endNumber,
    }),
  ]);
  const blocks: FeeBlock[] = [];
  for (const number of numbers) {
    const [before, after] = await Promise.all([read(number - 1n), read(number)]);
    blocks.push({
      before,
      after,
      activity: all.filter((a) => a.blockNumber === number).sort((a, b) => a.index - b.index),
    });
  }
  const fees = projectHistoricalFees({
    snapshot,
    start,
    end,
    blocks,
    excludedHashes,
    horizonSeconds: policy.horizonSeconds,
  });
  const cost = modelExecutionCost(lot.principal, gasPrice, l1PerCall, operatorPerCall);
  for (const state of await Promise.all(cache.values()))
    if ((await client.getBlock({ blockNumber: state.block.number })).hash !== state.block.hash)
      throw Error("Economics source block reorged");
  const now = clock();
  if (
    now < end.block.timestamp ||
    now - end.block.timestamp >= policy.maxAgeSeconds ||
    end.block.hash !== snapshot.position.block.hash
  )
    throw Error("Economics snapshot expired or changed during read");
  const evidence = {
    mode: "BASE_SEPOLIA_OBSERVED_ECONOMICS",
    chainId: 84532,
    lot,
    snapshot,
    start,
    end,
    fees,
    cost,
    feeBlocks: blocks,
    excludedHashes: [...excludedHashes],
    activityCount: all.length,
    quotedAt: now,
  };
  const quote: ReturnEconomics = {
    chainId: 84532,
    cycleId: lot.cycleId,
    asset: lot.asset,
    horizonSeconds: policy.horizonSeconds,
    quotedAt: now,
    expiresAt: now + policy.ttlSeconds,
    expectedLpFees: fees.expectedLpFees,
    executionCost: cost.total,
    source: `Observed fee growth and OP fee oracle; conservative budget; evidence ${hash(evidence)}`,
  };
  return { evidence, quote };
}
