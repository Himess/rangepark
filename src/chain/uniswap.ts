import { Token as SdkToken } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import { erc20Abi, getAddress, zeroAddress, type Address } from "viem";
import { BASE } from "../config/base.js";
import type { BlockRef, PositionSnapshot, Token } from "../core/models.js";
import { meanTick } from "../core/range.js";
import { factoryAbi, poolAbi, positionManagerAbi } from "./abis.js";
import type { ChainReader } from "./client.js";

async function readToken(
  client: ChainReader,
  address: Address,
  block: BlockRef,
): Promise<Token> {
  const [decimals, symbol] = await Promise.all([
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
      blockNumber: block.number,
    }),
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "symbol",
      blockNumber: block.number,
    }),
  ]);
  return { address: getAddress(address), decimals, symbol };
}

export async function readPosition(
  client: ChainReader,
  tokenId: bigint,
  block: BlockRef,
  twapWindowSeconds = 300,
): Promise<PositionSnapshot> {
  if (tokenId < 0n) throw new Error("Invalid token ID");
  const [raw, owner] = await Promise.all([
    client.readContract({
      address: BASE.positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
      blockNumber: block.number,
    }),
    client.readContract({
      address: BASE.positionManager,
      abi: positionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: block.number,
    }),
  ]);
  const [
    ,
    ,
    token0Address,
    token1Address,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    ,
    ,
    owed0,
    owed1,
  ] = raw;
  const [poolAddress, token0, token1] = await Promise.all([
    client.readContract({
      address: BASE.factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0Address, token1Address, fee],
      blockNumber: block.number,
    }),
    readToken(client, token0Address, block),
    readToken(client, token1Address, block),
  ]);
  if (poolAddress === zeroAddress)
    throw new Error("Position pool does not exist");
  const [slot0, poolLiquidity, observations] = await Promise.all([
    client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: block.number,
    }),
    client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "liquidity",
      blockNumber: block.number,
    }),
    client
      .readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "observe",
        args: [[twapWindowSeconds, 0]],
        blockNumber: block.number,
      })
      .catch(() => null),
  ]);
  const [sqrtPriceX96, currentTick] = slot0;
  const sdkPool = new Pool(
    new SdkToken(BASE.chainId, token0.address, token0.decimals, token0.symbol),
    new SdkToken(BASE.chainId, token1.address, token1.decimals, token1.symbol),
    fee,
    sqrtPriceX96.toString(),
    poolLiquidity.toString(),
    currentTick,
  );
  const position = new Position({
    pool: sdkPool,
    liquidity: liquidity.toString(),
    tickLower,
    tickUpper,
  });
  const cumulatives = observations?.[0];
  const twapTick =
    cumulatives?.[0] !== undefined && cumulatives[1] !== undefined
      ? meanTick(cumulatives[0], cumulatives[1], twapWindowSeconds)
      : null;
  return {
    chainId: BASE.chainId,
    tokenId,
    owner: getAddress(owner),
    pool: getAddress(poolAddress),
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    currentTick,
    sqrtPriceX96,
    liquidity,
    principal0: BigInt(position.amount0.quotient.toString()),
    principal1: BigInt(position.amount1.quotient.toString()),
    checkpointOwed0: owed0,
    checkpointOwed1: owed1,
    twapTick,
    twapWindowSeconds,
    block,
  };
}

export async function discoverPositions(
  client: ChainReader,
  block: BlockRef,
  limit = 16,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64)
    throw new Error("Discovery limit must be 1–64");
  const total = await client.readContract({
    address: BASE.positionManager,
    abi: positionManagerAbi,
    functionName: "totalSupply",
    blockNumber: block.number,
  });
  const count = Number(total < BigInt(limit) ? total : BigInt(limit));
  const ids = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.readContract({
        address: BASE.positionManager,
        abi: positionManagerAbi,
        functionName: "tokenByIndex",
        args: [total - 1n - BigInt(i)],
        blockNumber: block.number,
      }),
    ),
  );
  const positions = await Promise.all(
    ids.map(async (tokenId) => {
      const raw = await client.readContract({
        address: BASE.positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [tokenId],
        blockNumber: block.number,
      });
      return {
        tokenId,
        token0: raw[2],
        token1: raw[3],
        fee: raw[4],
        liquidity: raw[7],
      };
    }),
  );
  return {
    total,
    inspected: count,
    positions: positions.filter(
      (p) =>
        p.liquidity > 0n &&
        p.token0.toLowerCase() === BASE.weth.toLowerCase() &&
        p.token1.toLowerCase() === BASE.usdc.toLowerCase(),
    ),
  };
}
