import { erc20Abi, getAddress, isAddressEqual, zeroAddress } from "viem";
import { BASE } from "../config/base.js";
import type { AaveMarket, BlockRef, Token } from "../core/models.js";
import { aaveDataAbi } from "./abis.js";
import type { ChainReader } from "./client.js";

export async function readAaveMarket(
  client: ChainReader,
  asset: Token,
  block: BlockRef,
): Promise<AaveMarket> {
  if (
    ![BASE.weth, BASE.usdc].some((address) =>
      isAddressEqual(address, asset.address),
    )
  )
    throw new Error("Asset not allowlisted");
  const shared = {
    address: BASE.aaveDataProvider,
    abi: aaveDataAbi,
    args: [asset.address],
    blockNumber: block.number,
  } as const;
  const [configuration, caps, paused, data, tokens] = await Promise.all([
    client.readContract({
      ...shared,
      functionName: "getReserveConfigurationData",
    }),
    client.readContract({ ...shared, functionName: "getReserveCaps" }),
    client.readContract({ ...shared, functionName: "getPaused" }),
    client.readContract({ ...shared, functionName: "getReserveData" }),
    client.readContract({
      ...shared,
      functionName: "getReserveTokensAddresses",
    }),
  ]);
  if (Number(configuration[0]) !== asset.decimals)
    throw new Error("Reserve token decimals mismatch");
  const aToken = getAddress(tokens[0]);
  if (aToken === zeroAddress) throw new Error("Missing Aave reserve");
  const availableLiquidity = await client.readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [aToken],
    blockNumber: block.number,
  });
  // Match cap accounting: existing aToken supply plus accrued treasury claims in underlying units.
  const treasuryUnderlying = (data[1] * data[9] + 5n * 10n ** 26n) / 10n ** 27n;
  const used = data[2] + treasuryUnderlying;
  const cap = caps[1] * 10n ** BigInt(asset.decimals);
  return {
    chainId: BASE.chainId,
    protocol: "aave-v3",
    pool: BASE.aavePool,
    asset,
    aToken,
    supplyAprRay: data[5],
    availableLiquidity,
    supplyCapRemaining: caps[1] === 0n ? null : cap > used ? cap - used : 0n,
    active: configuration[8],
    frozen: configuration[9],
    paused,
    block,
  };
}
