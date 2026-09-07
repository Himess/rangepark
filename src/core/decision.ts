import { isAddressEqual } from "viem";
import { z } from "zod";
import { BASE } from "../config/base.js";
import type {
  AaveMarket,
  DecisionReceipt,
  Economics,
  Observation,
  ParkPolicy,
  PositionSnapshot,
} from "./models.js";
import { positionKey, rangeSide } from "./range.js";
import { hash } from "./serialization.js";

const seconds = z
  .number()
  .int()
  .positive()
  .max(365 * 86400);
export const policySchema = z
  .object({
    outOfRangeSeconds: seconds,
    maxObservationGapSeconds: seconds,
    maxDataAgeSeconds: seconds,
    maxSpotTwapTickDeviation: z.number().int().nonnegative().max(10000),
    minTwapWindowSeconds: seconds,
    cooldownSeconds: z
      .number()
      .int()
      .nonnegative()
      .max(365 * 86400),
    horizonSeconds: seconds,
    yieldHaircutBps: z.number().int().min(0).max(10000),
    costSafetyMultiplier: z.number().int().min(1).max(100),
    maxSlippageBps: z.number().int().min(1).max(100),
    planTtlSeconds: z.number().int().positive().max(300),
  })
  .strict();

export const defaultPolicy: ParkPolicy = {
  outOfRangeSeconds: 1800,
  maxObservationGapSeconds: 120,
  maxDataAgeSeconds: 60,
  maxSpotTwapTickDeviation: 100,
  minTwapWindowSeconds: 300,
  cooldownSeconds: 3600,
  horizonSeconds: 7 * 86400,
  yieldHaircutBps: 2000,
  costSafetyMultiplier: 3,
  maxSlippageBps: 30,
  planTtlSeconds: 120,
};

