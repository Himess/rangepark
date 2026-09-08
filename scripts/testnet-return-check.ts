import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  aaveDataAbi,
  aavePoolAbi,
  factoryAbi,
  poolAbi,
  positionManagerAbi,
} from "../src/chain/abis.js";
import {
  BASE_SEPOLIA as config,
  requireTestnetChain,
} from "../src/testnet/config.js";
import { json } from "../src/core/serialization.js";
if (existsSync(".env")) process.loadEnvFile(".env");
try {
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  const key = process.env.KEEPERHUB_API_KEY;
  if (!owner || !isAddress(owner) || !key)
    throw new Error("Verified wallet and read-only KeeperHub key required");
  const park = JSON.parse(
    await readFile("artifacts/testnet-park.json", "utf8"),
  ) as {
    chainId: number;
    complete: boolean;
    owner: Address;
    steps: { id: string; meta: Record<string, string | number> }[];
  };
  requireTestnetChain(park.chainId);
  if (!park.complete || !isAddressEqual(park.owner, owner))
    throw new Error("Completed owned PARK evidence required");
  const mint = park.steps.find((s) => s.id === "mint")!;
  const supply = park.steps.find((s) => s.id === "supply")!;
  const tokenId = BigInt(mint.meta.tokenId!);
  const principal = BigInt(supply.meta.amount!);
  const c = createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpc, { timeout: 20000, retryCount: 1 }),
  });
  requireTestnetChain(await c.getChainId());
  const block = await c.getBlock();
  const [position, nftOwner, pool, tokens] = await Promise.all([
    c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
      blockNumber: block.number,
    }),
    c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: block.number,
    }),
    c.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [config.weth, config.aaveUsdc, 500],
      blockNumber: block.number,
    }),
    c.readContract({
      address: config.aaveDataProvider,
      abi: aaveDataAbi,
      functionName: "getReserveTokensAddresses",
      args: [config.weth],
      blockNumber: block.number,
    }),
  ]);
  if (
    !isAddressEqual(nftOwner, owner) ||
    position[7] !== 0n ||
    position[5] !== Number(mint.meta.lower) ||
    position[6] !== Number(mint.meta.upper) ||
    !isAddressEqual(position[2], config.weth) ||
    !isAddressEqual(position[3], config.aaveUsdc) ||
    position[4] !== 500
  )
    throw new Error("Parked NFT identity/range changed");
  const [slot, balance] = await Promise.all([
    c.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: block.number,
    }),
    c.readContract({
      address: tokens[0],
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    }),
  ]);
  if (balance < principal - 2n)
    throw new Error("Aave claim below expected principal");
  const response = await fetch(
    "https://app.keeperhub.com/api/execute/contract-call",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chainId: 84532,
        contractAddress: config.aavePool,
        functionName: "withdraw",
        functionArgs: json([config.weth, principal, owner]),
        abi: JSON.stringify(aavePoolAbi),
        value: "0",
        simulate: true,
      }),
    },
  );
  const sim = (await response.json()) as {
    success: boolean;
    status: string;
    wouldRevert: boolean;
    from: Address;
    to: Address;
    value: string;
    simulatedReturnValue: string;
    gasEstimate: string;
  };
  if (
    !response.ok ||
    sim.success !== true ||
    sim.status !== "simulated" ||
    sim.wouldRevert !== false ||
    !isAddressEqual(sim.from, owner) ||
    !isAddressEqual(sim.to, config.aavePool) ||
    sim.value !== "0" ||
    sim.simulatedReturnValue !== principal.toString()
  )
    throw new Error("Withdrawal simulation failed verification");
  if ((await c.getBlock({ blockNumber: block.number })).hash !== block.hash)
    throw new Error("Snapshot reorged");
  const inRange = slot[1] >= position[5] && slot[1] < position[6];
  const report = {
    mode: "BASE_SEPOLIA_RETURN_READ_ONLY",
    chainId: 84532,
    owner,
    tokenId,
    block: {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
    },
    range: {
      lower: position[5],
      upper: position[6],
      currentTick: slot[1],
      inRange,
    },
    aTokenBalance: balance,
    originalSuppliedPrincipal: principal,
    withdrawalSimulation: sim,
    rangeState: inRange
      ? "ORIGINAL_RANGE_REACHED_REQUIRES_FULL_GUARDS"
      : "WAITING_FOR_ORIGINAL_RANGE",
    automaticReturnReady: false,
    missingGuards: [
      "Return persistence and TWAP",
      "Fresh execution economics",
      "Withdrawal-to-swap-to-same-NFT executor",
    ],
    transactions: [],
  };
  await writeFile("artifacts/testnet-return-check.json", json(report));
  console.log(json(report));
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet RETURN check failed",
  );
  process.exitCode = 1;
}
