import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { TickMath } from "@uniswap/v3-sdk";
import { aaveDataAbi, routerAbi } from "../src/chain/abis.js";
import { json } from "../src/core/serialization.js";
import { ReturnRunStore } from "../src/state/return-runs.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import {
  decideReturn,
  defaultReturnPolicy,
  observeReturn,
  type ParkedLot,
  type ReturnObservation,
} from "../src/testnet/return-policy.js";
import { readReturnSnapshot } from "../src/testnet/return-reader.js";
import {
  buildReturnIncreaseStage,
  buildReturnSwapStage,
  RETURN_STEPS,
} from "../src/testnet/return-stages.js";
import { readReturnWalletState, verifyReturnReceipt } from "../src/testnet/return-receipts.js";
import { stageFor, submitReturnStep } from "../src/testnet/return-executor.js";

// Hard-coded loopback only; never accepts a public RPC for writes.
const url = "http://127.0.0.1:8546";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(url, { timeout: 30000, retryCount: 0 }),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: baseSepolia, transport: http(url) });
const trader = "0x1111111111111111111111111111111111111111" as const;
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result: unknown; error?: unknown };
  if (body.error) throw Error(json(body.error));
  return body.result;
}
async function send(from: Address, to: Address, data: Hex) {
  const tx = await wallet.sendTransaction({ account: from, to, data, gas: 4000000n });
  await rpc("evm_mine");
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  assert.equal(receipt.status, "success");
  return tx;
}
async function main() {
  assert.match(String(await rpc("web3_clientVersion")), /anvil/i);
  assert.equal(await client.getChainId(), 84532);
  const forkBlock = await client.getBlock();
  assert.equal(forkBlock.number, 46566708n, "Start a fresh fork at the recorded PARK block");
  const saved = await rpc("evm_snapshot");
  const db = new ReturnRunStore(":memory:");
  try {
    const park = JSON.parse(await readFile("docs/evidence/testnet-park.json", "utf8"));
    const mint = park.steps.find((s: { id: string }) => s.id === "mint"),
      supply = park.steps.find((s: { id: string }) => s.id === "supply");
    const lot: ParkedLot = {
      cycleId: supply.transactionHash,
      chainId: 84532,
      owner: park.owner,
      tokenId: BigInt(mint.meta.tokenId),
      pool: mint.meta.pool,
      token0: config.weth,
      token1: config.aaveUsdc,
      fee: 500,
      lower: mint.meta.lower,
      upper: mint.meta.upper,
      asset: config.weth,
      principal: BigInt(supply.meta.amount),
      parkedAt: supply.after.timestamp,
      status: "PARKED",
    };
    // Fork fixtures only: direct impersonated calls replace the real EIP-7702 relay.
    await rpc("anvil_setCode", [lot.owner, "0x"]);
    for (const account of [lot.owner, trader]) {
      await rpc("anvil_impersonateAccount", [account]);
      await rpc("anvil_setBalance", [account, "0x56bc75e2d63100000"]);
    }
    await send(
      trader,
      lot.pool,
      encodeFunctionData({
        abi: parseAbi([
          "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
        ]),
        functionName: "increaseObservationCardinalityNext",
        args: [16],
      }),
    );
    const [usdcAToken] = await client.readContract({
      address: config.aaveDataProvider,
      abi: aaveDataAbi,
      functionName: "getReserveTokensAddresses",
      args: [config.aaveUsdc],
    });
    await rpc("anvil_impersonateAccount", [usdcAToken]);
    await rpc("anvil_setBalance", [usdcAToken, "0x56bc75e2d63100000"]);
    await send(
      usdcAToken,
      config.aaveUsdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [trader, 1000n * 10n ** 6n],
      }),
    );
    await send(
      trader,
      config.aaveUsdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [config.swapRouter, 1000n * 10n ** 6n],
      }),
    );
    await send(
      trader,
      config.swapRouter,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: config.aaveUsdc,
            tokenOut: config.weth,
            fee: 500,
            recipient: trader,
            amountIn: 1000n * 10n ** 6n,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: BigInt(TickMath.getSqrtRatioAtTick(-196198).toString()),
          },
        ],
      }),
    );
    await rpc("evm_increaseTime", [3600]);
    await rpc("evm_mine");
    const policy = defaultReturnPolicy;
    let observation: ReturnObservation | null = null;
    let state = await readReturnWalletState(client, lot, policy);
    for (let i = 0; i <= 5; i++) {
      if (i) {
        await rpc("evm_increaseTime", [60]);
        await rpc("evm_mine");
      }
      state = await readReturnWalletState(client, lot, policy);
      observation = observeReturn(
        state.snapshot,
        policy,
        observation,
        state.snapshot.position.block.timestamp,
      );
    }
    const now = state.snapshot.position.block.timestamp;
    const input = {
      ...state.snapshot,
      policy,
      observation,
      now,
      economics: {
        chainId: 84532,
        cycleId: lot.cycleId,
        asset: lot.asset,
        horizonSeconds: 3600,
        quotedAt: now,
        expiresAt: now + 120,
        expectedLpFees: 10n ** 13n,
        executionCost: 10n ** 9n,
        source: "SYNTHETIC LOCAL FORK ASSUMPTIONS - not live economics",
      },
    };
    assert.equal(decideReturn(input).action, "RETURN", json(decideReturn(input)));
    db.create(input);
    console.log("Local fork: original NFT in range; sampled RETURN policy passed.");
    let chainClock = now;
    const localReceipts: unknown[] = [];
    const executed = new Map<string, Hex>();
    let count = 0;
    // This is a test transport, not a KeeperHub request. All calldata is executed
    // exclusively against loopback. The real receipt verifier remains in the path.
    const transport: typeof fetch = async (resource, options) => {
      const endpoint = String(resource);
      if (endpoint.endsWith("/contract-call")) {
        const body = JSON.parse(String(options?.body));
        assert.equal(body.chainId, 84532);
        assert.equal(body.value, "0");
        const abi = JSON.parse(body.abi) as Abi;
        const data = encodeFunctionData({
          abi,
          functionName: body.functionName,
          args: JSON.parse(body.functionArgs),
        });
        if (body.simulate === true) {
          const result = await client.call({ account: lot.owner, to: body.contractAddress, data });
          const decoded = decodeFunctionResult({
            abi,
            functionName: body.functionName,
            data: result.data!,
          });
          return new Response(
            json({
              success: true,
              status: "simulated",
              wouldRevert: false,
              from: lot.owner,
              to: body.contractAddress,
              value: "0",
              gasEstimate: "4000000",
              simulatedReturnValue: decoded,
            }),
          );
        }
        assert.equal(body.simulate, undefined);
        const transactionHash = await send(lot.owner, body.contractAddress, data);
        const executionId = `local-return-${++count}`;
        executed.set(executionId, transactionHash);
        return new Response(json({ executionId, transactionHash, status: "completed" }));
      }
      const id = endpoint.split("/").at(-2)!;
      const tx = executed.get(id);
      assert.ok(tx);
      return new Response(
        json({
          executionId: id,
          transactionHash: tx,
          sponsored: false,
          receipts: [{ hash: tx, chainId: 84532, verified: true, receiptStatus: "success" }],
        }),
      );
    };
    for (const id of RETURN_STEPS) {
      const run = db.get(lot.cycleId)!;
      const phase = stageFor(id);
      if (!db.phase(lot.cycleId, phase)) {
        state = await readReturnWalletState(client, lot, policy);
        chainClock = state.snapshot.position.block.timestamp;
        const draft =
          phase === "SWAP"
            ? await buildReturnSwapStage(client, state.snapshot, run.capital, policy, chainClock)
            : buildReturnIncreaseStage(state.snapshot, run.capital, policy, chainClock);
        db.savePhase(draft, chainClock);
      }
      await submitReturnStep({
        store: db,
        cycleId: lot.cycleId,
        id,
        client,
        apiKey: "local-transport-no-real-key",
        fetcher: transport,
        clock: () => chainClock,
        readState: async (...args) => {
          const s = await readReturnWalletState(...args);
          chainClock = s.snapshot.position.block.timestamp;
          return s;
        },
      });
      const row = db.steps(lot.cycleId).find((s) => s.id === id)!;
      const evidence = await verifyReturnReceipt(
        client,
        row,
        policy,
        "local-transport-no-real-key",
        transport,
      );
      db.confirm(lot.cycleId, id, evidence, evidence.capital);
      // Local hashes are never presented as explorer links.
      const { explorerUrl: _, ...localEvidence } = evidence;
      localReceipts.push(localEvidence);
      console.log(`Local ${id}: verified receipt and token deltas.`);
    }
    const final = db.get(lot.cycleId)!;
    assert.equal(final.status, "COMPLETE");
    const result = await readReturnSnapshot(client, lot, policy);
    assert.ok(result.position.liquidity > 0n);
    assert.equal(result.position.tickLower, lot.lower);
    assert.equal(result.position.tickUpper, lot.upper);
    const residualValueWeth =
      final.capital.amount0 +
      (final.capital.amount1 * (1n << 192n)) /
        (result.position.sqrtPriceX96 * result.position.sqrtPriceX96);
    assert.ok(
      residualValueWeth < lot.principal / 100n,
      "At least 99% of principal-equivalent value should be allocated in this controlled fixture",
    );
    await writeFile(
      "artifacts/testnet-return-fork.json",
      json({
        mode: "LOCAL_BASE_SEPOLIA_FORK",
        keeperhubExecution: false,
        transport: "Local test adapter; real RPC contract calls; no external KeeperHub calls",
        forkBlock: {
          number: forkBlock.number,
          hash: forkBlock.hash,
          timestamp: forkBlock.timestamp,
        },
        fixtureOperations: [
          "Impersonation and local ETH funding",
          "Remove owner delegation locally for direct calls",
          "Increase oracle observation capacity to 16",
          "Fund separate price-moving fixture from Aave test USDC holder",
          "Move pool price and advance local time",
        ],
        originalLot: lot,
        initialDecision: decideReturn(input),
        steps: localReceipts,
        final: {
          liquidity: result.position.liquidity,
          range: [lot.lower, lot.upper],
          tick: result.position.currentTick,
          capital: final.capital,
        },
        complete: true,
      }),
    );
    console.log("Six real local contract receipts verified; same NFT and range restored.");
  } finally {
    db.close();
    assert.equal(await rpc("evm_revert", [saved]), true);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : json(error));
  process.exitCode = 1;
});
