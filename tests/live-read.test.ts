import { beforeAll, describe, expect, it } from "vitest";
import { baseClient, readBlock, verifyBlock } from "../src/chain/client.js";
import { readPosition } from "../src/chain/uniswap.js";
import { readAaveMarket } from "../src/chain/aave.js";
import { positionManagerAbi } from "../src/chain/abis.js";
import { BASE } from "../src/config/base.js";
import type { AaveMarket, PositionSnapshot } from "../src/core/models.js";

// Opt-in. This suite only reads/simulates and never signs or broadcasts.
// Supply a current public WETH/USDC token ID; no hardcoded position is assumed to remain active.
describe.skipIf(!process.env.LIVE_POSITION_ID)(
  "Base mainnet read integration",
  () => {
    const client = baseClient();
    let position: PositionSnapshot;
    let markets: AaveMarket[];
    beforeAll(async () => {
      const block = await readBlock(client);
      position = await readPosition(
        client,
        BigInt(process.env.LIVE_POSITION_ID!),
        block,
      );
      markets = await Promise.all([
        readAaveMarket(client, position.token0, block),
        readAaveMarket(client, position.token1, block),
      ]);
      await verifyBlock(client, block);
    }, 60000);
    it("reads a real WETH/USDC position and TWAP at the same block", () => {
      expect(position.token0.address).toBe(BASE.weth);
      expect(position.token1.address).toBe(BASE.usdc);
      expect(position.liquidity).toBeGreaterThan(0n);
      expect(position.twapTick).not.toBeNull();
      expect(markets.every((m) => m.block.hash === position.block.hash)).toBe(
        true,
      );
    });
    it("reads both real Aave reserves", () => {
      expect(markets).toHaveLength(2);
      for (const market of markets) {
        expect(market.active).toBe(true);
        expect(market.availableLiquidity).toBeGreaterThan(0n);
        expect(market.supplyAprRay).toBeGreaterThanOrEqual(0n);
      }
    });
    it("matches SDK principal math against an actual NFPM eth_call", async () => {
      const result = await client.simulateContract({
        address: BASE.positionManager,
        abi: positionManagerAbi,
        functionName: "decreaseLiquidity",
        account: position.owner,
        blockNumber: position.block.number,
        args: [
          {
            tokenId: position.tokenId,
            liquidity: position.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: BigInt(position.block.timestamp + 120),
          },
        ],
      });
      // Zero minimums exist only in this read-only eth_call to compare the returned principal.
      expect(result.result).toEqual([position.principal0, position.principal1]);
    }, 30000);
  },
);
