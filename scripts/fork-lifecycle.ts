import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { TickMath } from "@uniswap/v3-sdk";
import { BASE } from "../src/config/base.js";
import { baseClient, readBlock } from "../src/chain/client.js";
import { readPosition } from "../src/chain/uniswap.js";
import { readAaveMarket } from "../src/chain/aave.js";
import {
  factoryAbi,
  poolAbi,
  positionManagerAbi,
  routerAbi,
} from "../src/chain/abis.js";
import {
  buildParkPlan,
  type ContractCall,
  type ExecutionPlan,
} from "../src/keeperhub/plan.js";
import {
  buildReentryPlan,
  buildWithdrawPlan,
} from "../src/keeperhub/return.js";
import { defaultPolicy, decidePark } from "../src/core/decision.js";
import { Journal } from "../src/state/journal.js";
import { json } from "../src/core/serialization.js";

// Intentionally not configurable: this harness can only write to this local Anvil.
const url = "http://127.0.0.1:8545";
const client = baseClient(url);
const account = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const trader = "0x1111111111111111111111111111111111111111" as const;
const wallet = createWalletClient({
  account,
  chain: base,
  transport: http(url),
});
const events: unknown[] = [];
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result: unknown; error?: unknown };
  if (body.error) throw new Error(json(body.error));
  return body.result;
}
async function balance(token: Address, owner: Address = account) {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}
async function send(
  to: Address,
  data: Hex,
  from: Address = account,
  value = 0n,
) {
  await client.call({ account: from, to, data, value });
  const transactionHash = await wallet.sendTransaction({
    account: from,
    to,
    data,
    value,
    gas: 4000000n,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: transactionHash,
  });
  assert.equal(receipt.status, "success");
  return {
    transactionHash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}
async function step(call: ContractCall) {
  const result = await send(call.contractAddress, call.calldata);
  events.push({ step: call.id, ...result });
  return result;
}

async function main() {
  const version = await rpc("web3_clientVersion");
  assert.equal(typeof version, "string");
  assert.match(version as string, /anvil/i);
  assert.equal(await client.getChainId(), 8453);
  const snapshot = await rpc("evm_snapshot");
  const journal = new Journal(":memory:");
  try {
    const forkBlock = await readBlock(client);
    console.log("Fork verified; funding test accounts on local Anvil only.");
    await send(
      BASE.weth,
      encodeFunctionData({
        abi: parseAbi(["function deposit() payable"]),
        functionName: "deposit",
      }),
      account,
      parseEther("2"),
    );
    await send(
      BASE.weth,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [BASE.positionManager, parseEther("1")],
      }),
    );
    const usdcMarket = await readAaveMarket(
      client,
      { address: BASE.usdc, symbol: "USDC", decimals: 6 },
      await readBlock(client),
    );
    await rpc("anvil_impersonateAccount", [usdcMarket.aToken]);
    await rpc("anvil_setBalance", [usdcMarket.aToken, "0x56bc75e2d63100000"]);
    await send(
      BASE.usdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [trader, 5000000n * 10n ** 6n],
      }),
      usdcMarket.aToken,
    );
    await rpc("anvil_stopImpersonatingAccount", [usdcMarket.aToken]);
    await rpc("anvil_impersonateAccount", [trader]);
    await rpc("anvil_setBalance", [trader, "0x56bc75e2d63100000"]);
    await send(
      BASE.usdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [BASE.swapRouter, 5000000n * 10n ** 6n],
      }),
      trader,
    );
    const pool = await client.readContract({
      address: BASE.factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [BASE.weth, BASE.usdc, 3000],
    });
    const slot = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    });
    const lower = Math.ceil(slot[1] / 60) * 60,
      upper = lower + 120;
    const mint = {
      token0: BASE.weth,
      token1: BASE.usdc,
      fee: 3000,
      tickLower: lower,
      tickUpper: upper,
      amount0Desired: parseEther("1"),
      amount1Desired: 0n,
      amount0Min: parseEther("0.99"),
      amount1Min: 0n,
      recipient: account,
      deadline: BigInt((await readBlock(client)).timestamp + 120),
    };
    const minted = await client.simulateContract({
      account,
      address: BASE.positionManager,
      abi: positionManagerAbi,
      functionName: "mint",
      args: [mint],
    });
    const tokenId = minted.result[0];
    await send(
      BASE.positionManager,
      encodeFunctionData({
        abi: positionManagerAbi,
        functionName: "mint",
        args: [mint],
      }),
    );
    console.log(
      `Minted local out-of-range position #${tokenId}; collecting observed persistence.`,
    );
    let position = await readPosition(client, tokenId, await readBlock(client));
    journal.recordObservation(position, 120);
    for (let i = 0; i < 31; i++) {
      await rpc("evm_increaseTime", [60]);
      await rpc("evm_mine");
      position = await readPosition(client, tokenId, await readBlock(client));
      journal.recordObservation(position, 120);
    }
    const market = await readAaveMarket(
      client,
      position.token0,
      position.block,
    );
    const observation = journal.recordObservation(position, 120);
    const input = {
      position,
      market,
      observation,
      policy: { ...defaultPolicy, horizonSeconds: 30 * 86400 },
      economics: {
        roundTripCost: 10000000000000n,
        foregoneLpFees: 0n,
        source: "Local fork test assumption, not a live profitability claim",
      },
      now: position.block.timestamp,
      lastActionAt: null,
    };
    assert.equal(decidePark(input).action, "PARK", json(decidePark(input)));
    const plan = buildParkPlan(input, account);
    journal.create(plan, input.now);
    journal.approve(plan, "local-fork-test", input.now);
    const beforeWeth = await balance(BASE.weth),
      beforeAToken = await balance(market.aToken);
    for (const call of plan.steps) {
      journal.beginStep(plan, call.id, (await readBlock(client)).timestamp, {
        weth: (await balance(BASE.weth)).toString(),
      });
      const result = await step(call);
      journal.recordHash(plan.planHash, call.id, result.transactionHash);
      if (call.id === "release") {
        assert.equal(
          (await readPosition(client, tokenId, await readBlock(client)))
            .liquidity,
          0n,
        );
        assert.ok(
          (await balance(BASE.weth)) - beforeWeth >= BigInt(plan.supplyAmount),
        );
        // Simulate a lost response after the transaction actually succeeded.
        journal.markUnknown(
          plan.planHash,
          call.id,
          "Injected response timeout after mined transaction",
        );
        assert.throws(() => journal.beginStep(plan, call.id, input.now, {}));
        events.push({
          step: "recovery",
          result:
            "Confirmed original release receipt; duplicate submission refused",
        });
      }
      if (call.id === "supply") {
        const minted = (await balance(market.aToken)) - beforeAToken;
        console.log(json({ supply: plan.supplyAmount, aTokenDelta: minted }));
        // aToken scaled shares round to nearest ray unit; allow only two atomic underlying units.
        assert.ok(
          minted + 2n >= BigInt(plan.supplyAmount),
          "aToken balance delta below supply beyond rounding tolerance",
        );
      }
      journal.confirm(
        plan.planHash,
        call.id,
        result.transactionHash,
        { verified: true, block: result.block.toString() },
        true,
      );
    }
    assert.equal(journal.status(plan.planHash), "COMPLETED");
    console.log(
      "PARK verified; moving local pool price into the ORIGINAL range with a real swap.",
    );
    await rpc("evm_increaseTime", [86400]);
    await rpc("evm_mine");
    await send(
      BASE.swapRouter,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: BASE.usdc,
            tokenOut: BASE.weth,
            fee: 3000,
            recipient: trader,
            amountIn: 5000000n * 10n ** 6n,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: BigInt(
              TickMath.getSqrtRatioAtTick(lower + 60).toString(),
            ),
          },
        ],
      }),
      trader,
    );
    await rpc("anvil_stopImpersonatingAccount", [trader]);
    await rpc("evm_increaseTime", [1800]);
    await rpc("evm_mine");
    const beforeWithdraw = await balance(BASE.weth);
    const parked = (await balance(market.aToken)) - beforeAToken;
    const withdrawPlan = buildWithdrawPlan(
      await readPosition(client, tokenId, await readBlock(client)),
      BASE.weth,
      parked,
    );
    async function executeReturn(plan: ExecutionPlan) {
      journal.create(plan, plan.createdAt);
      journal.approve(plan, "local-fork-test", plan.createdAt);
      for (const call of plan.steps) {
        journal.beginStep(
          plan,
          call.id,
          (await readBlock(client)).timestamp,
          {},
        );
        const result = await step(call);
        journal.recordHash(plan.planHash, call.id, result.transactionHash);
        journal.confirm(
          plan.planHash,
          call.id,
          result.transactionHash,
          { receiptStatus: "success", block: result.block.toString() },
          true,
        );
      }
      assert.equal(journal.status(plan.planHash), "COMPLETED");
    }
    await executeReturn(withdrawPlan);
    const withdrawn = (await balance(BASE.weth)) - beforeWithdraw;
    assert.ok(withdrawn >= BigInt(plan.supplyAmount));
    position = await readPosition(client, tokenId, await readBlock(client));
    console.log(
      json({
        returnTick: position.currentTick,
        lower,
        upper,
        twap: position.twapTick,
      }),
    );
    const reentry = await buildReentryPlan(client, position, withdrawn, 0n);
    await executeReturn(reentry);
    const returned = await readPosition(
      client,
      tokenId,
      await readBlock(client),
    );
    assert.ok(returned.liquidity > 0n);
    assert.equal(returned.tickLower, lower);
    assert.equal(returned.tickUpper, upper);
    assert.ok(returned.principal0 > 0n && returned.principal1 > 0n);
    const report = {
      mode: "LOCAL_BASE_FORK",
      keeperhubExecution: false,
      sourceBlock: forkBlock,
      tokenId,
      originalRange: [lower, upper],
      parkPlanHash: plan.planHash,
      returnPlanHash: reentry.planHash,
      supplied: plan.supplyAmount,
      withdrawn,
      returned,
      events,
      journal: {
        park: journal.history(plan.planHash),
        withdraw: journal.history(withdrawPlan.planHash),
        reentry: journal.history(reentry.planHash),
      },
      completedAt: new Date().toISOString(),
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/fork-lifecycle.json", json(report));
    console.log(
      json({
        status: "PARK_RETURN_VERIFIED",
        tokenId,
        localTransactions: events.length,
        returnedLiquidity: returned.liquidity,
        artifact: "artifacts/fork-lifecycle.json",
        keeperhubExecution: false,
      }),
    );
  } finally {
    journal.close();
    await rpc("evm_revert", [snapshot]);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
