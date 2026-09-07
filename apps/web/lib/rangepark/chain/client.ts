import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { BlockRef } from "../core/models.js";

export function baseClient(
  url = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com",
) {
  return createPublicClient({
    chain: base,
    transport: http(url, { timeout: 20000, retryCount: 1 }),
  });
}
export type ChainReader = ReturnType<typeof baseClient>;

export async function readBlock(client: ChainReader): Promise<BlockRef> {
  if ((await client.getChainId()) !== 8453)
    throw new Error("RPC is not Base mainnet (8453)");
  const block = await client.getBlock();
  return {
    number: block.number,
    hash: block.hash,
    timestamp: Number(block.timestamp),
  };
}

export async function verifyBlock(
  client: ChainReader,
  block: BlockRef,
): Promise<void> {
  const current = await client.getBlock({ blockNumber: block.number });
  if (current.hash !== block.hash)
    throw new Error("Block changed during reads; discard snapshot");
}
