import { TickMath } from "@uniswap/v3-sdk";
import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { aavePoolAbi, positionManagerAbi, routerAbi } from "../chain/abis.js";
import { hash } from "../core/serialization.js";
import { ReturnRunStore } from "../state/return-runs.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "./config.js";
import { executionResponseSchema } from "./execution.js";
import { decideReturn, observeReturn, type ReturnDecisionInput } from "./return-policy.js";
import {
  assertReentrySnapshot,
  returnCall,
  verifyStage,
  type ReturnCall,
  type ReturnStepId,
  type StageDraft,
} from "./return-stages.js";
import { readReturnWalletState, type ReturnWalletState } from "./return-receipts.js";
import type { TestnetReturnClient } from "./return-reader.js";

export function stageFor(id: ReturnStepId): StageDraft["phase"] {
  return id === "withdraw"
    ? "WITHDRAW"
    : id === "approve-swap" || id === "swap"
      ? "SWAP"
      : "INCREASE";
}
// A recomputed hash alone is not authorization for arbitrary calldata. Reconstruct
// every allowed call from the original lot, exact budgets and known protocol ABIs.
export function validateReturnCall(input: ReturnDecisionInput, plan: StageDraft, call: ReturnCall) {
  const lot = input.lot,
    a = plan.amounts;
  if (
    plan.cycleId !== lot.cycleId ||
    plan.tokenId !== lot.tokenId ||
    plan.phase !== stageFor(call.id)
  )
    throw new Error("Wrong RETURN phase identity");
  let expected: ReturnCall;
  if (call.id === "withdraw")
    expected = returnCall("withdraw", config.aavePool, aavePoolAbi, "withdraw", [
      lot.asset,
      lot.principal,
      lot.owner,
    ]);
  else if (call.id === "approve-swap" || call.id === "swap") {
    if (
      a.input <= 0n ||
      a.input >= lot.principal ||
      a.minimumOut <= 0n ||
      plan.capital.amount0 !== lot.principal ||
      plan.capital.amount1 !== 0n
    )
      throw new Error("Swap exceeds attributed capital or has no minimum");
    if (call.id === "approve-swap")
      expected = returnCall(call.id, config.weth, erc20Abi, "approve", [
        config.swapRouter,
        a.input,
      ]);
    else {
      const data = encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: config.weth,
            tokenOut: config.aaveUsdc,
            fee: 500,
            recipient: lot.owner,
            amountIn: a.input,
            amountOutMinimum: a.minimumOut,
            sqrtPriceLimitX96: BigInt(
              TickMath.getSqrtRatioAtTick(lot.lower + input.policy.edgeBufferTicks).toString(),
            ),
          },
        ],
      });
      expected = returnCall(call.id, config.swapRouter, routerAbi, "multicall", [
        BigInt(plan.expiresAt),
        [data],
      ]);
    }
  } else {
    if (
      a.desired0 !== plan.capital.amount0 ||
      a.desired1 !== plan.capital.amount1 ||
      a.desired0 <= 0n ||
      a.desired0 >= lot.principal ||
      a.desired1 <= 0n ||
      a.minimum0 <= 0n ||
      a.minimum1 <= 0n ||
      a.minimum0 > a.desired0 ||
      a.minimum1 > a.desired1
    )
      throw new Error("Increase exceeds attributed capital or has no minima");
    if (call.id === "approve-lp0")
      expected = returnCall(call.id, config.weth, erc20Abi, "approve", [
        config.positionManager,
        a.desired0,
      ]);
    else if (call.id === "approve-lp1")
      expected = returnCall(call.id, config.aaveUsdc, erc20Abi, "approve", [
        config.positionManager,
        a.desired1,
      ]);
    else if (call.id === "increase")
      expected = returnCall(
        call.id,
        config.positionManager,
        positionManagerAbi,
        "increaseLiquidity",
        [
          {
            tokenId: lot.tokenId,
            amount0Desired: a.desired0,
            amount1Desired: a.desired1,
            amount0Min: a.minimum0,
            amount1Min: a.minimum1,
            deadline: BigInt(plan.expiresAt),
          },
        ],
      );
    else throw new Error("Unknown RETURN call");
  }
  if (hash(expected) !== hash(call))
    throw new Error("RETURN request differs from allowlisted calldata");
}

