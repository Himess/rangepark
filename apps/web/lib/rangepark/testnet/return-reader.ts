import { Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import { createPublicClient, http, erc20Abi, isAddressEqual, parseAbi, zeroAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { aaveDataAbi, factoryAbi, poolAbi, positionManagerAbi } from "../chain/abis.js";
import { meanTick } from "../core/range.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import type { ParkedLot, ReturnPolicy, ReturnSnapshot } from "./return-policy.js";

export const aaveAccountAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
]);
export function testnetReturnClient(batch = false) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpc, { timeout: 20000, retryCount: 1, batch }),
  });
}
export type TestnetReturnClient = ReturnType<typeof testnetReturnClient>;

// A sequencer tip can be one second ahead of this host. Read a real earlier
// block in that case; never rewrite chain timestamps or relax policy freshness.
export async function readTimeAlignedHead(
  client: Pick<TestnetReturnClient, "getBlock">,
  now = Math.floor(Date.now() / 1000),
) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid read time");
  const head = await client.getBlock();
  if (head.timestamp <= BigInt(now)) return head;
  return client.getBlock({ blockNumber: head.number > 2n ? head.number - 2n : 0n });
}

export async function readReturnSnapshot(
  client: TestnetReturnClient,
  lot: ParkedLot,
  policy: ReturnPolicy,
  blockNumber?: bigint,
): Promise<ReturnSnapshot> {
  requireTestnetChain(lot.chainId);
  requireTestnetChain(await client.getChainId());
  const rawBlock =
    blockNumber === undefined
      ? await readTimeAlignedHead(client)
      : await client.getBlock({ blockNumber });
  const block = {
    number: rawBlock.number,
    hash: rawBlock.hash,
    timestamp: Number(rawBlock.timestamp),
  };
  const common = {
    address: config.aaveDataProvider,
    abi: aaveDataAbi,
    args: [lot.asset],
    blockNumber: block.number,
  } as const;
  const [raw, owner, poolAddress, configuration, paused, data, tokens, caps, account] =
    await Promise.all([
      client.readContract({
        address: config.positionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [lot.tokenId],
        blockNumber: block.number,
      }),
      client.readContract({
        address: config.positionManager,
        abi: positionManagerAbi,
        functionName: "ownerOf",
        args: [lot.tokenId],
        blockNumber: block.number,
      }),
      client.readContract({
        address: config.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [lot.token0, lot.token1, lot.fee],
        blockNumber: block.number,
      }),
      client.readContract({ ...common, functionName: "getReserveConfigurationData" }),
      client.readContract({ ...common, functionName: "getPaused" }),
      client.readContract({ ...common, functionName: "getReserveData" }),
      client.readContract({ ...common, functionName: "getReserveTokensAddresses" }),
      client.readContract({ ...common, functionName: "getReserveCaps" }),
      client.readContract({
        address: config.aavePool,
        abi: aaveAccountAbi,
        functionName: "getUserAccountData",
        args: [lot.owner],
        blockNumber: block.number,
      }),
    ]);
  if (
    poolAddress === zeroAddress ||
    !isAddressEqual(poolAddress, lot.pool) ||
    tokens[0] === zeroAddress
  )
    throw new Error("Original pool or Aave reserve is unavailable");
  if (
    !isAddressEqual(raw[2], config.weth) ||
    !isAddressEqual(raw[3], config.aaveUsdc) ||
    !isAddressEqual(lot.asset, config.weth) ||
    Number(configuration[0]) !== 18
  )
    throw new Error("Unexpected testnet token identity");
  const [slot, poolLiquidity, cumulatives, aTokenBalance, availableLiquidity] = await Promise.all([
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
        args: [[policy.twapSeconds, 0]],
        blockNumber: block.number,
      })
      .catch(() => null),
    client.readContract({
      address: tokens[0],
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [lot.owner],
      blockNumber: block.number,
    }),
    client.readContract({
      address: lot.asset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [tokens[0]],
      blockNumber: block.number,
    }),
  ]);
  const token0 = { address: raw[2], decimals: 18, symbol: "testWETH" };
  const token1 = { address: raw[3], decimals: 6, symbol: "Aave testUSDC" };
  const sdkPool = new Pool(
    new Token(84532, token0.address, 18),
    new Token(84532, token1.address, 6),
    raw[4],
    slot[0].toString(),
    poolLiquidity.toString(),
    slot[1],
  );
  const sdkPosition = new Position({
    pool: sdkPool,
    liquidity: raw[7].toString(),
    tickLower: raw[5],
    tickUpper: raw[6],
  });
  const twapTick =
    cumulatives?.[0][0] !== undefined && cumulatives[0][1] !== undefined
      ? meanTick(cumulatives[0][0], cumulatives[0][1], policy.twapSeconds)
      : null;
  const cap = caps[1] * 10n ** 18n;
  const used = data[2] + (data[1] * data[9] + 5n * 10n ** 26n) / 10n ** 27n;
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
    throw new Error("RETURN snapshot reorged; discard it");
  return {
    lot,
    aTokenBalance,
    totalDebtBase: account[1],
    oracle: { cardinality: slot[3], cardinalityNext: slot[4] },
    position: {
      chainId: 84532,
      tokenId: lot.tokenId,
      owner,
      pool: poolAddress,
      token0,
      token1,
      fee: raw[4],
      tickLower: raw[5],
      tickUpper: raw[6],
      currentTick: slot[1],
      sqrtPriceX96: slot[0],
      liquidity: raw[7],
      principal0: BigInt(sdkPosition.amount0.quotient.toString()),
      principal1: BigInt(sdkPosition.amount1.quotient.toString()),
      checkpointOwed0: raw[10],
      checkpointOwed1: raw[11],
      twapTick,
      twapWindowSeconds: policy.twapSeconds,
      block,
    },
    market: {
      chainId: 84532,
      protocol: "aave-v3",
      pool: config.aavePool,
      asset: token0,
      aToken: tokens[0],
      supplyAprRay: data[5],
      availableLiquidity,
      supplyCapRemaining: caps[1] === 0n ? null : cap > used ? cap - used : 0n,
      active: configuration[8],
      frozen: configuration[9],
      paused,
      block,
    },
  };
}
