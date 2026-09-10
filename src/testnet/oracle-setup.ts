import {
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { hash, json } from "../core/serialization.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import { TestnetDepositStore, executionResponseSchema } from "./execution.js";
import { defaultReturnPolicy, type ParkedLot } from "./return-policy.js";
import { readReturnWalletState, type ReturnWalletState } from "./return-receipts.js";
import type { TestnetReturnClient } from "./return-reader.js";
import { verifyParkTransaction } from "./park-executor.js";
import { TESTNET_GAS_DELEGATE } from "./receipt.js";
import { decodeRun, encodeRun } from "../state/return-runs.js";

export const oracleSetupAbi = parseAbi([
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
  "event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld,uint16 observationCardinalityNextNew)",
]);
export const ORACLE_CAPACITY = 16;
// The public sequencer can report a tip timestamp just ahead of the local clock.
// Read two blocks behind the tip; keep the same strict age and canonical-hash checks.
export const readOracleSetupState: typeof readReturnWalletState = async (
  client,
  lot,
  policy,
  blockNumber,
) => {
  const pinned = blockNumber ?? (await client.getBlock()).number - 2n;
  if (pinned < 0n) throw new Error("Oracle chain has insufficient history");
  return readReturnWalletState(client, lot, policy, pinned);
};
export function oracleSetupIntent(owner: Address, pool: Address) {
  return hash({
    namespace: "rangepark-base-sepolia-oracle-16-v1",
    owner: owner.toLowerCase(),
    pool: pool.toLowerCase(),
  });
}
function identity(state: ReturnWalletState) {
  const p = state.snapshot.position,
    lot = state.snapshot.lot;
  requireTestnetChain(p.chainId);
  requireTestnetChain(lot.chainId);
  if (
    !isAddressEqual(p.owner, lot.owner) ||
    p.tokenId !== lot.tokenId ||
    !isAddressEqual(p.pool, lot.pool) ||
    p.fee !== 500 ||
    lot.fee !== 500 ||
    !isAddressEqual(p.token0.address, config.weth) ||
    !isAddressEqual(p.token1.address, config.aaveUsdc) ||
    !isAddressEqual(lot.token0, config.weth) ||
    !isAddressEqual(lot.token1, config.aaveUsdc) ||
    p.tickLower !== lot.lower ||
    p.tickUpper !== lot.upper
  )
    throw new Error("Oracle setup NFT/pool identity mismatch");
}
export function buildOracleSetup(state: ReturnWalletState, now: number) {
  identity(state);
  const block = state.snapshot.position.block;
  if (now < block.timestamp || now - block.timestamp >= 60)
    throw new Error("Stale oracle setup state");
  if (state.snapshot.oracle.cardinalityNext >= ORACLE_CAPACITY)
    throw new Error("Oracle capacity already reserved; no transaction needed");
  return {
    request: {
      chainId: 84532 as const,
      contractAddress: state.snapshot.lot.pool,
      abi: JSON.stringify(oracleSetupAbi),
      functionName: "increaseObservationCardinalityNext",
      functionArgs: json([ORACLE_CAPACITY]),
      value: "0" as const,
    },
    calldata: encodeFunctionData({
      abi: oracleSetupAbi,
      functionName: "increaseObservationCardinalityNext",
      args: [ORACLE_CAPACITY],
    }),
  };
}
export function verifyOracleSetupDelta(
  before: ReturnWalletState,
  after: ReturnWalletState,
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
) {
  identity(before);
  identity(after);
  const a = before.snapshot.position,
    b = after.snapshot.position;
  if (
    hash(before.snapshot.lot) !== hash(after.snapshot.lot) ||
    a.liquidity !== b.liquidity ||
    before.wallet0 !== after.wallet0 ||
    before.wallet1 !== after.wallet1 ||
    before.nftCount !== after.nftCount ||
    before.swapAllowance !== after.swapAllowance ||
    before.lp0Allowance !== after.lp0Allowance ||
    before.lp1Allowance !== after.lp1Allowance
  )
    throw new Error("Oracle preparation unexpectedly changed capital, NFT or allowances");
  const events = logs
    .filter((log) => isAddressEqual(log.address, a.pool))
    .flatMap((log) => {
      try {
        const e = decodeEventLog({
          abi: oracleSetupAbi,
          eventName: "IncreaseObservationCardinalityNext",
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        return [e.args];
      } catch {
        return [];
      }
    });
  if (
    events.length !== 1 ||
    events[0]!.observationCardinalityNextOld !== before.snapshot.oracle.cardinalityNext ||
    events[0]!.observationCardinalityNextNew !== ORACLE_CAPACITY ||
    after.snapshot.oracle.cardinalityNext !== ORACLE_CAPACITY
  )
    throw new Error("Oracle capacity receipt/event mismatch");
}
export async function submitOracleSetup(args: {
  client: TestnetReturnClient;
  lot: ParkedLot;
  store: TestnetDepositStore;
  apiKey: string;
  fetcher?: typeof fetch;
  readState?: typeof readReturnWalletState;
  clock?: () => number;
}) {
  const { client, lot, store } = args,
    fetcher = args.fetcher ?? fetch;
  const readState = args.readState ?? readOracleSetupState,
    clock = args.clock ?? (() => Math.floor(Date.now() / 1000));
  requireTestnetChain(await client.getChainId());
  const intent = oracleSetupIntent(lot.owner, lot.pool);
  if (store.get(intent))
    throw new Error("Oracle setup already started; reconcile without resending");
  if (!args.apiKey.trim()) throw new Error("Testnet execution credential required");
  const before = await readState(client, lot, defaultReturnPolicy),
    plan = buildOracleSetup(before, clock());
  if (hash(before.snapshot.lot) !== hash(lot)) throw new Error("Oracle lot mismatch");
  const headers = { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" };
  const simulation = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers,
    body: JSON.stringify({ ...plan.request, simulate: true }),
  });
  if (!simulation.ok) throw new Error(`Oracle simulation HTTP ${simulation.status}`);
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
    .parse(await simulation.json());
  if (
    !isAddressEqual(sim.from as Address, lot.owner) ||
    !isAddressEqual(sim.to as Address, lot.pool)
  )
    throw new Error("Oracle simulation sender/target mismatch");
  const fresh = await readState(client, lot, defaultReturnPolicy);
  if (
    hash(buildOracleSetup(fresh, clock())) !== hash(plan) ||
    hash(fresh.snapshot.lot) !== hash(lot)
  )
    throw new Error("Oracle request changed during simulation");
  requireTestnetChain(await client.getChainId());
  const request = JSON.stringify(plan.request);
  store.claim(intent, request, encodeRun({ state: fresh, plan }));
  const response = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { ...headers, "Idempotency-Key": intent },
    body: request,
  });
  const body: unknown = await response.json();
  store.recordResponse(intent, { httpStatus: response.status, body });
  if (!response.ok) throw new Error(`Oracle submission HTTP ${response.status}; reconcile only`);
  return executionResponseSchema.parse(body);
}
export async function reconcileOracleSetup(
  client: TestnetReturnClient,
  lot: ParkedLot,
  store: TestnetDepositStore,
  apiKey: string,
) {
  requireTestnetChain(await client.getChainId());
  const intent = oracleSetupIntent(lot.owner, lot.pool),
    row = store.get(intent);
  if (row?.status === "CONFIRMED") return JSON.parse(row.evidence!);
  if (!row?.response || row.status !== "RECONCILE")
    throw new Error("Oracle execution unresolved; never resend");
  const response = JSON.parse(row.response),
    result = executionResponseSchema.parse(response.body);
  const before = decodeRun<{ state: ReturnWalletState; plan: ReturnType<typeof buildOracleSetup> }>(
    row.baseline,
  );
  if (
    hash(before.plan.request) !== hash(JSON.parse(row.request)) ||
    hash(before.state.snapshot.lot) !== hash(lot)
  )
    throw new Error("Oracle journal context mismatch");
  const responseStatus = await fetch(
    `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!responseStatus.ok)
    throw new Error(`Oracle status HTTP ${responseStatus.status}; reconcile later`);
  const raw: unknown = await responseStatus.json();
  const status = z
    .object({
      executionId: z.literal(result.executionId),
      status: z.string(),
      sponsored: z.boolean(),
      transactionHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .optional(),
      receipts: z.array(
        z.object({
          hash: z.string(),
          chainId: z.number(),
          verified: z.boolean(),
          receiptStatus: z.string(),
        }),
      ),
    })
    .parse(raw);
  const txHash = status.transactionHash as Hex | undefined;
  if (status.status === "failed") throw new Error("Oracle execution failed; no retry");
  if (
    !txHash ||
    !status.receipts.some(
      (r) =>
        r.hash.toLowerCase() === txHash.toLowerCase() &&
        r.chainId === 84532 &&
        r.verified &&
        r.receiptStatus === "success",
    )
  )
    return {
      mode: "BASE_SEPOLIA_ORACLE_PENDING",
      executionId: result.executionId,
      pollAfterSeconds: responseStatus.headers.get("X-Poll-Interval-Hint"),
      verified: false,
    };
  if (result.transactionHash && result.transactionHash.toLowerCase() !== txHash.toLowerCase())
    throw new Error("Oracle transaction hash changed");
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success") throw new Error("Oracle transaction reverted");
  const tx = await client.getTransaction({ hash: txHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    lot.owner,
    before.plan,
    status.sponsored,
  );
  if (
    status.sponsored &&
    (
      await client.getCode({ address: lot.owner, blockNumber: receipt.blockNumber })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw new Error("Unexpected oracle signer delegate");
  const after = await readReturnWalletState(client, lot, defaultReturnPolicy, receipt.blockNumber);
  if (
    after.snapshot.position.block.hash !== receipt.blockHash ||
    receipt.blockNumber < before.state.snapshot.position.block.number ||
    (await client.getBlock({ blockNumber: before.state.snapshot.position.block.number })).hash !==
      before.state.snapshot.position.block.hash
  )
    throw new Error("Oracle evidence block changed");
  verifyOracleSetupDelta(before.state, after, receipt.logs);
  const evidence = {
    mode: "BASE_SEPOLIA_ORACLE_PREPARATION",
    chainId: 84532,
    verified: true,
    keeperhubExecution: true,
    executionId: result.executionId,
    transactionHash: txHash,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    sponsored: status.sponsored,
    before: before.state,
    after,
    request: before.plan.request,
    calldata: before.plan.calldata,
    capacityReserved: ORACLE_CAPACITY,
    historyReady:
      after.snapshot.oracle.cardinality >= 2 && after.snapshot.position.twapTick !== null,
    automaticReturnExecuted: false,
  };
  store.recordEvidence(intent, json(evidence));
  return evidence;
}
