import { verifiedTestnetExecution } from "./execution-status.js";
import { decodeEventLog, erc20Abi, isAddressEqual, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";
import { hash } from "../core/serialization.js";
import { decodeRun, encodeRun } from "../state/return-runs.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import { TestnetDepositStore, executionResponseSchema } from "./execution.js";
import {
  buildAaveApproval,
  buildTestnetRelease,
  buildTestnetSupply,
  requirePrincipal,
  type TestnetStep,
} from "./park-plan.js";
import { verifyParkTransaction } from "./park-executor.js";
import { defaultReturnPolicy } from "./return-policy.js";
import { readReturnWalletState, type ReturnWalletState } from "./return-receipts.js";
import type { TestnetReturnClient } from "./return-reader.js";
import { REPARK_STEPS, reparkIntent, type ReparkAnchor, type ReparkId } from "./repark-context.js";
import { TESTNET_GAS_DELEGATE } from "./receipt.js";

export type ReparkState = ReturnWalletState & { aaveAllowance: bigint; scaledAToken: bigint };
export type ReparkBaseline = {
  anchor: ReparkAnchor;
  state: ReparkState;
  call: TestnetStep;
  amount: bigint;
  createdAt: number;
};
export const reparkEvents = parseAbi([
  "event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)",
  "event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)",
  "event Mint(address indexed caller,address indexed onBehalfOf,uint256 value,uint256 balanceIncrease,uint256 index)",
]);
export async function readReparkState(
  client: TestnetReturnClient,
  anchor: ReparkAnchor,
  blockNumber?: bigint,
): Promise<ReparkState> {
  const pinned = blockNumber ?? (await client.getBlock()).number - 2n;
  const state = await readReturnWalletState(client, anchor.lot, defaultReturnPolicy, pinned);
  const [aaveAllowance, scaledAToken] = await Promise.all([
    client.readContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "allowance",
      args: [anchor.lot.owner, config.aavePool],
      blockNumber: pinned,
    }),
    client.readContract({
      address: state.snapshot.market.aToken,
      abi: parseAbi(["function scaledBalanceOf(address user) view returns (uint256)"]),
      functionName: "scaledBalanceOf",
      args: [anchor.lot.owner],
      blockNumber: pinned,
    }),
  ]);
  if ((await client.getBlock({ blockNumber: pinned })).hash !== state.snapshot.position.block.hash)
    throw new Error("Re-PARK read block changed");
  return { ...state, aaveAllowance, scaledAToken };
}
function identity(anchor: ReparkAnchor, state: ReparkState) {
  const lot = anchor.lot,
    p = state.snapshot.position;
  requireTestnetChain(lot.chainId);
  requireTestnetChain(p.chainId);
  requirePrincipal(lot.principal);
  if (
    lot.status !== "RESTORED" ||
    hash(lot) !== hash(state.snapshot.lot) ||
    p.tokenId !== lot.tokenId ||
    !isAddressEqual(p.owner, lot.owner) ||
    !isAddressEqual(p.pool, lot.pool) ||
    p.fee !== 500 ||
    lot.fee !== 500 ||
    p.tickLower !== lot.lower ||
    p.tickUpper !== lot.upper ||
    !isAddressEqual(p.token0.address, config.weth) ||
    !isAddressEqual(p.token1.address, config.aaveUsdc) ||
    !isAddressEqual(lot.asset, config.weth) ||
    !isAddressEqual(lot.token0, config.weth) ||
    !isAddressEqual(lot.token1, config.aaveUsdc)
  )
    throw new Error("Re-PARK original NFT or allocation identity changed");
}
export function buildReparkStep(
  id: ReparkId,
  anchor: ReparkAnchor,
  state: ReparkState,
  amount: bigint,
  now: number,
): TestnetStep {
  identity(anchor, state);
  const p = state.snapshot.position,
    m = state.snapshot.market;
  if (now < p.block.timestamp || now - p.block.timestamp >= 60)
    throw new Error("Stale re-PARK state");
  if (!m.active || m.paused || m.frozen || state.snapshot.totalDebtBase !== 0n)
    throw new Error("Aave account or market blocks re-PARK");
  if (p.currentTick >= anchor.lot.lower || p.twapTick === null || p.twapTick >= anchor.lot.lower)
    throw new Error("WETH-only re-PARK requires spot/TWAP below original range");
  if (state.snapshot.oracle.cardinalityNext < 16)
    throw new Error("Reserve oracle history before re-PARK");
  requirePrincipal(amount);
  if (
    amount > anchor.lot.principal ||
    (m.supplyCapRemaining !== null && m.supplyCapRemaining < amount)
  )
    throw new Error("Re-PARK exceeds allocation or supply capacity");
  if (id === "release") {
    if (
      p.liquidity !== anchor.liquidity ||
      p.liquidity <= 0n ||
      p.principal1 !== 0n ||
      p.checkpointOwed1 !== 0n ||
      p.principal0 !== amount
    )
      throw new Error("Original restored liquidity or single-asset principal changed");
    return buildTestnetRelease(anchor.lot.owner, anchor.lot.tokenId, p.liquidity, amount, now);
  }
  if (p.liquidity !== 0n || state.wallet0 < amount)
    throw new Error("Verified released principal unavailable");
  if (id === "approve-aave") return buildAaveApproval(amount);
  if (id !== "supply" || state.aaveAllowance !== amount)
    throw new Error("Exact Aave allowance required");
  return buildTestnetSupply(anchor.lot.owner, amount);
}
export function verifyReparkDelta(
  id: ReparkId,
  before: ReparkBaseline,
  after: ReparkState,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): bigint {
  identity(before.anchor, before.state);
  identity(before.anchor, after);
  const a = before.state,
    lot = before.anchor.lot;
  if (
    after.nftCount !== a.nftCount ||
    after.wallet1 !== a.wallet1 ||
    after.snapshot.position.liquidity !== 0n
  )
    throw new Error("Re-PARK NFT or USDC delta mismatch");
  const parse = <N extends "DecreaseLiquidity" | "Collect" | "Supply" | "Mint">(
    name: N,
    address: Address,
  ) =>
    logs
      .filter((l) => isAddressEqual(l.address, address))
      .flatMap((l) => {
        try {
          const decoded = decodeEventLog({
            abi: reparkEvents,
            eventName: name,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return decoded.eventName === name ? [decoded.args] : [];
        } catch {
          return [];
        }
      });
  if (id === "release") {
    const decreases = parse("DecreaseLiquidity", config.positionManager),
      collects = parse("Collect", config.positionManager);
    const d = decreases[0],
      c = collects[0],
      delta = after.wallet0 - a.wallet0;
    if (
      decreases.length !== 1 ||
      collects.length !== 1 ||
      !d ||
      !c ||
      d.tokenId !== lot.tokenId ||
      c.tokenId !== lot.tokenId ||
      d.liquidity !== before.anchor.liquidity ||
      d.amount1 !== 0n ||
      c.amount1 !== 0n ||
      !isAddressEqual(c.recipient, lot.owner) ||
      c.amount0 !== delta ||
      delta <= 0n ||
      delta > lot.principal ||
      d.amount0 < (before.amount * 997n) / 1000n ||
      d.amount0 > delta ||
      a.scaledAToken !== after.scaledAToken
    )
      throw new Error("Re-PARK release events or attributed principal mismatch");
    return delta;
  }
  if (id === "approve-aave") {
    if (
      after.aaveAllowance !== before.amount ||
      after.wallet0 !== a.wallet0 ||
      after.scaledAToken !== a.scaledAToken
    )
      throw new Error("Re-PARK approval changed principal or allowance");
    return before.amount;
  }
  const supplies = parse("Supply", config.aavePool),
    mints = parse("Mint", a.snapshot.market.aToken),
    s = supplies[0],
    m = mints[0];
  if (
    supplies.length !== 1 ||
    mints.length !== 1 ||
    !s ||
    !m ||
    !isAddressEqual(s.reserve, config.weth) ||
    !isAddressEqual(s.user, lot.owner) ||
    !isAddressEqual(s.onBehalfOf, lot.owner) ||
    s.amount !== before.amount ||
    !isAddressEqual(m.caller, lot.owner) ||
    !isAddressEqual(m.onBehalfOf, lot.owner) ||
    m.index <= 0n ||
    m.value < m.balanceIncrease ||
    after.wallet0 !== a.wallet0 - before.amount
  )
    throw new Error("Re-PARK supply recipient, event or wallet delta mismatch");
  const net = m.value - m.balanceIncrease,
    scaled = after.scaledAToken - a.scaledAToken,
    numerator = before.amount * 10n ** 27n;
  if (
    net < before.amount - 2n ||
    net > before.amount + 2n ||
    scaled <= 0n ||
    scaled < numerator / m.index ||
    scaled > (numerator + m.index - 1n) / m.index
  )
    throw new Error("Re-PARK scaled share delta includes unrelated capital");
  return before.amount;
}
export async function verifyReparkParent(client: TestnetReturnClient, anchor: ReparkAnchor) {
  const receipt = await client.getTransactionReceipt({ hash: anchor.restorationHash });
  if (
    receipt.status !== "success" ||
    receipt.blockHash !== anchor.block.hash ||
    receipt.blockNumber !== anchor.block.number
  )
    throw new Error("Parent restoration receipt changed");
  const tx = await client.getTransaction({ hash: anchor.restorationHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    anchor.lot.owner,
    anchor.parentCall,
    anchor.sponsored,
  );
  if ((await client.getBlock({ blockNumber: anchor.block.number })).hash !== anchor.block.hash)
    throw new Error("Parent restoration reorged");
  if (
    anchor.sponsored &&
    (
      await client.getCode({ address: anchor.lot.owner, blockNumber: anchor.block.number })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw new Error("Parent signer delegate changed");
}
function priorAmount(store: TestnetDepositStore, anchor: ReparkAnchor, id: ReparkId) {
  for (const prior of REPARK_STEPS.slice(0, REPARK_STEPS.indexOf(id)))
    if (store.get(reparkIntent(anchor, prior))?.status !== "CONFIRMED")
      throw new Error("Re-PARK dependency unconfirmed");
  if (id === "release") return null;
  const record = store.get(reparkIntent(anchor, "release"))!;
  const proof = decodeRun<{ anchor: ReparkAnchor; amount: bigint }>(record.evidence!);
  if (hash(proof.anchor) !== hash(anchor))
    throw new Error("Re-PARK release belongs to another allocation");
  return proof.amount;
}
export async function submitReparkStep(args: {
  client: TestnetReturnClient;
  anchor: ReparkAnchor;
  id: ReparkId;
  store: TestnetDepositStore;
  apiKey: string;
  manualRehearsal: boolean;
  fetcher?: typeof fetch;
  clock?: () => number;
  readState?: typeof readReparkState;
  verifyParent?: typeof verifyReparkParent;
}) {
  const { client, anchor, id, store } = args,
    clock = args.clock ?? (() => Math.floor(Date.now() / 1000)),
    fetcher = args.fetcher ?? fetch,
    readState = args.readState ?? readReparkState;
  if (!args.manualRehearsal) throw new Error("Explicit manual testnet rehearsal required");
  if (!args.apiKey.trim()) throw new Error("Testnet credential required");
  requireTestnetChain(await client.getChainId());
  const intent = reparkIntent(anchor, id);
  if (store.get(intent))
    throw new Error("Re-PARK step already started; reconcile without resending");
  const capital = priorAmount(store, anchor, id);
  await (args.verifyParent ?? verifyReparkParent)(client, anchor);
  const state = await readState(client, anchor),
    amount = capital ?? state.snapshot.position.principal0,
    now = clock();
  const call = buildReparkStep(id, anchor, state, amount, now),
    request = JSON.stringify(call.request),
    headers = { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" };
  const response = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers,
    body: JSON.stringify({ ...call.request, simulate: true }),
  });
  if (!response.ok) throw new Error(`Re-PARK simulation HTTP ${response.status}`);
  const sim = z
    .object({
      success: z.literal(true),
      status: z.literal("simulated"),
      wouldRevert: z.literal(false),
      from: z.string(),
      to: z.string(),
      value: z.literal("0"),
      gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
    })
    .parse(await response.json());
  if (
    !isAddressEqual(sim.from as Address, anchor.lot.owner) ||
    !isAddressEqual(sim.to as Address, call.request.contractAddress)
  )
    throw new Error("Re-PARK simulation sender/target mismatch");
  const fresh = await readState(client, anchor),
    freshNow = clock();
  // Check freshness with the current time, then reconstruct using the original deadline.
  buildReparkStep(id, anchor, fresh, amount, freshNow);
  const reconstructed =
    id === "release"
      ? buildTestnetRelease(
          anchor.lot.owner,
          anchor.lot.tokenId,
          fresh.snapshot.position.liquidity,
          amount,
          now,
        )
      : buildReparkStep(id, anchor, fresh, amount, freshNow);
  if (hash(reconstructed) !== hash(call)) throw new Error("Frozen re-PARK call changed");
  if (freshNow < now || freshNow - now >= 60) throw new Error("Re-PARK simulation expired");
  if (priorAmount(store, anchor, id) !== capital)
    throw new Error("Re-PARK capital changed during simulation");
  requireTestnetChain(await client.getChainId());
  store.claim(
    intent,
    request,
    encodeRun({ anchor, state: fresh, call, amount, createdAt: now } satisfies ReparkBaseline),
  );
  const written = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { ...headers, "Idempotency-Key": intent },
    body: request,
  });
  const body: unknown = await written.json();
  store.recordResponse(intent, { httpStatus: written.status, body });
  if (!written.ok) throw new Error(`Re-PARK submission HTTP ${written.status}; reconcile only`);
  return executionResponseSchema.parse(body);
}
export async function reconcileReparkStep(
  client: TestnetReturnClient,
  anchor: ReparkAnchor,
  id: ReparkId,
  store: TestnetDepositStore,
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(await client.getChainId());
  const intent = reparkIntent(anchor, id),
    row = store.get(intent);
  if (row?.status === "CONFIRMED") return decodeRun<ReparkProof>(row.evidence!);
  if (row?.status !== "RECONCILE" || !row.response)
    throw new Error("Unknown re-PARK submission; never resend");
  priorAmount(store, anchor, id);
  const baseline = decodeRun<ReparkBaseline>(row.baseline),
    result = executionResponseSchema.parse(JSON.parse(row.response).body);
  if (
    hash(baseline.anchor) !== hash(anchor) ||
    hash(baseline.call.request) !== hash(JSON.parse(row.request)) ||
    baseline.call.id !== id
  )
    throw new Error("Re-PARK journal context mismatch");
  const response = await fetcher(
    `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!response.ok) throw new Error(`Re-PARK status HTTP ${response.status}`);
  const status = verifiedTestnetExecution(
    await response.json(),
    result.executionId,
    response.headers,
  );
  const txHash = status.transactionHash as Hex;
  if (result.transactionHash && result.transactionHash.toLowerCase() !== txHash.toLowerCase())
    throw new Error("Re-PARK transaction hash changed");
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success") throw new Error("Re-PARK reverted; no retry");
  const tx = await client.getTransaction({ hash: txHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    anchor.lot.owner,
    baseline.call,
    status.sponsored,
  );
  if (
    status.sponsored &&
    (
      await client.getCode({ address: anchor.lot.owner, blockNumber: receipt.blockNumber })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw new Error("Unexpected re-PARK delegate");
  await verifyReparkParent(client, anchor);
  const after = await readReparkState(client, anchor, receipt.blockNumber),
    block = baseline.state.snapshot.position.block;
  if (
    after.snapshot.position.block.hash !== receipt.blockHash ||
    receipt.blockNumber < block.number ||
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw new Error("Re-PARK evidence reorged");
  const amount = verifyReparkDelta(id, baseline, after, receipt.logs);
  const proof = {
    id,
    anchor,
    baseline,
    after,
    amount,
    transactionHash: txHash,
    executionId: result.executionId,
    sponsored: status.sponsored,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
  };
  store.recordEvidence(intent, encodeRun(proof));
  return proof;
}
export type ReparkProof = {
  id: ReparkId;
  anchor: ReparkAnchor;
  baseline: ReparkBaseline;
  after: ReparkState;
  amount: bigint;
  transactionHash: Hex;
  executionId: string;
  sponsored: boolean;
  explorerUrl: string;
};
