import { decodeEventLog, erc20Abi, isAddressEqual, parseAbi, type Hex } from "viem";
import { z } from "zod";
import { hash } from "../core/serialization.js";
import { BASE_SEPOLIA as config } from "./config.js";
import { readReturnSnapshot, type TestnetReturnClient } from "./return-reader.js";
import { verifyParkTransaction } from "./park-executor.js";
import { TESTNET_GAS_DELEGATE } from "./receipt.js";
import { executionResponseSchema } from "./execution.js";
import { decodeRun, type RunStep } from "../state/return-runs.js";
import type { ParkedLot, ReturnPolicy, ReturnSnapshot } from "./return-policy.js";
import type { AttributedCapital, ReturnCall, ReturnStepId, StageDraft } from "./return-stages.js";

export type ReturnWalletState = {
  snapshot: ReturnSnapshot;
  wallet0: bigint;
  wallet1: bigint;
  nftCount: bigint;
  swapAllowance: bigint;
  lp0Allowance: bigint;
  lp1Allowance: bigint;
};
export type ReturnBaseline = {
  state: ReturnWalletState;
  capital: AttributedCapital;
  plan: StageDraft;
};
const eventsAbi = parseAbi([
  "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
type Log = { address: `0x${string}`; data: Hex; topics: readonly Hex[] };

export async function readReturnWalletState(
  client: TestnetReturnClient,
  lot: ParkedLot,
  policy: ReturnPolicy,
  blockNumber?: bigint,
): Promise<ReturnWalletState> {
  const snapshot = await readReturnSnapshot(client, lot, policy, blockNumber);
  const block = snapshot.position.block;
  const [wallet0, wallet1, nftCount, swapAllowance, lp0Allowance, lp1Allowance] = await Promise.all(
    [
      ...[config.weth, config.aaveUsdc, config.positionManager].map((address) =>
        client.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [lot.owner],
          blockNumber: block.number,
        }),
      ),
      ...[
        [config.weth, config.swapRouter],
        [config.weth, config.positionManager],
        [config.aaveUsdc, config.positionManager],
      ].map(([address, spender]) =>
        client.readContract({
          address: address!,
          abi: erc20Abi,
          functionName: "allowance",
          args: [lot.owner, spender!],
          blockNumber: block.number,
        }),
      ),
    ],
  );
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
    throw new Error("Wallet snapshot reorged");
  return {
    snapshot,
    wallet0: wallet0!,
    wallet1: wallet1!,
    nftCount: nftCount!,
    swapAllowance: swapAllowance!,
    lp0Allowance: lp0Allowance!,
    lp1Allowance: lp1Allowance!,
  };
}
function identity(state: ReturnWalletState, lot: ParkedLot) {
  const p = state.snapshot.position;
  if (
    p.chainId !== 84532 ||
    p.tokenId !== lot.tokenId ||
    !isAddressEqual(p.owner, lot.owner) ||
    !isAddressEqual(p.pool, lot.pool) ||
    !isAddressEqual(p.token0.address, lot.token0) ||
    !isAddressEqual(p.token1.address, lot.token1) ||
    p.tickLower !== lot.lower ||
    p.tickUpper !== lot.upper ||
    p.fee !== lot.fee
  )
    throw new Error("Original NFT identity changed in receipt state");
}
export function verifyReturnDelta(
  id: ReturnStepId,
  baseline: ReturnBaseline,
  after: ReturnWalletState,
  logs: readonly Log[],
): AttributedCapital {
  const { state: before, capital, plan } = baseline;
  const lot = before.snapshot.lot;
  identity(before, lot);
  identity(after, lot);
  if (before.snapshot.position.liquidity !== 0n || before.nftCount !== after.nftCount)
    throw new Error("Unexpected NFT count or initial liquidity");
  const delta0 = after.wallet0 - before.wallet0,
    delta1 = after.wallet1 - before.wallet1;
  let next = { ...capital };
  if (id === "withdraw") {
    const events = logs
      .filter((l) => isAddressEqual(l.address, config.aavePool))
      .flatMap((l) => {
        try {
          const e = decodeEventLog({
            abi: eventsAbi,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return e.eventName === "Withdraw" ? [e.args] : [];
        } catch {
          return [];
        }
      });
    const e = events[0];
    if (
      events.length !== 1 ||
      !e ||
      !isAddressEqual(e.reserve, lot.asset) ||
      !isAddressEqual(e.user, lot.owner) ||
      !isAddressEqual(e.to, lot.owner) ||
      e.amount !== lot.principal ||
      delta0 !== lot.principal ||
      delta1 !== 0n ||
      after.snapshot.aTokenBalance >= before.snapshot.aTokenBalance ||
      after.snapshot.aTokenBalance < before.snapshot.aTokenBalance - lot.principal - 2n ||
      capital.amount0 !== 0n ||
      capital.amount1 !== 0n
    )
      throw new Error("Withdrawal receipt or principal delta mismatch");
    next = { amount0: delta0, amount1: 0n };
  } else if (id.startsWith("approve-")) {
    const expected =
      id === "approve-swap"
        ? plan.amounts.input
        : id === "approve-lp0"
          ? plan.amounts.desired0
          : plan.amounts.desired1;
    const allowance =
      id === "approve-swap"
        ? after.swapAllowance
        : id === "approve-lp0"
          ? after.lp0Allowance
          : after.lp1Allowance;
    if (delta0 !== 0n || delta1 !== 0n || allowance !== expected)
      throw new Error("Approval changed funds or allowance mismatch");
  } else if (id === "swap") {
    const swaps = logs
      .filter((l) => isAddressEqual(l.address, lot.pool))
      .flatMap((l) => {
        try {
          const e = decodeEventLog({
            abi: eventsAbi,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return e.eventName === "Swap" ? [e.args] : [];
        } catch {
          return [];
        }
      });
    const swap = swaps[0];
    if (
      swaps.length !== 1 ||
      !swap ||
      !isAddressEqual(swap.sender, config.swapRouter) ||
      !isAddressEqual(swap.recipient, lot.owner) ||
      swap.amount0 !== -delta0 ||
      swap.amount1 !== -delta1 ||
      delta0 !== -plan.amounts.input ||
      delta1 < plan.amounts.minimumOut ||
      delta1 <= 0n ||
      -delta0 > capital.amount0
    )
      throw new Error("Swap did not spend exact attributed input or meet minimum output");
    next = { amount0: capital.amount0 + delta0, amount1: capital.amount1 + delta1 };
  } else if (id === "increase") {
    const spent0 = -delta0,
      spent1 = -delta1;
    const events = logs
      .filter((l) => isAddressEqual(l.address, config.positionManager))
      .flatMap((l) => {
        try {
          const e = decodeEventLog({
            abi: eventsAbi,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return e.eventName === "IncreaseLiquidity" ? [e.args] : [];
        } catch {
          return [];
        }
      });
    const e = events[0];
    if (
      events.length !== 1 ||
      !e ||
      e.tokenId !== lot.tokenId ||
      e.amount0 !== spent0 ||
      e.amount1 !== spent1 ||
      e.liquidity <= 0n ||
      e.liquidity !== after.snapshot.position.liquidity ||
      spent0 < plan.amounts.minimum0 ||
      spent1 < plan.amounts.minimum1 ||
      spent0 > plan.amounts.desired0 ||
      spent1 > plan.amounts.desired1 ||
      spent0 > capital.amount0 ||
      spent1 > capital.amount1
    )
      throw new Error("Same-NFT increase receipt/delta mismatch");
    next = { amount0: capital.amount0 - spent0, amount1: capital.amount1 - spent1 };
  } else throw new Error("Unknown RETURN step");
  if (id !== "increase" && after.snapshot.position.liquidity !== 0n)
    throw new Error("NFT changed before increase");
  if (next.amount0 < 0n || next.amount1 < 0n) throw new Error("Negative strategy capital");
  return next;
}

export async function verifyReturnReceipt(
  client: TestnetReturnClient,
  row: RunStep,
  policy: ReturnPolicy,
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  if (row.status !== "RECONCILE" || !row.response || !row.baseline || !row.call)
    throw new Error("Unknown submission; inspect KeeperHub activity and never resend");
  const response = decodeRun<{ httpStatus: number; body: unknown }>(row.response);
  const result = executionResponseSchema.parse(response.body);
  const baseline = decodeRun<ReturnBaseline>(row.baseline),
    call = decodeRun<ReturnCall>(row.call);
  const lot = baseline.state.snapshot.lot;
  if (
    row.cycle_id !== lot.cycleId ||
    row.id !== call.id ||
    row.plan_hash !== baseline.plan.planHash ||
    !baseline.plan.calls.some((c) => hash(c) === hash(call))
  )
    throw new Error("Recorded receipt context mismatch");
  const statusResponse = await fetcher(
    `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!statusResponse.ok) throw new Error(`Receipt status HTTP ${statusResponse.status}`);
  const status = z
    .object({
      executionId: z.literal(result.executionId),
      sponsored: z.boolean(),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      receipts: z.array(
        z.object({
          hash: z.string(),
          chainId: z.number(),
          verified: z.boolean(),
          receiptStatus: z.string(),
        }),
      ),
    })
    .parse(await statusResponse.json());
  const txHash = status.transactionHash as Hex;
  if (result.transactionHash && result.transactionHash.toLowerCase() !== txHash.toLowerCase())
    throw new Error("KeeperHub transaction hash changed");
  if (
    !status.receipts.some(
      (r) =>
        r.hash.toLowerCase() === txHash.toLowerCase() &&
        r.chainId === 84532 &&
        r.verified &&
        r.receiptStatus === "success",
    )
  )
    throw new Error("Chain-verified KeeperHub receipt not yet available");
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success") throw new Error("RETURN transaction reverted; no retry");
  const tx = await client.getTransaction({ hash: txHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    lot.owner,
    call,
    status.sponsored,
  );
  if (
    status.sponsored &&
    (
      await client.getCode({ address: lot.owner, blockNumber: receipt.blockNumber })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw new Error("Unexpected sponsored wallet delegate");
  const after = await readReturnWalletState(client, lot, policy, receipt.blockNumber);
  const beforeBlock = baseline.state.snapshot.position.block;
  if (
    after.snapshot.position.block.hash !== receipt.blockHash ||
    receipt.blockNumber < beforeBlock.number ||
    (await client.getBlock({ blockNumber: beforeBlock.number })).hash !== beforeBlock.hash
  )
    throw new Error("Receipt or baseline block reorged");
  const capital = verifyReturnDelta(call.id, baseline, after, receipt.logs);
  return {
    step: call.id,
    chainId: 84532,
    executionId: status.executionId,
    transactionHash: txHash,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    sponsored: status.sponsored,
    planHash: baseline.plan.planHash,
    before: baseline.state,
    after,
    capital,
  };
}
