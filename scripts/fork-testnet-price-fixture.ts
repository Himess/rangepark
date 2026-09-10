import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { json } from "../src/core/serialization.js";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { readRecordedReturnLot } from "../src/testnet/return-context.js";
import {
  FIXTURE_STEPS,
  FIXTURE_TICK,
  FIXTURE_USDC,
  readFixtureState,
  reconcileFixtureStep,
  submitFixtureStep,
} from "../src/testnet/price-fixture.js";

const url = "http://127.0.0.1:8546";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(url, { timeout: 30000, retryCount: 0 }),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: baseSepolia, transport: http(url) });
async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = (await r.json()) as { error?: unknown; result: unknown };
  if (b.error) throw Error(json(b.error));
  return b.result;
}
async function main() {
  assert.match(String(await rpc("web3_clientVersion")), /anvil/i);
  assert.equal(await client.getChainId(), 84532);
  const block = await client.getBlock();
  assert.equal(block.number, 46615724n);
  const saved = await rpc("evm_snapshot"),
    db = new TestnetDepositStore(":memory:");
  try {
    const lot = readRecordedReturnLot("0x7109C8e3B56C0A94729F3f538105b6916EF5934B", true, false);
    await rpc("anvil_impersonateAccount", [lot.owner]);
    await rpc("anvil_setBalance", [lot.owner, "0x56bc75e2d63100000"]);
    const initial = await readFixtureState(client, lot, block.number);
    let clock = initial.snapshot.position.block.timestamp,
      count = 0;
    const executions = new Map<string, Hex>();
    const transport: typeof fetch = async (input, init) => {
      assert.ok(String(input).startsWith("https://app.keeperhub.com/api/execute/"));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          chainId: number;
          value: string;
          abi: string;
          functionName: string;
          functionArgs: string;
          contractAddress: Address;
          simulate?: boolean;
        };
        assert.equal(body.chainId, 84532);
        assert.equal(body.value, "0");
        const data = encodeFunctionData({
          abi: JSON.parse(body.abi) as Abi,
          functionName: body.functionName,
          args: JSON.parse(body.functionArgs),
        });
        if (body.simulate) {
          await client.call({ account: lot.owner, to: body.contractAddress, data });
          return new Response(
            json({
              success: true,
              status: "simulated",
              wouldRevert: false,
              from: lot.owner,
              to: body.contractAddress,
              value: "0",
              gasEstimate: "4000000",
            }),
          );
        }
        const transactionHash = await wallet.sendTransaction({
          account: lot.owner,
          to: body.contractAddress,
          data,
          gas: 4000000n,
        });
        await rpc("evm_mine");
        await rpc("evm_mine");
        const executionId = `local-price-fixture-${++count}`;
        executions.set(executionId, transactionHash);
        return new Response(json({ executionId, transactionHash, status: "completed" }));
      }
      const executionId = String(input).split("/").at(-2)!,
        transactionHash = executions.get(executionId);
      assert.ok(transactionHash);
      return new Response(
        json({
          executionId,
          transactionHash,
          status: "completed",
          sponsored: false,
          receipts: [
            { hash: transactionHash, chainId: 84532, verified: true, receiptStatus: "success" },
          ],
        }),
        { headers: { "X-Poll-Interval-Hint": "0" } },
      );
    };
    const steps = [];
    for (const id of FIXTURE_STEPS) {
      await submitFixtureStep({
        client,
        lot,
        id,
        store: db,
        apiKey: "local-no-real-key",
        manualFixture: true,
        fetcher: transport,
        clock: () => clock,
        readState: async (c, l) => {
          const s = await readFixtureState(c, l, (await c.getBlock()).number);
          clock = s.snapshot.position.block.timestamp;
          return s;
        },
      });
      const { explorerUrl: _, ...proof } = await reconcileFixtureStep(
        client,
        lot,
        id,
        db,
        "local-no-real-key",
        transport,
      );
      steps.push(proof);
      console.log(`Local ${id}: receipt and isolated capital verified.`);
    }
    const final = await readFixtureState(client, lot, (await client.getBlock()).number);
    assert.equal(count, 4);
    assert.equal(final.scaledAToken, initial.scaledAToken);
    assert.equal(final.snapshot.position.liquidity, 0n);
    assert.equal(final.usdcAllowance, 0n);
    assert.equal(final.snapshot.position.currentTick, FIXTURE_TICK);
    assert.ok(final.wallet1 >= initial.wallet1 && final.wallet1 < initial.wallet1 + FIXTURE_USDC);
    assert.ok(final.wallet0 > initial.wallet0);
    await writeFile(
      "artifacts/testnet-price-fixture-fork.json",
      json({
        mode: "LOCAL_BASE_SEPOLIA_FORK",
        keeperhubExecution: false,
        syntheticMarketIntervention: true,
        forkBlock: { number: block.number, hash: block.hash, timestamp: block.timestamp },
        fixtures: ["Local owner impersonation and ETH funding; real faucet mint and pool swap"],
        lot,
        initial,
        final,
        steps,
      }),
    );
    console.log(
      "PASS: four local calls; price reached target; parked principal intact; test USDC allowance revoked.",
    );
  } finally {
    db.close();
    await rpc("evm_revert", [saved]);
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
