import { TickMath } from "@uniswap/v3-sdk";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { routerAbi, quoterAbi } from "../chain/abis.js";
import { hash } from "../core/serialization.js";
import { decodeRun, encodeRun } from "../state/return-runs.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import { TestnetDepositStore, executionResponseSchema } from "./execution.js";
import { verifiedTestnetExecution } from "./execution-status.js";
import { verifyParkTransaction } from "./park-executor.js";
import { TESTNET_GAS_DELEGATE } from "./receipt.js";
import { defaultReturnPolicy, type ParkedLot } from "./return-policy.js";
import { readReturnWalletState, type ReturnWalletState } from "./return-receipts.js";
import type { TestnetReturnClient } from "./return-reader.js";
import type { TestnetStep } from "./park-plan.js";

export const TEST_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc" as const;
export const FIXTURE_USDC = 100n * 10n ** 6n;
export const FIXTURE_TICK = -196198;
export const FIXTURE_STEPS = [
  "mint-test-usdc",
  "approve-test-usdc",
  "move-test-price",
  "revoke-test-usdc",
] as const;
export type FixtureId = (typeof FIXTURE_STEPS)[number];
export const faucetAbi = parseAbi([
  "function isPermissioned() view returns (bool)",
  "function getTokenConfig(address token) view returns (uint256 timelockPerMint,uint256 maxAmountPerMint)",
  "function getUserLastUpdated(address user,address token) view returns (uint256)",
  "function mint(address token,address to,uint256 amount) returns (uint256)",
]);
export type FixtureState = ReturnWalletState & {
  usdcAllowance: bigint;
  scaledAToken: bigint;
  tokenOwner: Address;
  permissioned: boolean;
  mintCooldown: bigint;
  maxMint: bigint;
  lastMint: bigint;
};
export type FixtureCall = { id: FixtureId; request: TestnetStep["request"]; calldata: Hex };
export type FixtureBaseline = {
  lot: ParkedLot;
  state: FixtureState;
  call: FixtureCall;
  createdAt: number;
  minimumOut: bigint;
};
export type FixtureProof = {
  id: FixtureId;
  baseline: FixtureBaseline;
  after: FixtureState;
  transactionHash: Hex;
  executionId: string;
  sponsored: boolean;
  explorerUrl: string;
};
export function fixtureIntent(lot: ParkedLot, id: FixtureId) {
  return hash({
    namespace: "rangepark-test-price-fixture-v1",
    cycle: lot.cycleId,
    owner: lot.owner.toLowerCase(),
    pool: lot.pool.toLowerCase(),
    id,
  });
}
export async function readFixtureState(
  client: TestnetReturnClient,
  lot: ParkedLot,
  blockNumber?: bigint,
): Promise<FixtureState> {
  const pinned = blockNumber ?? (await client.getBlock()).number - 2n;
  const state = await readReturnWalletState(client, lot, defaultReturnPolicy, pinned);
  const [usdcAllowance, scaledAToken, tokenOwner, permissioned, mintConfig, lastMint] =
    await Promise.all([
      client.readContract({
        address: config.aaveUsdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [lot.owner, config.swapRouter],
        blockNumber: pinned,
      }),
      client.readContract({
        address: state.snapshot.market.aToken,
        abi: parseAbi(["function scaledBalanceOf(address) view returns (uint256)"]),
        functionName: "scaledBalanceOf",
        args: [lot.owner],
        blockNumber: pinned,
      }),
      client.readContract({
        address: config.aaveUsdc,
        abi: parseAbi(["function owner() view returns (address)"]),
        functionName: "owner",
        blockNumber: pinned,
      }),
      client.readContract({
        address: TEST_FAUCET,
        abi: faucetAbi,
        functionName: "isPermissioned",
        blockNumber: pinned,
      }),
      client.readContract({
        address: TEST_FAUCET,
        abi: faucetAbi,
        functionName: "getTokenConfig",
        args: [config.aaveUsdc],
        blockNumber: pinned,
      }),
      // Verified Faucet storage writes [token][recipient], opposite its getter labels.
      client.readContract({
        address: TEST_FAUCET,
        abi: faucetAbi,
        functionName: "getUserLastUpdated",
        args: [config.aaveUsdc, lot.owner],
        blockNumber: pinned,
      }),
    ]);
  if ((await client.getBlock({ blockNumber: pinned })).hash !== state.snapshot.position.block.hash)
    throw Error("Fixture read reorged");
  return {
    ...state,
    usdcAllowance,
    scaledAToken,
    tokenOwner,
    permissioned,
    mintCooldown: mintConfig[0],
    maxMint: mintConfig[1] * 10n ** 6n,
    lastMint,
  };
}
export function fixtureIdentity(lot: ParkedLot, state: FixtureState) {
  const p = state.snapshot.position,
    m = state.snapshot.market;
  requireTestnetChain(lot.chainId);
  requireTestnetChain(p.chainId);
  if (
    lot.status !== "PARKED" ||
    hash(lot) !== hash(state.snapshot.lot) ||
    lot.tokenId !== 82083n ||
    p.tokenId !== lot.tokenId ||
    !isAddressEqual(p.owner, lot.owner) ||
    !isAddressEqual(p.pool, lot.pool) ||
    p.tickLower !== -196230 ||
    p.tickUpper !== -196170 ||
    lot.lower !== p.tickLower ||
    lot.upper !== p.tickUpper ||
    p.liquidity !== 0n ||
    p.fee !== 500 ||
    !isAddressEqual(p.token0.address, config.weth) ||
    !isAddressEqual(p.token1.address, config.aaveUsdc) ||
    !isAddressEqual(lot.asset, config.weth) ||
    lot.principal <= 0n ||
    lot.principal > 10n ** 15n ||
    state.snapshot.aTokenBalance < lot.principal ||
    state.snapshot.totalDebtBase !== 0n ||
    !m.active ||
    m.paused ||
    m.frozen
  )
    throw Error("Fixture requires the original empty NFT and intact parked principal");
}
function call(
  id: FixtureId,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): FixtureCall {
  return {
    id,
    calldata: encodeFunctionData({ abi, functionName, args }),
    request: {
      chainId: 84532,
      contractAddress: address,
      abi: JSON.stringify(abi),
      functionName,
      functionArgs: JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      value: "0",
    },
  };
}
export function buildFixtureCall(
  id: FixtureId,
  lot: ParkedLot,
  state: FixtureState,
  now: number,
  minimumOut = 0n,
  deadlineAt = now,
): FixtureCall {
  fixtureIdentity(lot, state);
  const p = state.snapshot.position;
  if (now < p.block.timestamp || now - p.block.timestamp >= 60) throw Error("Stale fixture state");
  if (id === "revoke-test-usdc")
    return call(id, config.aaveUsdc, erc20Abi, "approve", [config.swapRouter, 0n]);
  if (state.snapshot.oracle.cardinalityNext < 16 || p.currentTick >= lot.lower)
    throw Error("Fixture starts only below the original range with reserved oracle capacity");
  if (id === "mint-test-usdc") {
    if (
      !isAddressEqual(state.tokenOwner, TEST_FAUCET) ||
      state.permissioned ||
      state.maxMint < FIXTURE_USDC ||
      state.lastMint + state.mintCooldown > BigInt(p.block.timestamp)
    )
      throw Error("Faucet ownership, permission or cooldown mismatch");
    return call(id, TEST_FAUCET, faucetAbi, "mint", [config.aaveUsdc, lot.owner, FIXTURE_USDC]);
  }
  if (state.wallet1 < FIXTURE_USDC) throw Error("Fixture test USDC unavailable");
  if (id === "approve-test-usdc")
    return call(id, config.aaveUsdc, erc20Abi, "approve", [config.swapRouter, FIXTURE_USDC]);
  if (
    id !== "move-test-price" ||
    minimumOut <= 0n ||
    state.usdcAllowance !== FIXTURE_USDC ||
    now >= deadlineAt + 120
  )
    throw Error("Exact fixture swap approval and current quote required");
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: config.aaveUsdc,
        tokenOut: config.weth,
        fee: 500,
        recipient: lot.owner,
        amountIn: FIXTURE_USDC,
        amountOutMinimum: minimumOut,
        sqrtPriceLimitX96: BigInt(TickMath.getSqrtRatioAtTick(FIXTURE_TICK).toString()),
      },
    ],
  });
  return call(id, config.swapRouter, routerAbi, "multicall", [BigInt(deadlineAt + 120), [swap]]);
}
export async function quoteFixture(client: TestnetReturnClient, state: FixtureState) {
  const result = await client.simulateContract({
    address: config.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: config.aaveUsdc,
        tokenOut: config.weth,
        amountIn: FIXTURE_USDC,
        fee: 500,
        sqrtPriceLimitX96: BigInt(TickMath.getSqrtRatioAtTick(FIXTURE_TICK).toString()),
      },
    ],
    blockNumber: state.snapshot.position.block.number,
  });
  if (
    result.result[0] <= 0n ||
    result.result[1] !== BigInt(TickMath.getSqrtRatioAtTick(FIXTURE_TICK).toString())
  )
    throw Error("Fixture budget cannot reach the target price");
  const minimum = (result.result[0] * 997n) / 1000n;
  if (minimum <= 0n) throw Error("Fixture output too small");
  return minimum;
}
const fixtureEvents = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
export function verifyFixtureDelta(
  before: FixtureBaseline,
  after: FixtureState,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
) {
  const { state: a, lot, call } = before;
  fixtureIdentity(lot, a);
  fixtureIdentity(lot, after);
  if (
    a.scaledAToken !== after.scaledAToken ||
    a.nftCount !== after.nftCount ||
    a.swapAllowance !== after.swapAllowance ||
    a.lp0Allowance !== after.lp0Allowance ||
    a.lp1Allowance !== after.lp1Allowance
  )
    throw Error("Fixture changed parked shares, NFT or strategy approvals");
  const id = call.id;
  if (
    id !== "move-test-price" &&
    (after.wallet0 !== a.wallet0 ||
      after.snapshot.position.sqrtPriceX96 !== a.snapshot.position.sqrtPriceX96)
  )
    throw Error("Unexpected fixture WETH or price movement");
  if (id === "mint-test-usdc") {
    const transfers = logs
      .filter((l) => isAddressEqual(l.address, config.aaveUsdc))
      .flatMap((l) => {
        try {
          const d = decodeEventLog({
            abi: fixtureEvents,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return d.eventName === "Transfer" ? [d.args] : [];
        } catch {
          return [];
        }
      });
    if (
      after.wallet1 - a.wallet1 !== FIXTURE_USDC ||
      after.usdcAllowance !== a.usdcAllowance ||
      !transfers.some(
        (e) =>
          isAddressEqual(e.from, zeroAddress) &&
          isAddressEqual(e.to, lot.owner) &&
          e.value === FIXTURE_USDC,
      )
    )
      throw Error("Faucet mint receipt mismatch");
  } else if (id === "move-test-price") {
    const swaps = logs
      .filter((l) => isAddressEqual(l.address, lot.pool))
      .flatMap((l) => {
        try {
          const d = decodeEventLog({
            abi: fixtureEvents,
            data: l.data,
            topics: l.topics as [Hex, ...Hex[]],
          });
          return d.eventName === "Swap" ? [d.args] : [];
        } catch {
          return [];
        }
      });
    const s = swaps[0],
      spent = a.wallet1 - after.wallet1,
      received = after.wallet0 - a.wallet0;
    if (
      swaps.length !== 1 ||
      !s ||
      !isAddressEqual(s.sender, config.swapRouter) ||
      !isAddressEqual(s.recipient, lot.owner) ||
      s.amount1 !== spent ||
      s.amount0 !== -received ||
      spent <= 0n ||
      spent > FIXTURE_USDC ||
      received < before.minimumOut ||
      s.tick !== FIXTURE_TICK ||
      s.sqrtPriceX96 !== BigInt(TickMath.getSqrtRatioAtTick(FIXTURE_TICK).toString()) ||
      after.snapshot.position.currentTick !== FIXTURE_TICK ||
      after.usdcAllowance !== a.usdcAllowance - spent
    )
      throw Error("Fixture swap budget, price or receipt mismatch");
  } else if (
    after.wallet1 !== a.wallet1 ||
    after.usdcAllowance !== (id === "approve-test-usdc" ? FIXTURE_USDC : 0n)
  )
    throw Error("Fixture approval receipt mismatch");
}
function dependencies(store: TestnetDepositStore, lot: ParkedLot, id: FixtureId) {
  for (const prior of FIXTURE_STEPS.slice(0, FIXTURE_STEPS.indexOf(id)))
    if (store.get(fixtureIntent(lot, prior))?.status !== "CONFIRMED")
      throw Error("Fixture dependency unconfirmed");
}
export async function submitFixtureStep(args: {
  client: TestnetReturnClient;
  lot: ParkedLot;
  id: FixtureId;
  store: TestnetDepositStore;
  apiKey: string;
  manualFixture: boolean;
  fetcher?: typeof fetch;
  clock?: () => number;
  readState?: typeof readFixtureState;
}) {
  const { client, lot, id, store } = args,
    fetcher = args.fetcher ?? fetch,
    clock = args.clock ?? (() => Math.floor(Date.now() / 1000)),
    readState = args.readState ?? readFixtureState;
  if (!args.manualFixture || !args.apiKey.trim())
    throw Error("Explicit testnet price fixture and credential required");
  requireTestnetChain(await client.getChainId());
  const intent = fixtureIntent(lot, id);
  if (store.get(intent)) throw Error("Fixture already submitted; reconcile without resending");
  dependencies(store, lot, id);
  const state = await readState(client, lot),
    now = clock(),
    minimumOut = id === "move-test-price" ? await quoteFixture(client, state) : 0n;
  const planned = buildFixtureCall(id, lot, state, now, minimumOut),
    headers = { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" };
  const response = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers,
    body: JSON.stringify({ ...planned.request, simulate: true }),
  });
  if (!response.ok) throw Error(`Fixture simulation HTTP ${response.status}`);
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
    !isAddressEqual(sim.from as Address, lot.owner) ||
    !isAddressEqual(sim.to as Address, planned.request.contractAddress)
  )
    throw Error("Fixture simulation scope mismatch");
  const fresh = await readState(client, lot),
    freshNow = clock();
  if (
    freshNow < now ||
    freshNow - now >= 60 ||
    hash(buildFixtureCall(id, lot, fresh, freshNow, minimumOut, now)) !== hash(planned)
  )
    throw Error("Frozen fixture changed during simulation");
  if (
    fresh.scaledAToken !== state.scaledAToken ||
    fresh.wallet0 !== state.wallet0 ||
    fresh.wallet1 !== state.wallet1
  )
    throw Error("Fixture capital changed during simulation");
  dependencies(store, lot, id);
  requireTestnetChain(await client.getChainId());
  const request = JSON.stringify(planned.request);
  store.claim(
    intent,
    request,
    encodeRun({
      lot,
      state: fresh,
      call: planned,
      createdAt: now,
      minimumOut,
    } satisfies FixtureBaseline),
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
  if (!written.ok) throw Error(`Fixture submission HTTP ${written.status}; reconcile only`);
  return executionResponseSchema.parse(body);
}
export async function reconcileFixtureStep(
  client: TestnetReturnClient,
  lot: ParkedLot,
  id: FixtureId,
  store: TestnetDepositStore,
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  requireTestnetChain(await client.getChainId());
  const intent = fixtureIntent(lot, id),
    row = store.get(intent);
  if (row?.status === "CONFIRMED") return decodeRun<FixtureProof>(row.evidence!);
  if (row?.status !== "RECONCILE" || !row.response)
    throw Error("Unknown fixture submission; never resend");
  dependencies(store, lot, id);
  const baseline = decodeRun<FixtureBaseline>(row.baseline),
    result = executionResponseSchema.parse(JSON.parse(row.response).body);
  if (
    hash(lot) !== hash(baseline.lot) ||
    id !== baseline.call.id ||
    hash(JSON.parse(row.request)) !== hash(baseline.call.request)
  )
    throw Error("Fixture journal context mismatch");
  const response = await fetcher(
    `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!response.ok) throw Error(`Fixture status HTTP ${response.status}`);
  const status = verifiedTestnetExecution(
      await response.json(),
      result.executionId,
      response.headers,
    ),
    txHash = status.transactionHash as Hex;
  if (result.transactionHash && result.transactionHash.toLowerCase() !== txHash.toLowerCase())
    throw Error("Fixture transaction hash changed");
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 2,
    timeout: 60000,
  });
  if (receipt.status !== "success") throw Error("Fixture reverted; never resend");
  const tx = await client.getTransaction({ hash: txHash });
  verifyParkTransaction(
    { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
    lot.owner,
    baseline.call,
    status.sponsored,
  );
  if (
    status.sponsored &&
    (
      await client.getCode({ address: lot.owner, blockNumber: receipt.blockNumber })
    )?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`
  )
    throw Error("Unexpected fixture delegate");
  const after = await readFixtureState(client, lot, receipt.blockNumber),
    block = baseline.state.snapshot.position.block;
  if (
    receipt.blockNumber < block.number ||
    after.snapshot.position.block.hash !== receipt.blockHash ||
    (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
  )
    throw Error("Fixture evidence reorged");
  verifyFixtureDelta(baseline, after, receipt.logs);
  const proof: FixtureProof = {
    id,
    baseline,
    after,
    transactionHash: txHash,
    executionId: result.executionId,
    sponsored: status.sponsored,
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
  };
  store.recordEvidence(intent, encodeRun(proof));
  return proof;
}
