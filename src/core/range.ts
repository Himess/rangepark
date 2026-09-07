import type { Observation, PositionSnapshot, RangeSide } from "./models.js";

export function rangeSide(
  tick: number,
  lower: number,
  upper: number,
): RangeSide {
  if (
    ![tick, lower, upper].every(
      (v) => Number.isInteger(v) && Math.abs(v) <= 887272,
    ) ||
    lower >= upper
  ) {
    throw new Error("Invalid Uniswap tick range");
  }
  // The upper boundary is exclusive in Uniswap V3.
  return tick < lower ? "BELOW" : tick >= upper ? "ABOVE" : "IN_RANGE";
}

export function positionKey(p: PositionSnapshot): string {
  // Changing owner, range or liquidity invalidates the previous observation streak.
  return `${p.chainId}:${p.tokenId}:${p.owner.toLowerCase()}:${p.pool.toLowerCase()}:${p.tickLower}:${p.tickUpper}:${p.liquidity}`;
}

export function observePosition(
  p: PositionSnapshot,
  previous: Observation | null,
  maxGap: number,
): Observation {
  if (!Number.isSafeInteger(maxGap) || maxGap <= 0)
    throw new Error("Invalid observation gap");
  const side = rangeSide(p.currentTick, p.tickLower, p.tickUpper);
  const key = positionKey(p);
  const next: Observation = {
    positionKey: key,
    side,
    since: p.block.timestamp,
    lastAt: p.block.timestamp,
    lastBlock: p.block.number,
    lastHash: p.block.hash,
  };
  if (!previous || previous.positionKey !== key || previous.side !== side)
    return next;
  if (
    p.block.number === previous.lastBlock &&
    p.block.hash === previous.lastHash
  )
    return previous;
  const gap = p.block.timestamp - previous.lastAt;
  if (p.block.number > previous.lastBlock && gap > 0 && gap <= maxGap)
    next.since = previous.since;
  return next;
}

export function meanTick(start: bigint, end: bigint, seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error("Invalid TWAP window");
  const delta = end - start;
  const duration = BigInt(seconds);
  // JS bigint truncates toward zero; Uniswap's OracleLibrary rounds toward -infinity.
  return Number(
    delta / duration - (delta < 0n && delta % duration !== 0n ? 1n : 0n),
  );
}
