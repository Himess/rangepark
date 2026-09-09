import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
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
  executionResponseSchema,
} from "../src/testnet/execution.js";
import {
  parkIntent,
  verifyParkTransaction,
} from "../src/testnet/park-executor.js";
import { TESTNET_GAS_DELEGATE } from "../src/testnet/receipt.js";
import {
  buildRestoreStep,
  RESTORE_STEPS,
  type RestoreId,
  type RestoreContext,
  type RestoreStep,
} from "../src/testnet/restore-plan.js";
import {
  restoreIntent,
  submitRestoreStep,
} from "../src/testnet/restore-executor.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const db = new TestnetDepositStore("artifacts/testnet-restore.sqlite");
const parkDb = new TestnetDepositStore("artifacts/testnet-park.sqlite");
const c = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpc, { timeout: 20000, retryCount: 1 }),
});
const owner = process.env.KEEPERHUB_EXPECTED_SENDER as Address;
const apiKey = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
type State = {
  block: bigint;
  hash: Hex;
  timestamp: number;
  tick: number;
  weth: bigint;
  usdc: bigint;
  aToken: bigint;
  nftCount: bigint;
  liquidity: bigint;
};
type Baseline = { state: State; step: RestoreStep; context: RestoreContext };
let tokenId: bigint;
let principal: bigint;
let lower: number;
let upper: number;
let aToken: Address;
let pool: Address;
async function state(blockNumber?: bigint): Promise<State> {
  const block = await c.getBlock(
    blockNumber === undefined ? {} : { blockNumber },
  );
  const [p, who, slot, weth, usdc, at, nftCount] = await Promise.all([
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
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
      blockNumber: block.number,
    }),
    ...[config.weth, config.aaveUsdc, aToken, config.positionManager].map(
      (address) =>
        c.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
          blockNumber: block.number,
        }),
    ),
  ]);
  if (
    !isAddressEqual(who, owner) ||
    !isAddressEqual(p[2], config.weth) ||
    !isAddressEqual(p[3], config.aaveUsdc) ||
    p[4] !== 500 ||
    p[5] !== lower ||
    p[6] !== upper
  )
    throw new Error("Original NFT owner, pair or range changed");
  return {
    block: block.number,
    hash: block.hash,
    timestamp: Number(block.timestamp),
    tick: slot[1],
    weth: weth!,
    usdc: usdc!,
    aToken: at!,
    nftCount: nftCount!,
    liquidity: p[7],
  };
}
function parseBaseline(value: string): Baseline {
  const b = JSON.parse(value) as Baseline;
  for (const k of [
    "block",
    "weth",
    "usdc",
    "aToken",
    "nftCount",
    "liquidity",
  ] as const)
    b.state[k] = BigInt(b.state[k]);
  b.context.tokenId = BigInt(b.context.tokenId);
  b.context.principal = BigInt(b.context.principal);
  return b;
}
async function reconcile(id: RestoreId) {
  const intent = restoreIntent(owner, id);
  const row = db.get(intent)!;
  if (row.status === "CONFIRMED") return JSON.parse(row.evidence!);
  if (!row.response)
    throw new Error(
      "Unknown submission; inspect KeeperHub activity and do not resend",
    );
  const baseline = parseBaseline(row.baseline);
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
  const hash = (result.transactionHash ?? status.transactionHash) as
    | Hex
    | undefined;
  if (
    status.executionId !== result.executionId ||
    !hash ||
    status.transactionHash?.toLowerCase() !== hash.toLowerCase()
  )
    throw new Error("Restoration execution identity/hash unresolved");
  const receipt = await c.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success")
    throw new Error("Restoration reverted; do not resend");
  const tx = await c.getTransaction({ hash });
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
        r.hash.toLowerCase() === hash.toLowerCase() &&
        r.chainId === 84532 &&
        r.verified &&
        r.receiptStatus === "success",
    )
  )
    throw new Error("Verified KeeperHub receipt pending");
  const after = await state(receipt.blockNumber);
  const before = baseline.state;
  if (
    after.hash !== receipt.blockHash ||
    (await c.getBlock({ blockNumber: before.block })).hash !== before.hash
  )
    throw new Error("Evidence block changed");
  if (after.usdc !== before.usdc || after.nftCount !== before.nftCount)
    throw new Error("Unexpected token or NFT count movement");
  if (id === "withdraw-principal") {
    const withdrawals = receipt.logs
      .filter((l) => isAddressEqual(l.address, config.aavePool))
      .flatMap((l) => {
        try {
          return [
            decodeEventLog({
              abi: parseAbi([
                "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
              ]),
              data: l.data,
              topics: l.topics,
            }).args,
          ];
        } catch {
          return [];
        }
      });
    if (
      withdrawals.length !== 1 ||
      !isAddressEqual(withdrawals[0]!.reserve, config.weth) ||
      !isAddressEqual(withdrawals[0]!.user, owner) ||
      !isAddressEqual(withdrawals[0]!.to, owner) ||
      withdrawals[0]!.amount !== principal ||
      after.weth - before.weth !== principal ||
      after.aToken >= before.aToken ||
      after.aToken < before.aToken - principal - 2n ||
      after.liquidity !== 0n
    )
      throw new Error("Withdrawal event or balance delta mismatch");
  } else if (id === "approve-restore") {
    const allowance = await c.readContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, config.positionManager],
      blockNumber: after.block,
    });
    if (
      allowance !== principal ||
      after.weth !== before.weth ||
      after.liquidity !== 0n
    )
      throw new Error("Restoration allowance mismatch");
  } else {
    const spent = before.weth - after.weth;
    if (
      before.liquidity !== 0n ||
      after.liquidity <= 0n ||
      spent < (principal * 997n) / 1000n ||
      spent > principal
    )
      throw new Error("Same-NFT restoration delta mismatch");
  }
  const evidence = {
    id,
    executionId: result.executionId,
    transactionHash: hash,
    explorerUrl: `https://sepolia.basescan.org/tx/${hash}`,
    sponsored: status.sponsored,
    baseline,
    after,
  };
  db.recordEvidence(intent, json(evidence));
  return evidence;
}
try {
  const mode = process.argv[2];
  const manual = process.argv.includes("--manual-rehearsal");
  if (mode !== "execute" && mode !== "reconcile")
    throw new Error("Choose execute or reconcile");
  if (mode === "execute" && !manual)
    throw new Error(
      "Explicit --manual-rehearsal required; automatic RETURN is not implemented here",
    );
  if (!owner || !isAddress(owner) || !apiKey)
    throw new Error("Verified owner and execution credential required");
  requireTestnetChain(await c.getChainId());
  const mintRow = parkDb.get(parkIntent(owner, "mint"));
  const supplyRow = parkDb.get(parkIntent(owner, "supply"));
  if (mintRow?.status !== "CONFIRMED" || supplyRow?.status !== "CONFIRMED")
    throw new Error("Verified PARK journal required");
  const mint = JSON.parse(mintRow.evidence!);
  const supply = JSON.parse(supplyRow.evidence!);
  tokenId = BigInt(mint.meta.tokenId);
  principal = BigInt(supply.meta.amount);
  lower = mint.meta.lower;
  upper = mint.meta.upper;
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
  const evidence: unknown[] = [];
  for (const id of RESTORE_STEPS) {
    if (!db.get(restoreIntent(owner, id))) {
      if (mode === "reconcile") break;
      requireTestnetChain(await c.getChainId());
      const snapshot = await state();
      if (snapshot.liquidity !== 0n)
        throw new Error("Original NFT must be empty before restoration");
      if (id === "withdraw-principal" && snapshot.aToken < principal)
        throw new Error("Aave principal unavailable");
      if (id !== "withdraw-principal" && snapshot.weth < principal)
        throw new Error("Confirmed withdrawn principal unavailable");
      const context: RestoreContext = {
        owner,
        tokenId,
        principal,
        lower,
        upper,
        tick: snapshot.tick,
        now: snapshot.timestamp,
        manualRehearsal: manual,
      };
      const baseline = {
        state: snapshot,
        context,
        step: buildRestoreStep(id, context),
      };
      if (
        (await c.getBlock({ blockNumber: snapshot.block })).hash !==
        snapshot.hash
      )
        throw new Error("Reorged baseline");
      await submitRestoreStep({
        id,
        context,
        chainId: await c.getChainId(),
        apiKey,
        store: db,
        baseline: json(baseline),
      });
    }
    const verified = await reconcile(id);
    evidence.push(verified);
    console.log(
      json({
        step: id,
        executionId: verified.executionId,
        tx: verified.transactionHash,
        after: verified.after,
      }),
    );
    await writeFile(
      "artifacts/testnet-restore.json",
      json({
        mode: "MANUAL_BASE_SEPOLIA_PRINCIPAL_RESTORATION",
        chainId: 84532,
        keeperhubExecution: true,
        policyDecision: false,
        rangeTriggeredReturn: false,
        owner,
        tokenId,
        originalRange: { lower, upper },
        principalRestored: principal,
        interestHandling:
          "Accrued Aave claim remains in the owner's wallet; only supplied principal is restored",
        steps: evidence,
        complete: evidence.length === RESTORE_STEPS.length,
      }),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet restoration failed",
  );
  process.exitCode = 1;
} finally {
  db.close();
  parkDb.close();
}