export type DecisionInput = {
  position: PositionSnapshot;
  market: AaveMarket;
  observation: Observation | null;
  policy: ParkPolicy;
  economics: Economics;
  now: number;
  lastActionAt: number | null;
};
const RAY = 10n ** 27n;
const YEAR = 365n * 86400n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function decidePark(input: DecisionInput): DecisionReceipt {
  const {
    position: p,
    market: m,
    observation: o,
    economics: e,
    now,
    lastActionAt,
  } = input;
  const policy = policySchema.parse(input.policy);
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    e.roundTripCost < 0n ||
    e.foregoneLpFees < 0n ||
    !e.source.trim()
  ) {
    throw new Error("Invalid economics or decision time");
  }
  if (
    p.liquidity < 0n ||
    p.principal0 < 0n ||
    p.principal1 < 0n ||
    m.supplyAprRay < 0n ||
    m.availableLiquidity < 0n
  ) {
    throw new Error("Negative chain quantity");
  }
  const side = rangeSide(p.currentTick, p.tickLower, p.tickUpper);
  const asset =
    side === "BELOW"
      ? p.token0.address
      : side === "ABOVE"
        ? p.token1.address
        : null;
  const principal =
    side === "BELOW" ? p.principal0 : side === "ABOVE" ? p.principal1 : 0n;
  // A fixed amount below quoted principal avoids spending existing wallet funds or guessing future fees.
  const supplyAmount =
    (principal * BigInt(10000 - policy.maxSlippageBps)) / 10000n;
  const reasons: string[] = [];
  if (p.chainId !== BASE.chainId || m.chainId !== BASE.chainId)
    reasons.push("WRONG_CHAIN");
  if (
    !isAddressEqual(p.token0.address, BASE.weth) ||
    !isAddressEqual(p.token1.address, BASE.usdc) ||
    p.token0.decimals !== 18 ||
    p.token1.decimals !== 6
  )
    reasons.push("UNSUPPORTED_PAIR");
  if (side === "IN_RANGE") reasons.push("POSITION_IN_RANGE");
  if (p.liquidity === 0n || supplyAmount === 0n)
    reasons.push("NO_PARKABLE_PRINCIPAL");
  if (
    (side === "BELOW" && p.principal1 !== 0n) ||
    (side === "ABOVE" && p.principal0 !== 0n)
  )
    reasons.push("INCONSISTENT_PRINCIPAL");
  if (
    now < p.block.timestamp ||
    now - p.block.timestamp > policy.maxDataAgeSeconds ||
    now < m.block.timestamp ||
    now - m.block.timestamp > policy.maxDataAgeSeconds
  )
    reasons.push("STALE_DATA");
  if (
    m.block.hash !== p.block.hash ||
    m.block.number !== p.block.number ||
    m.block.timestamp !== p.block.timestamp
  )
    reasons.push("MIXED_BLOCKS");
  if (
    !o ||
    o.positionKey !== positionKey(p) ||
    o.side !== side ||
    o.lastBlock !== p.block.number ||
    o.lastHash !== p.block.hash ||
    o.lastAt !== p.block.timestamp ||
    o.since > o.lastAt ||
    o.since < 0 ||
    o.lastAt - o.since < policy.outOfRangeSeconds
  )
    reasons.push("PERSISTENCE_NOT_MET");
  if (p.twapTick === null || p.twapWindowSeconds < policy.minTwapWindowSeconds)
    reasons.push("TWAP_UNAVAILABLE");
  else if (
    Math.abs(p.currentTick - p.twapTick) > policy.maxSpotTwapTickDeviation ||
    rangeSide(p.twapTick, p.tickLower, p.tickUpper) !== side
  )
    reasons.push("TWAP_DISAGREEMENT");
  if (
    lastActionAt !== null &&
    (!Number.isSafeInteger(lastActionAt) ||
      now - lastActionAt < policy.cooldownSeconds)
  )
    reasons.push("COOLDOWN");
  if (m.protocol !== "aave-v3" || !isAddressEqual(m.pool, BASE.aavePool))
    reasons.push("VENUE_NOT_ALLOWED");
  if (
    asset === null ||
    !isAddressEqual(asset, m.asset.address) ||
    m.asset.decimals !==
      (side === "BELOW" ? p.token0.decimals : p.token1.decimals)
  )
    reasons.push("ASSET_MISMATCH");
  if (!m.active || m.frozen || m.paused) reasons.push("RESERVE_UNAVAILABLE");
  if (m.supplyCapRemaining !== null && m.supplyCapRemaining < supplyAmount)
    reasons.push("SUPPLY_CAP");
  if (m.availableLiquidity < supplyAmount) reasons.push("WITHDRAWAL_LIQUIDITY");

  const annualYieldNumerator =
    supplyAmount * m.supplyAprRay * BigInt(10000 - policy.yieldHaircutBps);
  const expectedYield =
    (annualYieldNumerator * BigInt(policy.horizonSeconds)) /
    (RAY * YEAR * 10000n);
  const requiredBenefit =
    e.roundTripCost * BigInt(policy.costSafetyMultiplier) + e.foregoneLpFees;
  const netHorizonYield = expectedYield - e.foregoneLpFees;
  const breakEvenSeconds =
    netHorizonYield > 0n
      ? ceilDiv(
          e.roundTripCost * BigInt(policy.horizonSeconds),
          netHorizonYield,
        )
      : null;
  if (expectedYield <= requiredBenefit) reasons.push("NOT_ECONOMIC");

  return {
    action: reasons.length === 0 ? "PARK" : "HOLD",
    reasons:
      reasons.length === 0
        ? ["OUT_OF_RANGE", "POLICY_PASSED", "POSITIVE_ESTIMATED_NET_BENEFIT"]
        : reasons,
    asset,
    principal,
    supplyAmount,
    expectedYield,
    requiredBenefit,
    breakEvenSeconds,
    horizonSeconds: policy.horizonSeconds,
    economics: e,
    policyHash: hash(policy),
    inputHash: hash(input),
    observedBlock: p.block,
    createdAt: now,
    expiresAt: now + policy.planTtlSeconds,
    simulation: "NOT_RUN",
  };
}
