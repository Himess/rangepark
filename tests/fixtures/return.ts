import { TickMath } from "@uniswap/v3-sdk";
import type { Hex } from "viem";
import { BASE_SEPOLIA as config } from "../../src/testnet/config.js";
import {
  defaultReturnPolicy,
  observeReturn,
  type ReturnDecisionInput,
  type ReturnObservation,
  type ReturnSnapshot,
} from "../../src/testnet/return-policy.js";
const blockHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const owner = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
export function returnFixture(at = 10000): ReturnSnapshot {
  const block = { number: BigInt(at), hash: blockHash(at), timestamp: at };
  const token0 = { address: config.weth, decimals: 18, symbol: "testWETH" };
  const token1 = { address: config.aaveUsdc, decimals: 6, symbol: "Aave testUSDC" };
  return {
    lot: {
      cycleId: blockHash(1),
      chainId: 84532,
      owner,
      tokenId: 82083n,
      pool,
      token0: config.weth,
      token1: config.aaveUsdc,
      fee: 500,
      lower: -196230,
      upper: -196170,
      asset: config.weth,
      principal: 10n ** 15n,
      parkedAt: 1000,
      status: "PARKED",
    },
    position: {
      chainId: 84532,
      tokenId: 82083n,
      owner,
      pool,
      token0,
      token1,
      fee: 500,
      tickLower: -196230,
      tickUpper: -196170,
      currentTick: -196200,
      sqrtPriceX96: BigInt(TickMath.getSqrtRatioAtTick(-196200).toString()),
      liquidity: 0n,
      principal0: 0n,
      principal1: 0n,
      checkpointOwed0: 0n,
      checkpointOwed1: 0n,
      twapTick: -196200,
      twapWindowSeconds: 300,
      block,
    },
    market: {
      chainId: 84532,
      protocol: "aave-v3",
      pool: config.aavePool,
      asset: token0,
      aToken: "0x3333333333333333333333333333333333333333",
      supplyAprRay: 5n * 10n ** 25n,
      availableLiquidity: 10n ** 20n,
      supplyCapRemaining: 0n,
      active: true,
      frozen: false,
      paused: false,
      block,
    },
    aTokenBalance: 10n ** 15n + 100n,
    totalDebtBase: 0n,
    oracle: { cardinality: 16, cardinalityNext: 16 },
  };
}
export function eligibleReturnInput(): ReturnDecisionInput {
  let observation: ReturnObservation | null = null;
  let snapshot = returnFixture(9700);
  for (let at = 9700; at <= 10000; at += 60) {
    snapshot = returnFixture(at);
    observation = observeReturn(snapshot, defaultReturnPolicy, observation, at);
  }
  return {
    ...snapshot,
    observation,
    policy: defaultReturnPolicy,
    now: 10000,
    economics: {
      chainId: 84532,
      cycleId: snapshot.lot.cycleId,
      asset: config.weth,
      horizonSeconds: 3600,
      quotedAt: 10000,
      expiresAt: 10120,
      expectedLpFees: 10n ** 12n,
      executionCost: 10n ** 9n,
      source: "SYNTHETIC_TEST_ONLY",
    },
  };
}
