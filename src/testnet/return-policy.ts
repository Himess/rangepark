import { isAddressEqual, type Address, type Hex } from "viem";
import { z } from "zod";
import type { AaveMarket, BlockRef, PositionSnapshot } from "../core/models.js";
import { hash } from "../core/serialization.js";
import { rangeSide } from "../core/range.js";
import { BASE_SEPOLIA as config } from "./config.js";

// A decision is a review artifact. It neither authorizes nor broadcasts a call.
export const returnPolicySchema = z
  .object({
    persistenceSeconds: z.number().int().min(60).max(3600),
    maxGapSeconds: z.number().int().min(1).max(120),
    maxAgeSeconds: z.number().int().min(1).max(60),
    twapSeconds: z.number().int().min(300).max(3600),
    edgeBufferTicks: z.number().int().min(1).max(1000),
    maxSpotTwapDeviation: z.number().int().min(0).max(100),
    cooldownSeconds: z.number().int().min(60).max(86400),
    horizonSeconds: z.number().int().min(300).max(86400),
    feeHaircutBps: z.number().int().min(0).max(10000),
    costMultiplier: z.number().int().min(1).max(10),
    ttlSeconds: z.number().int().min(1).max(120),
  })
  .strict();
export type ReturnPolicy = z.infer<typeof returnPolicySchema>;
export const defaultReturnPolicy: ReturnPolicy = {
  persistenceSeconds: 300,
  maxGapSeconds: 120,
  maxAgeSeconds: 60,
  twapSeconds: 300,
  edgeBufferTicks: 10,
  maxSpotTwapDeviation: 100,
  cooldownSeconds: 3600,
  horizonSeconds: 3600,
  feeHaircutBps: 2000,
  costMultiplier: 3,
  ttlSeconds: 120,
};
export type ParkedLot = {
  cycleId: Hex;
  chainId: number;
  owner: Address;
  tokenId: bigint;
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  lower: number;
  upper: number;
  asset: Address;
  principal: bigint;
  parkedAt: number;
  status: "PARKED" | "RESTORED" | "RECOVERY";
};
export type ReturnSnapshot = {
  lot: ParkedLot;
  position: PositionSnapshot;
  market: AaveMarket;
  aTokenBalance: bigint;
  totalDebtBase: bigint;
  oracle: { cardinality: number; cardinalityNext: number };
};
export type ReturnObservation = {
  contextHash: Hex;
  since: number | null;
  samples: number;
  block: BlockRef;
};
export type ReturnEconomics = {
  chainId: number;
  cycleId: Hex;
  asset: Address;
  horizonSeconds: number;
  quotedAt: number;
  expiresAt: number;
  expectedLpFees: bigint;
  executionCost: bigint;
  source: string;
};

