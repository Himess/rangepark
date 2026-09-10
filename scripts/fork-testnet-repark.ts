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
import { readOriginalReturnLot } from "../src/testnet/return-context.js";
import { readReparkAnchor, REPARK_STEPS, selectReparkLot } from "../src/testnet/repark-context.js";
import {
  readReparkState,
  reconcileReparkStep,
  submitReparkStep,
  verifyReparkParent,
} from "../src/testnet/repark.js";

// Writes are hard-coded to loopback. No real KeeperHub credential or write transport.
const url = "http://127.0.0.1:8546";
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(url, { timeout: 30000, retryCount: 0 }),
  cacheTime: 0,
});
const wallet = createWalletClient({ chain: baseSepolia, transport: http(url) });
const owner = "0x7109C8e3B56C0A94729F3f538105b6916EF5934B";
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
async function main() {
  assert.match(String(await rpc("web3_clientVersion")), /anvil/i);
  assert.equal(await client.getChainId(), 84532);
  const forkBlock = await client.getBlock();
  assert.equal(
    forkBlock.number,
    46610756n,
    "Start a fresh fork at the verified oracle preparation block",
  );
  const saved = await rpc("evm_snapshot"),
    db = new TestnetDepositStore(":memory:");
  try {
    const lot = readOriginalReturnLot(owner),
      anchor = readReparkAnchor(lot);
    await verifyReparkParent(client, anchor);
    await rpc("anvil_impersonateAccount", [owner]);
    await rpc("anvil_setBalance", [owner, "0x56bc75e2d63100000"]);
    // Keep real owner delegation: historical parent verification also runs on the fork.
    let clock = Number(forkBlock.timestamp),
      count = 0;
    const initial = await readReparkState(client, anchor, forkBlock.number);
    const executed = new Map<string, Hex>();
    const transport: typeof fetch = async (input, init) => {
      const endpoint = String(input);
      assert.ok(endpoint.startsWith("https://app.keeperhub.com/api/execute/"));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          abi: string;
          functionName: string;
          functionArgs: string;
          contractAddress: Address;
          chainId: number;
          value: string;
          simulate?: boolean;
        };
        assert.equal(body.chainId, 84532);
        assert.equal(body.value, "0");
        const data = encodeFunctionData({
          abi: JSON.parse(body.abi) as Abi,
          functionName: body.functionName,
          args: JSON.parse(body.functionArgs),
        });
        if (body.simulate === true) {
          await client.call({ account: owner, to: body.contractAddress, data });
          return new Response(
            json({
              success: true,
              status: "simulated",
              wouldRevert: false,
              from: owner,
              to: body.contractAddress,
              value: "0",
              gasEstimate: "4000000",
            }),
          );
        }
        const transactionHash = await wallet.sendTransaction({
          account: owner,
          to: body.contractAddress,
          data,
          gas: 4000000n,
        });
        await rpc("evm_mine");
        await rpc("evm_mine");
        const executionId = `local-repark-${++count}`;
        executed.set(executionId, transactionHash);
        return new Response(json({ executionId, transactionHash, status: "completed" }));
      }
      const executionId = endpoint.split("/").at(-2)!,
        transactionHash = executed.get(executionId);
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
      );
    };
    const proofs = [];
    for (const id of REPARK_STEPS) {
      await submitReparkStep({
        client,
        anchor,
        id,
        store: db,
        apiKey: "local-no-real-key",
        manualRehearsal: true,
        fetcher: transport,
        clock: () => clock,
        readState: async (c, a) => {
          const s = await readReparkState(c, a, (await c.getBlock()).number);
          clock = s.snapshot.position.block.timestamp;
          return s;
        },
      });
      const { explorerUrl: _, ...proof } = await reconcileReparkStep(
        client,
        anchor,
        id,
        db,
        "local-no-real-key",
        transport,
      );
      proofs.push(proof);
      console.log(`Local ${id}: verified receipt and capital deltas.`);
    }
    const selectedLot = selectReparkLot(lot, anchor, db),
      final = await readReparkState(client, anchor, (await client.getBlock()).number);
    assert.equal(count, 3);
    assert.equal(selectedLot.status, "PARKED");
    assert.equal(final.snapshot.position.liquidity, 0n);
    assert.equal(final.wallet0, initial.wallet0);
    assert.equal(final.wallet1, initial.wallet1);
    assert.ok(final.scaledAToken > initial.scaledAToken);
    assert.notEqual(selectedLot.cycleId, lot.cycleId);
    assert.equal(selectedLot.principal, proofs[0]!.amount);
    assert.ok(selectedLot.principal <= lot.principal);
    await writeFile(
      "artifacts/testnet-repark-fork.json",
      json({
        mode: "LOCAL_BASE_SEPOLIA_FORK",
        keeperhubExecution: false,
        policyDecision: false,
        transport: "Emulated KeeperHub envelopes; actual local contract calls only",
        fixtureOperations: [
          "Impersonated original owner and funded local ETH only; delegation retained",
        ],
        forkBlock: {
          number: forkBlock.number,
          hash: forkBlock.hash,
          timestamp: forkBlock.timestamp,
        },
        originalLot: lot,
        selectedLot,
        initial,
        final,
        steps: proofs,
      }),
    );
    console.log(
      "PASS: three local receipts; original capital re-parked; old shares and unrelated wallet funds preserved.",
    );
  } finally {
    db.close();
    await rpc("evm_revert", [saved]);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
