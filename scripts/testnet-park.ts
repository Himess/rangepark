import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  aaveDataAbi,
  factoryAbi,
  poolAbi,
  positionManagerAbi,
} from "../src/chain/abis.js";
import { json } from "../src/core/serialization.js";
import {
  BASE_SEPOLIA as config,
  requireTestnetChain,
} from "../src/testnet/config.js";
import {
  TestnetDepositStore,
  depositIntent,
  executionResponseSchema,
} from "../src/testnet/execution.js";
import { TEST_DEPOSIT_WEI } from "../src/testnet/preflight.js";
import { TESTNET_GAS_DELEGATE } from "../src/testnet/receipt.js";
import {
  buildPositionApproval,
  buildTestnetMint,
  buildTestnetRelease,
  buildAaveApproval,
  buildTestnetSupply,
  PARK_STEPS,
  type ParkStepId,
  type TestnetStep,
} from "../src/testnet/park-plan.js";
import {
  parkIntent,
  submitParkStep,
  verifyParkTransaction,
} from "../src/testnet/park-executor.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const db = new TestnetDepositStore("artifacts/testnet-park.sqlite");
const c = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpc, { timeout: 20000, retryCount: 1 }),
});
const owner = process.env.KEEPERHUB_EXPECTED_SENDER as Address;
const apiKey = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
type State = {
  block: string;
  hash: Hex;
  timestamp: number;
  weth: string;
  usdc: string;
  aToken: string;
  nftCount: string;
};
type Baseline = {
  state: State;
  step: TestnetStep;
  meta: Record<string, string | number>;
};
type Proof = {
  id: ParkStepId;
  baseline: Baseline;
  after: State;
  executionId: string;
  transactionHash: Hex;
  blockHash: Hex;
  explorerUrl: string;
  meta: Record<string, string | number>;
  sponsored: boolean;
};
let aToken: Address;
let pool: Address;
async function snapshot(blockNumber?: bigint): Promise<State> {
  const b = await c.getBlock(blockNumber === undefined ? {} : { blockNumber });
  const [weth, usdc, at, nfts] = await Promise.all(
    [config.weth, config.aaveUsdc, aToken, config.positionManager].map(
      (address) =>
        c.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
          blockNumber: b.number,
        }),
    ),
  );
  return {
    block: b.number.toString(),
    hash: b.hash,
    timestamp: Number(b.timestamp),
    weth: weth!.toString(),
    usdc: usdc!.toString(),
    aToken: at!.toString(),
    nftCount: nfts!.toString(),
  };
}
function proof(id: ParkStepId): Proof {
  const row = db.get(parkIntent(owner, id));
  if (row?.status !== "CONFIRMED" || !row.evidence)
    throw new Error(`${id} needs reconciliation`);
  return JSON.parse(row.evidence) as Proof;
}
async function assertOwned(tokenId: bigint, blockNumber?: bigint) {
  const [p, who] = await Promise.all([
    c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
      blockNumber,
    }),
    c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber,
    }),
  ]);
  const original = proof("mint").meta;
  if (
    !isAddressEqual(who, owner) ||
    !isAddressEqual(p[2], config.weth) ||
    !isAddressEqual(p[3], config.aaveUsdc) ||
    p[4] !== 500 ||
    p[5] !== Number(original.lower) ||
    p[6] !== Number(original.upper)
  )
    throw new Error("Original owned NFT identity/range changed");
  return p;
}
async function marketReady() {
  const [state, paused] = await Promise.all([
    c.readContract({
      address: config.aaveDataProvider,
      abi: aaveDataAbi,
      functionName: "getReserveConfigurationData",
      args: [config.weth],
    }),
    c.readContract({
      address: config.aaveDataProvider,
      abi: aaveDataAbi,
      functionName: "getPaused",
      args: [config.weth],
    }),
  ]);
  if (!state[8] || state[9] || paused)
    throw new Error("Aave reserve cannot accept supplies");
}
async function build(id: ParkStepId): Promise<Baseline> {
  requireTestnetChain(await c.getChainId());
  const state = await snapshot();
  if (Math.abs(Date.now() / 1000 - state.timestamp) > 60)
    throw new Error("Stale testnet snapshot");
  let step: TestnetStep;
  let meta: Baseline["meta"] = {};
  if (id === "approve-position") {
    if (
      BigInt(state.weth) !== TEST_DEPOSIT_WEI ||
      state.nftCount !== "0" ||
      state.aToken !== "0"
    )
      throw new Error("Initial wallet is not isolated for this rehearsal");
    step = buildPositionApproval();
  } else if (id === "mint") {
    if (BigInt(state.weth) !== TEST_DEPOSIT_WEI || state.nftCount !== "0")
      throw new Error("Unexpected initial principal or NFT");
    const slot = await c.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: BigInt(state.block),
    });
    const draft = buildTestnetMint(owner, slot[1], state.timestamp);
    step = draft.step;
    meta = {
      lower: draft.params.tickLower,
      upper: draft.params.tickUpper,
      pool,
      tick: slot[1],
    };
  } else if (id === "release") {
    const tokenId = BigInt(proof("mint").meta.tokenId!);
    const p = await assertOwned(tokenId, BigInt(state.block));
    const slot = await c.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: BigInt(state.block),
    });
    if (slot[1] >= p[5] || p[7] === 0n)
      throw new Error("Position is not wholly WETH/out of range");
    const sim = await c.simulateContract({
      account: owner,
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId,
          liquidity: p[7],
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: BigInt(state.timestamp + 120),
        },
      ],
      blockNumber: BigInt(state.block),
    });
    if (sim.result[1] !== 0n)
      throw new Error("Release would contain another asset");
    step = buildTestnetRelease(
      owner,
      tokenId,
      p[7],
      sim.result[0],
      state.timestamp,
    );
    meta = {
      tokenId: tokenId.toString(),
      liquidity: p[7].toString(),
      expectedWeth: sim.result[0].toString(),
      tick: slot[1],
    };
  } else {
    await marketReady();
    const amount = BigInt(proof("release").meta.releasedWeth!);
    if (BigInt(state.weth) < amount || state.aToken !== "0")
      throw new Error("Supply principal or isolated Aave baseline changed");
    step =
      id === "approve-aave"
        ? buildAaveApproval(amount)
        : buildTestnetSupply(owner, amount);
    meta = { amount: amount.toString() };
  }
  if (
    (await c.getBlock({ blockNumber: BigInt(state.block) })).hash !== state.hash
  )
    throw new Error("Snapshot reorged before simulation");
  return { state, step, meta };
}
function mintId(receipt: TransactionReceipt): bigint {
  const ids: bigint[] = [];
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, config.positionManager)) continue;
    try {
      const e = decodeEventLog({
        abi: parseAbi([
          "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
        ]),
        data: log.data,
        topics: log.topics,
      });
      if (
        isAddressEqual(e.args.from, zeroAddress) &&
        isAddressEqual(e.args.to, owner)
      )
        ids.push(e.args.tokenId);
    } catch {}
  }
  if (ids.length !== 1) throw new Error("Expected exactly one minted NFT");
  return ids[0]!;
}
async function reconcile(id: ParkStepId): Promise<Proof> {
  const intent = parkIntent(owner, id);
  const row = db.get(intent)!;
  if (row.status === "CONFIRMED") return proof(id);
  if (!row.response)
    throw new Error(
      "Unknown submission; inspect KeeperHub execution activity. Do not resend.",
    );
  const baseline = JSON.parse(row.baseline) as Baseline;
  const result = executionResponseSchema.parse(JSON.parse(row.response).body);
  const response = await fetch(
    `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!response.ok)
    throw new Error(`Status HTTP ${response.status}; reconcile later`);
  const status = (await response.json()) as {
    executionId: string;
    transactionHash?: Hex;
    sponsored: boolean;
    receipts?: {
      hash: Hex;
      chainId: number;
      verified: boolean;
      receiptStatus: string;
    }[];
  };
  if (status.executionId !== result.executionId)
    throw new Error("Execution id mismatch");
  const txHash = (result.transactionHash ?? status.transactionHash) as
    | Hex
    | undefined;
  if (!txHash || status.transactionHash?.toLowerCase() !== txHash.toLowerCase())
    throw new Error("Transaction hash unresolved; reconcile later");
  const receipt = await c.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success")
    throw new Error("Rehearsal transaction reverted; stop");
  const tx = await c.getTransaction({ hash: txHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    owner,
    baseline.step,
    status.sponsored,
  );
  if (
    status.sponsored &&
    (
      await c.getCode({ address: owner, blockNumber: receipt.blockNumber })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw new Error("Unexpected wallet delegate");
  if (
    !status.receipts?.some(
      (r) =>
        r.hash.toLowerCase() === txHash.toLowerCase() &&
        r.chainId === 84532 &&
        r.verified &&
        r.receiptStatus === "success",
    )
  )
    throw new Error("KeeperHub verified receipt pending; reconcile later");
  const after = await snapshot(receipt.blockNumber);
  const meta = { ...baseline.meta };
  if (
    after.hash !== receipt.blockHash ||
    (await c.getBlock({ blockNumber: BigInt(baseline.state.block) })).hash !==
      baseline.state.hash
  )
    throw new Error("Evidence block changed");
  if (after.usdc !== baseline.state.usdc)
    throw new Error("Unexpected USDC movement");
  if (id === "approve-position" || id === "approve-aave") {
    const spender =
      id === "approve-position" ? config.positionManager : config.aavePool;
    const expected =
      id === "approve-position" ? TEST_DEPOSIT_WEI : BigInt(meta.amount!);
    const allowance = await c.readContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
      blockNumber: receipt.blockNumber,
    });
    if (allowance !== expected || after.weth !== baseline.state.weth)
      throw new Error("Approval delta mismatch");
  } else if (id === "mint") {
    const tokenId = mintId(receipt);
    const p = await c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    });
    const who = await c.readContract({
      address: config.positionManager,
      abi: positionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    });
    const spent = BigInt(baseline.state.weth) - BigInt(after.weth);
    if (
      !isAddressEqual(who, owner) ||
      p[5] !== meta.lower ||
      p[6] !== meta.upper ||
      p[7] === 0n ||
      spent < (TEST_DEPOSIT_WEI * 997n) / 1000n ||
      spent > TEST_DEPOSIT_WEI ||
      BigInt(after.nftCount) !== BigInt(baseline.state.nftCount) + 1n
    )
      throw new Error("Mint state mismatch");
    meta.tokenId = tokenId.toString();
    meta.liquidity = p[7].toString();
    meta.wethSpent = spent.toString();
  } else if (id === "release") {
    const p = await assertOwned(BigInt(meta.tokenId!), receipt.blockNumber);
    const released = BigInt(after.weth) - BigInt(baseline.state.weth);
    if (
      p[7] !== 0n ||
      released < (BigInt(meta.expectedWeth!) * 997n) / 1000n ||
      released > TEST_DEPOSIT_WEI ||
      after.nftCount !== baseline.state.nftCount
    )
      throw new Error("Release state mismatch");
    meta.releasedWeth = released.toString();
  } else {
    const amount = BigInt(meta.amount!);
    const delta = BigInt(after.aToken) - BigInt(baseline.state.aToken);
    if (
      BigInt(baseline.state.weth) - BigInt(after.weth) !== amount ||
      delta < amount - 2n ||
      delta > amount + 2n
    )
      throw new Error("Aave underlying/aToken delta mismatch");
    if (
      (
        await assertOwned(
          BigInt(proof("mint").meta.tokenId!),
          receipt.blockNumber,
        )
      )[7] !== 0n
    )
      throw new Error("Original NFT should remain parked");
    meta.aTokenDelta = delta.toString();
  }
  const evidence: Proof = {
    id,
    baseline,
    after,
    executionId: result.executionId,
    transactionHash: txHash,
    blockHash: receipt.blockHash,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    meta,
    sponsored: status.sponsored,
  };
  db.recordEvidence(intent, json(evidence));
  return evidence;
}
try {
  const mode = process.argv[2];
  if (!["mint", "park", "reconcile"].includes(mode ?? ""))
    throw new Error("Choose mint, park or reconcile");
  if (!owner || !isAddress(owner) || !apiKey)
    throw new Error("Verified owner and execution credential required");
  requireTestnetChain(await c.getChainId());
  const depositDb = new TestnetDepositStore(
    "artifacts/testnet-execution.sqlite",
  );
  try {
    if (depositDb.get(depositIntent(owner, 84532))?.status !== "CONFIRMED")
      throw new Error("Initial deposit must be verified");
  } finally {
    depositDb.close();
  }
  [aToken] = await c.readContract({
    address: config.aaveDataProvider,
    abi: aaveDataAbi,
    functionName: "getReserveTokensAddresses",
    args: [config.weth],
  });
  pool = await c.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [config.weth, config.aaveUsdc, 500],
  });
  if (pool === zeroAddress) throw new Error("Testnet pool missing");
  const steps = mode === "mint" ? PARK_STEPS.slice(0, 2) : PARK_STEPS;
  for (const id of steps) {
    if (!db.get(parkIntent(owner, id))) {
      if (mode === "reconcile") break;
      const baseline = await build(id);
      await submitParkStep({
        step: baseline.step,
        owner,
        chainId: await c.getChainId(),
        apiKey,
        baseline: json(baseline),
        store: db,
      });
    }
    const evidence = await reconcile(id);
    console.log(
      json({
        step: id,
        executionId: evidence.executionId,
        tx: evidence.transactionHash,
        meta: evidence.meta,
      }),
    );
    const proofs = PARK_STEPS.filter(
      (s) => db.get(parkIntent(owner, s))?.status === "CONFIRMED",
    ).map(proof);
    await writeFile(
      "artifacts/testnet-park.json",
      json({
        mode: "MANUAL_BASE_SEPOLIA_PARK_REHEARSAL",
        chainId: 84532,
        keeperhubExecution: true,
        policyDecision: false,
        owner,
        originalPrincipal: TEST_DEPOSIT_WEI,
        pool,
        aToken,
        steps: proofs,
        complete: proofs.length === PARK_STEPS.length,
      }),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet rehearsal failed",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