function sameBlock(a: BlockRef, b: BlockRef) {
  return a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
}
export function returnContextHash(snapshot: ReturnSnapshot, policy: ReturnPolicy) {
  const p = snapshot.position;
  return hash({
    lot: snapshot.lot,
    policy,
    identity: {
      chainId: p.chainId,
      tokenId: p.tokenId,
      owner: p.owner.toLowerCase(),
      pool: p.pool.toLowerCase(),
      token0: p.token0,
      token1: p.token1,
      lower: p.tickLower,
      upper: p.tickUpper,
      fee: p.fee,
      liquidity: p.liquidity,
    },
  });
}
export function returnSnapshotReasons(
  s: ReturnSnapshot,
  policy: ReturnPolicy,
  now: number,
  phase: "WITHDRAW" | "REENTRY" = "WITHDRAW",
) {
  const { position: p, market: m, lot } = s;
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid decision time");
  if (
    [p.liquidity, s.aTokenBalance, s.totalDebtBase, m.availableLiquidity, m.supplyAprRay].some(
      (n) => n < 0n,
    )
  )
    throw new Error("Negative chain quantity");
  rangeSide(p.currentTick, p.tickLower, p.tickUpper);
  const reasons: string[] = [];
  if ([lot.chainId, p.chainId, m.chainId].some((id) => id !== 84532)) reasons.push("WRONG_CHAIN");
  if (lot.status !== "PARKED") reasons.push("LOT_NOT_PARKED");
  if (p.liquidity !== 0n) reasons.push("ORIGINAL_NFT_NOT_EMPTY");
  if (
    lot.tokenId !== p.tokenId ||
    !isAddressEqual(lot.owner, p.owner) ||
    !isAddressEqual(lot.pool, p.pool) ||
    !isAddressEqual(lot.token0, p.token0.address) ||
    !isAddressEqual(lot.token1, p.token1.address) ||
    lot.lower !== p.tickLower ||
    lot.upper !== p.tickUpper ||
    lot.fee !== p.fee
  )
    reasons.push("ORIGINAL_POSITION_CHANGED");
  if (
    !isAddressEqual(p.token0.address, config.weth) ||
    !isAddressEqual(p.token1.address, config.aaveUsdc) ||
    p.token0.decimals !== 18 ||
    p.token1.decimals !== 6 ||
    p.fee !== 500
  )
    reasons.push("UNSUPPORTED_PAIR");
  if (lot.principal <= 0n || lot.principal > 10n ** 15n || !isAddressEqual(lot.asset, config.weth))
    reasons.push("UNSUPPORTED_ALLOCATION");
  if (!Number.isSafeInteger(lot.parkedAt) || lot.parkedAt <= 0 || lot.parkedAt > p.block.timestamp)
    reasons.push("INVALID_PARK_TIME");
  if (
    ![p.block, m.block].every(
      (b) =>
        Number.isSafeInteger(b.timestamp) &&
        b.number >= 0n &&
        now >= b.timestamp &&
        now - b.timestamp < policy.maxAgeSeconds,
    )
  )
    reasons.push("STALE_DATA");
  if (!sameBlock(p.block, m.block)) reasons.push("MIXED_BLOCKS");
  // A swap writes an observation. With a one-slot oracle it can erase the only
  // pre-swap point, making the next phase's five-minute TWAP unavailable.
  if (
    !s.oracle ||
    !Number.isInteger(s.oracle.cardinality) ||
    !Number.isInteger(s.oracle.cardinalityNext) ||
    s.oracle.cardinality < 2 ||
    s.oracle.cardinalityNext < 2
  )
    reasons.push("ORACLE_HISTORY_CAPACITY");
  const lower = p.tickLower + policy.edgeBufferTicks;
  const upper = p.tickUpper - policy.edgeBufferTicks;
  if (lower >= upper || p.currentTick < lower || p.currentTick >= upper)
    reasons.push("SPOT_OUTSIDE_RETURN_BAND");
  if (
    p.twapTick === null ||
    !Number.isInteger(p.twapTick) ||
    !Number.isSafeInteger(p.twapWindowSeconds) ||
    p.twapWindowSeconds < policy.twapSeconds
  )
    reasons.push("TWAP_UNAVAILABLE");
  else if (
    p.twapTick < lower ||
    p.twapTick >= upper ||
    Math.abs(p.currentTick - p.twapTick) > policy.maxSpotTwapDeviation
  )
    reasons.push("TWAP_OUTSIDE_RETURN_BAND");
  if (
    m.protocol !== "aave-v3" ||
    !isAddressEqual(m.pool, config.aavePool) ||
    !isAddressEqual(m.asset.address, lot.asset) ||
    m.asset.decimals !== 18
  )
    reasons.push("WITHDRAWAL_VENUE_MISMATCH");
  // Aave freeze blocks new supply, not withdrawal. Pause/inactive still blocks it.
  if (phase === "WITHDRAW") {
    if (!m.active || m.paused) reasons.push("WITHDRAWAL_UNAVAILABLE");
    if (m.availableLiquidity < lot.principal) reasons.push("INSUFFICIENT_RESERVE_LIQUIDITY");
    if (s.aTokenBalance < lot.principal) reasons.push("PRINCIPAL_UNAVAILABLE");
  }
  // Initial scope excludes indebted accounts; do not infer safe collateral withdrawal.
  if (s.totalDebtBase !== 0n) reasons.push("ACCOUNT_HAS_DEBT");
  return reasons;
}

