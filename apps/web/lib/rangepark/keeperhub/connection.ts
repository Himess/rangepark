import { erc20Abi, isAddress, parseAbi, type Address } from "viem";
import { BASE } from "../config/base.js";
import { readBlock, verifyBlock, type ChainReader } from "../chain/client.js";
import { call } from "./plan.js";
import { KeeperHubClient, KeeperHubError } from "./client.js";

const enumerableAbi = parseAbi([
  "function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)",
]);

export async function inspectExecutionWallet(
  client: ChainReader,
  owner: Address,
) {
  if (!isAddress(owner)) throw new Error("Invalid execution wallet");
  const block = await readBlock(client);
  const [eth, weth, usdc, nftCount] = await Promise.all([
    client.getBalance({ address: owner, blockNumber: block.number }),
    ...[BASE.weth, BASE.usdc, BASE.positionManager].map((address) =>
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        blockNumber: block.number,
      }),
    ),
  ]);
  if (
    eth === undefined ||
    weth === undefined ||
    usdc === undefined ||
    nftCount === undefined
  )
    throw new Error("Incomplete wallet snapshot");
  const count = Number(nftCount > 32n ? 32n : nftCount);
  const tokenIds = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.readContract({
        address: BASE.positionManager,
        abi: enumerableAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(i)],
        blockNumber: block.number,
      }),
    ),
  );
  await verifyBlock(client, block);
  return {
    mode: "LIVE_READ_ONLY",
    chainId: BASE.chainId,
    owner,
    block,
    balances: { eth, weth, usdc },
    nftCount,
    tokenIds,
    truncated: nftCount > 32n,
  };
}

// This probes the real authenticated transport without requiring an owned LP or
// granting an allowance. Both requests always use KeeperHubClient.simulate().
export async function probeConnection(client: KeeperHubClient, owner: Address) {
  if (!isAddress(owner)) throw new Error("Invalid expected sender");
  const steps = [
    call("read-balance", BASE.usdc, erc20Abi, "balanceOf", [owner], []),
    call(
      "simulate-zero-approval",
      BASE.weth,
      erc20Abi,
      "approve",
      [BASE.aavePool, 0n],
      [],
    ),
  ];
  const checks: {
    id: string;
    status: "PASSED" | "FAILED";
    result?: unknown;
    httpStatus?: number;
    failureKind?: string;
    code?: string;
  }[] = [];
  for (const step of steps) {
    try {
      checks.push({
        id: step.id,
        status: "PASSED",
        result: await client.simulate(step, owner),
      });
    } catch (error) {
      if (!(error instanceof KeeperHubError)) throw error;
      const details = error.details as {
        code?: unknown;
        failureKind?: unknown;
      } | null;
      checks.push({
        id: step.id,
        status: "FAILED",
        httpStatus: error.status,
        code: typeof details?.code === "string" ? details.code : undefined,
        failureKind:
          typeof details?.failureKind === "string"
            ? details.failureKind
            : undefined,
      });
      // A rejected credential cannot be repaired by trying another operation.
      if (error.status === 401 || error.status === 403) break;
    }
  }
  return {
    mode: "AUTHENTICATED_SIMULATION_ONLY",
    expectedSender: owner,
    success:
      checks.length === steps.length &&
      checks.every((c) => c.status === "PASSED"),
    checks,
    transactions: [],
    valueMovementProven: false,
    fullLifecycleProven: false,
  };
}
