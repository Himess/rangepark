import {
  createPublicClient,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  aaveDataAbi,
  factoryAbi,
  poolAbi,
  positionManagerAbi,
} from "../chain/abis.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";

export async function testnetReadiness(owner: Address) {
  if (!isAddress(owner))
    throw new Error("Verified organization wallet required");
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpc, { timeout: 20000, retryCount: 1 }),
  });
  requireTestnetChain(await client.getChainId());
  const block = await client.getBlock();
  const contracts = Object.entries(config).filter(
    (entry): entry is [string, Address] =>
      typeof entry[1] === "string" && entry[1].startsWith("0x"),
  );
  const code = await Promise.all(
    contracts.map(async ([name, address]) => {
      const bytecode = await client.getCode({
        address,
        blockNumber: block.number,
      });
      return { name, address, deployed: !!bytecode && bytecode !== "0x" };
    }),
  );
  if (code.some((c) => !c.deployed))
    throw new Error(
      `Testnet contract missing: ${code
        .filter((c) => !c.deployed)
        .map((c) => c.name)
        .join(", ")}`,
    );
  const [eth, weth, usdc, nftCount, reserves] = await Promise.all([
    client.getBalance({ address: owner, blockNumber: block.number }),
    client.readContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    }),
    client.readContract({
      address: config.aaveUsdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    }),
    client.readContract({
      address: config.positionManager,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    }),
    client.readContract({
      address: config.aaveDataProvider,
      abi: parseAbi([
        "function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])",
      ]),
      functionName: "getAllReservesTokens",
      blockNumber: block.number,
    }),
  ]);
  const markets = await Promise.all(
    [config.weth, config.aaveUsdc].map(async (asset) => {
      const [tokens, state, paused] = await Promise.all([
        client.readContract({
          address: config.aaveDataProvider,
          abi: aaveDataAbi,
          functionName: "getReserveTokensAddresses",
          args: [asset],
          blockNumber: block.number,
        }),
        client.readContract({
          address: config.aaveDataProvider,
          abi: aaveDataAbi,
          functionName: "getReserveConfigurationData",
          args: [asset],
          blockNumber: block.number,
        }),
        client.readContract({
          address: config.aaveDataProvider,
          abi: aaveDataAbi,
          functionName: "getPaused",
          args: [asset],
          blockNumber: block.number,
        }),
      ]);
      return {
        asset,
        aToken: tokens[0],
        ownerBalance: await client.readContract({
          address: tokens[0],
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
          blockNumber: block.number,
        }),
        active: state[8],
        frozen: state[9],
        paused,
      };
    }),
  );
  const positions = await Promise.all(
    Array.from(
      { length: Number(nftCount > 32n ? 32n : nftCount) },
      async (_, index) => {
        const tokenId = await client.readContract({
          address: config.positionManager,
          abi: parseAbi([
            "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
          ]),
          functionName: "tokenOfOwnerByIndex",
          args: [owner, BigInt(index)],
          blockNumber: block.number,
        });
        const p = await client.readContract({
          address: config.positionManager,
          abi: positionManagerAbi,
          functionName: "positions",
          args: [tokenId],
          blockNumber: block.number,
        });
        return {
          tokenId,
          token0: p[2],
          token1: p[3],
          fee: p[4],
          tickLower: p[5],
          tickUpper: p[6],
          liquidity: p[7],
        };
      },
    ),
  );
  const pools = await Promise.all(
    [500, 3000, 10000].map(async (fee) => {
      const address = await client.readContract({
        address: config.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [config.weth, config.aaveUsdc, fee],
        blockNumber: block.number,
      });
      if (address === zeroAddress) return { fee, address, exists: false };
      const [slot, liquidity] = await Promise.all([
        client.readContract({
          address,
          abi: poolAbi,
          functionName: "slot0",
          blockNumber: block.number,
        }),
        client.readContract({
          address,
          abi: poolAbi,
          functionName: "liquidity",
          blockNumber: block.number,
        }),
      ]);
      return { fee, address, exists: true, currentTick: slot[1], liquidity };
    }),
  );
  if (
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new Error("Testnet block changed; discard snapshot");
  return {
    mode: "BASE_SEPOLIA_READ_ONLY",
    chainId: config.chainId,
    owner,
    block: {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    },
    balances: { eth, weth, aaveUsdc: usdc },
    nftCount,
    positions,
    positionsTruncated: nftCount > 32n,
    contracts: code,
    reserves,
    markets,
    pools,
    circleUsdcIsAaveReserve: reserves.some(
      (r) => r.tokenAddress.toLowerCase() === config.circleUsdc.toLowerCase(),
    ),
    transactions: [],
  };
}
