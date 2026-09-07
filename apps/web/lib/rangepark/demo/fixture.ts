import { BASE } from "../config/base.js";
import { defaultPolicy, type DecisionInput } from "../core/decision.js";
import type { PositionSnapshot } from "../core/models.js";
import { observePosition } from "../core/range.js";

// Explicitly synthetic; token ID and balances below are not onchain evidence.
export function demoInput(now = 1809777600): DecisionInput {
  const position: PositionSnapshot = {
    chainId: 8453,
    tokenId: 12345n,
    owner: "0x1111111111111111111111111111111111111111",
    pool: "0x2222222222222222222222222222222222222222",
    token0: { address: BASE.weth, symbol: "WETH", decimals: 18 },
    token1: { address: BASE.usdc, symbol: "USDC", decimals: 6 },
    fee: 500,
    tickLower: -200040,
    tickUpper: -199980,
    currentTick: -199960,
    sqrtPriceX96: 3600516400000000000000000n,
    liquidity: 100000000000000n,
    principal0: 0n,
    principal1: 10000000000n,
    checkpointOwed0: 500000000000n,
    checkpointOwed1: 100000n,
    twapTick: -199962,
    twapWindowSeconds: 300,
    block: { number: 40000000n, hash: `0x${"ab".repeat(32)}`, timestamp: now },
  };
  let observation = null;
  for (let i = 0; i <= 30; i++) {
    const sample = {
      ...position,
      block: {
        number: position.block.number - BigInt((30 - i) * 30),
        hash: position.block.hash,
        timestamp: now - (30 - i) * 60,
      },
    };
    observation = observePosition(
      sample,
      observation,
      defaultPolicy.maxObservationGapSeconds,
    );
  }
  return {
    position,
    observation,
    policy: { ...defaultPolicy },
    market: {
      chainId: 8453,
      protocol: "aave-v3",
      pool: BASE.aavePool,
      asset: position.token1,
      aToken: "0x3333333333333333333333333333333333333333",
      supplyAprRay: 5n * 10n ** 25n,
      availableLiquidity: 1000000000000n,
      supplyCapRemaining: 10000000000000n,
      active: true,
      frozen: false,
      paused: false,
      block: position.block,
    },
    economics: {
      roundTripCost: 2000000n,
      foregoneLpFees: 1000000n,
      source:
        "Synthetic scenario: $2 round trip and $1 foregone LP fees; not a live quote",
    },
    now,
    lastActionAt: null,
  };
}