export function observeReturn(
  s: ReturnSnapshot,
  rawPolicy: ReturnPolicy,
  previous: ReturnObservation | null,
  now: number,
  previousIsCanonical = true,
): ReturnObservation {
  const policy = returnPolicySchema.parse(rawPolicy);
  const contextHash = returnContextHash(s, policy);
  const eligible = returnSnapshotReasons(s, policy, now).length === 0;
  const next: ReturnObservation = {
    contextHash,
    since: eligible ? s.position.block.timestamp : null,
    samples: eligible ? 1 : 0,
    block: s.position.block,
  };
  if (
    !eligible ||
    !previousIsCanonical ||
    !previous ||
    previous.contextHash !== contextHash ||
    previous.since === null
  )
    return next;
  if (sameBlock(previous.block, next.block)) return previous;
  const gap = next.block.timestamp - previous.block.timestamp;
  if (
    next.block.number > previous.block.number &&
    gap > 0 &&
    gap <= policy.maxGapSeconds &&
    previous.since <= previous.block.timestamp &&
    previous.since >= s.lot.parkedAt
  ) {
    next.since = previous.since;
    next.samples = previous.samples + 1;
  }
  return next;
}

export type ReturnDecisionInput = ReturnSnapshot & {
  policy: ReturnPolicy;
  observation: ReturnObservation | null;
  economics: ReturnEconomics | null;
  now: number;
};
export function decideReturn(input: ReturnDecisionInput) {
  const { position: p, lot, market: m, economics: e, observation: o, now } = input;
  const policy = returnPolicySchema.parse(input.policy);
  const reasons = returnSnapshotReasons(input, policy, now);
  if (
    !o ||
    o.contextHash !== returnContextHash(input, policy) ||
    !sameBlock(o.block, p.block) ||
    o.since === null ||
    o.since < lot.parkedAt ||
    o.since > o.block.timestamp ||
    o.samples < 2 ||
    o.block.timestamp - o.since < policy.persistenceSeconds
  )
    reasons.push("RETURN_PERSISTENCE_NOT_MET");
  if (now - lot.parkedAt < policy.cooldownSeconds) reasons.push("RETURN_COOLDOWN");
  let expectedFees = 0n,
    requiredBenefit = 0n;
  // Round up the foregone lending yield rather than silently discounting it.
  const denominator = 10n ** 27n * 365n * 86400n;
  const numerator =
    (lot.principal > 0n ? lot.principal : 0n) * m.supplyAprRay * BigInt(policy.horizonSeconds);
  const foregoneAaveYield = (numerator + denominator - 1n) / denominator;
  let quoteValid = false;
  if (!e) reasons.push("RETURN_ECONOMICS_MISSING");
  else {
    quoteValid =
      e.chainId === 84532 &&
      e.cycleId === lot.cycleId &&
      isAddressEqual(e.asset, lot.asset) &&
      e.horizonSeconds === policy.horizonSeconds &&
      e.source.trim().length > 0 &&
      Number.isSafeInteger(e.quotedAt) &&
      Number.isSafeInteger(e.expiresAt) &&
      e.quotedAt <= now &&
      now < e.expiresAt &&
      e.expiresAt > e.quotedAt &&
      e.expiresAt - e.quotedAt <= policy.ttlSeconds &&
      e.expectedLpFees >= 0n &&
      e.executionCost >= 0n;
    if (!quoteValid) reasons.push("RETURN_ECONOMICS_INVALID_OR_STALE");
    else {
      expectedFees = (e.expectedLpFees * BigInt(10000 - policy.feeHaircutBps)) / 10000n;
      requiredBenefit = e.executionCost * BigInt(policy.costMultiplier) + foregoneAaveYield;
      if (expectedFees <= requiredBenefit) reasons.push("RETURN_NOT_ECONOMIC");
    }
  }
  const body = {
    action: reasons.length ? ("HOLD" as const) : ("RETURN" as const),
    mode: "REVIEW_ONLY" as const,
    reasons: reasons.length ? reasons : ["ORIGINAL_RANGE_CONFIRMED", "RETURN_POLICY_PASSED"],
    chainId: 84532 as const,
    cycleId: lot.cycleId,
    tokenId: lot.tokenId,
    principal: lot.principal,
    expectedFees,
    requiredBenefit,
    foregoneAaveYield,
    policyHash: hash(policy),
    inputHash: hash(input),
    observedBlock: p.block,
    createdAt: now,
    expiresAt: Math.min(
      now + policy.ttlSeconds,
      p.block.timestamp + policy.maxAgeSeconds,
      quoteValid ? e!.expiresAt : now + policy.ttlSeconds,
    ),
    simulation: "NOT_RUN" as const,
  };
  return { ...body, decisionHash: hash(body) };
}
