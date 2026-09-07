import type { Address, Hex } from "viem";

export type BlockRef = { number: bigint; hash: Hex; timestamp: number };
export type Token = { address: Address; symbol: string; decimals: number };
export type RangeSide = "BELOW" | "IN_RANGE" | "ABOVE";
export type PositionSnapshot = {
  chainId: number;
  tokenId: bigint;
  owner: Address;
  pool: Address;
  token0: Token;
  token1: Token;
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  principal0: bigint;
  principal1: bigint;
  // NFPM tokensOwed is a checkpoint, not a full current uncollected-fee estimate.
  checkpointOwed0: bigint;
  checkpointOwed1: bigint;
  twapTick: number | null;
  twapWindowSeconds: number;
  block: BlockRef;
};
export type AaveMarket = {
  chainId: number;
  protocol: "aave-v3";
  pool: Address;
  asset: Token;
  aToken: Address;
  supplyAprRay: bigint;
  availableLiquidity: bigint;
  supplyCapRemaining: bigint | null; // null means uncapped, never unknown
  active: boolean;
  frozen: boolean;
  paused: boolean;
  block: BlockRef;
};
export type Observation = {
  positionKey: string;
  side: RangeSide;
  since: number;
  lastAt: number;
  lastBlock: bigint;
  lastHash: Hex;
};
export type ParkPolicy = {
  outOfRangeSeconds: number;
  maxObservationGapSeconds: number;
  maxDataAgeSeconds: number;
  maxSpotTwapTickDeviation: number;
  minTwapWindowSeconds: number;
  cooldownSeconds: number;
  horizonSeconds: number;
  yieldHaircutBps: number;
  costSafetyMultiplier: number;
  maxSlippageBps: number;
  planTtlSeconds: number;
};
export type Economics = {
  // Both costs are denominated in atomic units of the parked token.
  // Caller must include gas, swap fees, slippage and execution service fees.
  roundTripCost: bigint;
  foregoneLpFees: bigint;
  source: string;
};
export type DecisionReceipt = {
  action: "HOLD" | "PARK";
  reasons: string[];
  asset: Address | null;
  principal: bigint;
  supplyAmount: bigint;
  expectedYield: bigint;
  requiredBenefit: bigint;
  breakEvenSeconds: bigint | null;
  horizonSeconds: number;
  economics: Economics;
  policyHash: Hex;
  inputHash: Hex;
  observedBlock: BlockRef;
  createdAt: number;
  expiresAt: number;
  simulation: "NOT_RUN";
};
