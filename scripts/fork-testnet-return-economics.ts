import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { TickMath } from "@uniswap/v3-sdk";
import { routerAbi } from "../src/chain/abis.js";
import { json } from "../src/core/serialization.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import { readRecordedReturnLot } from "../src/testnet/return-context.js";
import { projectHistoricalFees, readEconomicsEvidence } from "../src/testnet/return-economics.js";
import { defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { readReturnSnapshot } from "../src/testnet/return-reader.js";

const url = "http://127.0.0.1:8546";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(url, { timeout: 30000 }),
  cacheTime: 0,
});
const account = "0x1111111111111111111111111111111111111111" as const;
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(url) });
async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { error?: unknown; result: unknown };
  if (body.error) throw Error(json(body.error));
  return body.result;
}
async function main() {
  assert.match(String(await rpc("web3_clientVersion")), /anvil/i);
  assert.equal(await client.getChainId(), 84532);
  const fork = await client.getBlock();
  assert.equal(fork.number, 46631150n);
  const saved = await rpc("evm_snapshot");
  try {
    const lot = readRecordedReturnLot("0x7109C8e3B56C0A94729F3f538105b6916EF5934B");
    await rpc("anvil_impersonateAccount", [account]);
    await rpc("anvil_setBalance", [account, "0x56bc75e2d63100000"]);
    const mint = await wallet.writeContract({
      address: config.weth,
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
      value: 1000000000000n,
      gas: 4000000n,
    });
    assert.equal((await client.waitForTransactionReceipt({ hash: mint })).status, "success");
    const approve = await wallet.writeContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.swapRouter, 1000000000000n],
      gas: 4000000n,
    });
    assert.equal((await client.waitForTransactionReceipt({ hash: approve })).status, "success");
    const swap = await wallet.writeContract({
      address: config.swapRouter,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: config.weth,
          tokenOut: config.aaveUsdc,
          fee: 500,
          recipient: account,
          amountIn: 1000000000000n,
          amountOutMinimum: 1n,
          sqrtPriceLimitX96: BigInt(TickMath.getSqrtRatioAtTick(-196205).toString()),
        },
      ],
      gas: 4000000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash: swap });
    assert.equal(receipt.status, "success");
    const snapshot = await readReturnSnapshot(
      client,
      lot,
      defaultReturnPolicy,
      receipt.blockNumber,
    );
    const fixture = JSON.parse(
      await readFile("docs/evidence/testnet-price-fixture.json", "utf8"),
    ) as { steps: { transactionHash: string }[] };
    const excludedHashes = new Set(fixture.steps.map((s) => s.transactionHash.toLowerCase()));
    const result = await readEconomicsEvidence(
      client,
      snapshot,
      defaultReturnPolicy,
      excludedHashes,
      () => snapshot.position.block.timestamp,
    );
    assert.ok(
      result.evidence.fees.details.some(
        (d) =>
          d.block.number === receipt.blockNumber &&
          d.reason === "MATERIAL_COUNTERFACTUAL_LIQUIDITY_EXCLUDED",
      ),
    );
    // A smaller hypothetical allocation tests the estimator's admissible branch.
    // It is never written to the public runner's quote path.
    const smallSnapshot = {
      ...snapshot,
      lot: { ...snapshot.lot, principal: 1000000000000n, cycleId: swap },
    };
    const projectionArgs = {
      snapshot: smallSnapshot,
      start: result.evidence.start,
      end: result.evidence.end,
      blocks: result.evidence.feeBlocks,
      excludedHashes,
      horizonSeconds: defaultReturnPolicy.horizonSeconds,
    };
    const smallAllocation = projectHistoricalFees(projectionArgs);
    assert.ok(
      smallAllocation.expectedLpFees > 0n,
      "Actual swap fee growth produces fees for a small hypothetical allocation",
    );
    assert.ok(
      smallAllocation.details.some(
        (d) => d.block.number === receipt.blockNumber && d.reason === "INCLUDED",
      ),
    );
    excludedHashes.add(swap.toLowerCase());
    const excluded = projectHistoricalFees(projectionArgs);
    assert.ok(
      excluded.details.some(
        (d) => d.block.number === receipt.blockNumber && d.reason === "PROJECT_ACTIVITY_EXCLUDED",
      ),
    );
    assert.equal(excluded.expectedLpFees, 0n);
    await writeFile(
      "artifacts/testnet-return-economics-fork.json",
      json({
        mode: "LOCAL_BASE_SEPOLIA_FORK",
        keeperhubExecution: false,
        publicBroadcasts: 0,
        syntheticMarketIntervention: true,
        fixtures: [
          "Local trader impersonation and ETH funding; actual WETH and pool contracts",
          "Hypothetical 0.000001 WETH allocation tests positive fees; recorded principal is excluded as material to the small pool",
          "Local chain clock used for historical fork quote freshness",
        ],
        forkBlock: { number: fork.number, hash: fork.hash, timestamp: fork.timestamp },
        transactions: { wrap: mint, approve, swap },
        snapshot,
        result,
        smallAllocationPrincipal: smallSnapshot.lot.principal,
        smallAllocation,
        excluded,
      }),
    );
    console.log(
      "PASS: real swap fee growth produces income; excluding that synthetic activity reduces projected income to zero. No public broadcasts.",
    );
  } finally {
    await rpc("evm_revert", [saved]);
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