export async function submitReturnStep(args: {
  store: ReturnRunStore;
  cycleId: string;
  id: ReturnStepId;
  client: TestnetReturnClient;
  apiKey: string;
  fetcher?: typeof fetch;
  clock?: () => number;
  // Dependency injection for tests; live CLI always uses pinned onchain reads.
  readState?: typeof readReturnWalletState;
}) {
  const { store, client, cycleId, id } = args;
  const fetcher = args.fetcher ?? fetch,
    clock = args.clock ?? (() => Math.floor(Date.now() / 1000));
  const readState = args.readState ?? readReturnWalletState;
  const run = store.get(cycleId),
    plan = store.phase(cycleId, stageFor(id));
  if (!run || run.status !== "ACTIVE" || !plan)
    throw new Error("Active frozen RETURN phase required");
  const rows = store.steps(cycleId),
    row = rows.find((r) => r.id === id);
  if (!row || row.status !== "READY")
    throw new Error("Step already started; reconcile without resending");
  if (rows.some((r) => r.ordinal < row.ordinal && r.status !== "CONFIRMED"))
    throw new Error("Previous step unconfirmed");
  const call = plan.calls.find((c) => c.id === id);
  if (!call || hash(plan.capital) !== hash(run.capital))
    throw new Error("Frozen capital/call mismatch");
  const frozenCall = structuredClone(call);
  verifyStage(plan, clock());
  validateReturnCall(run.input, plan, frozenCall);
  if (!args.apiKey.trim()) throw new Error("Testnet execution credential required");
  requireTestnetChain(await client.getChainId());
  const guard = async (state: ReturnWalletState) => {
    const now = clock();
    verifyStage(plan, now);
    if (hash(state.snapshot.lot) !== hash(run.input.lot))
      throw new Error("Lot changed during RETURN");
    if (id === "withdraw") {
      const previous = run.input.observation;
      const canonical =
        previous !== null &&
        (await client.getBlock({ blockNumber: previous.block.number })).hash ===
          previous.block.hash;
      const observation = observeReturn(state.snapshot, run.input.policy, previous, now, canonical);
      const decision = decideReturn({
        ...state.snapshot,
        policy: run.input.policy,
        economics: run.input.economics,
        observation,
        now,
      });
      if (decision.action !== "RETURN")
        throw new Error(`Fresh RETURN decision blocked: ${decision.reasons.join(", ")}`);
    } else assertReentrySnapshot(state.snapshot, run.input.policy, now);
    if (state.wallet0 < run.capital.amount0 || state.wallet1 < run.capital.amount1)
      throw new Error("Attributed capital no longer available");
    if (id === "swap" && state.swapAllowance !== plan.amounts.input)
      throw new Error("Exact swap allowance changed");
    if (
      id === "increase" &&
      (state.lp0Allowance !== plan.amounts.desired0 || state.lp1Allowance !== plan.amounts.desired1)
    )
      throw new Error("Exact LP allowance changed");
  };
  await guard(await readState(client, run.input.lot, run.input.policy));
  const request = JSON.stringify(frozenCall.request);
  const headers = { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" };
  const simulation = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers,
    body: JSON.stringify({ ...frozenCall.request, simulate: true }),
  });
  if (!simulation.ok) throw new Error(`RETURN simulation HTTP ${simulation.status}`);
  const result = z
    .object({
      success: z.literal(true),
      status: z.literal("simulated"),
      wouldRevert: z.literal(false),
      from: z.string(),
      to: z.string(),
      value: z.literal("0"),
      gasEstimate: z.string().regex(/^[1-9][0-9]*$/),
      simulatedReturnValue: z.unknown().optional(),
    })
    .parse(await simulation.json());
  if (
    !isAddressEqual(result.from as Address, run.input.lot.owner) ||
    !isAddressEqual(result.to as Address, frozenCall.request.contractAddress)
  )
    throw new Error("RETURN simulation sender/target mismatch");
  if (id === "withdraw" && result.simulatedReturnValue !== run.input.lot.principal.toString())
    throw new Error("Wrong simulated withdrawal amount");
  const state = await readState(client, run.input.lot, run.input.policy);
  await guard(state);
  requireTestnetChain(await client.getChainId());
  const intent = store.claim(
    cycleId,
    plan,
    frozenCall,
    { state, capital: run.capital, plan },
    clock(),
  );
  // A committed unique SUBMITTING record exists before this HTTP write. Any
  // timeout or unreadable response leaves it there; no code path resends it.
  const write = await fetcher("https://app.keeperhub.com/api/execute/contract-call", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { ...headers, "Idempotency-Key": intent },
    body: request,
  });
  const written: unknown = await write.json();
  store.response(cycleId, id, { httpStatus: write.status, body: written });
  if (!write.ok)
    throw new Error(`RETURN submission HTTP ${write.status}; reconcile without resending`);
  return executionResponseSchema.parse(written);
}
