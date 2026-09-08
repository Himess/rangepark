import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hash,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA as config,
  requireTestnetChain,
} from "../src/testnet/config.js";
import {
  simulateTestnetDeposit,
  TEST_DEPOSIT_WEI,
} from "../src/testnet/preflight.js";
import {
  depositIntent,
  executionResponseSchema,
  submitTestnetDepositOnce,
  TestnetDepositStore,
} from "../src/testnet/execution.js";
import { json } from "../src/core/serialization.js";
import {
  TESTNET_GAS_DELEGATE,
  verifyTestnetDepositTransaction,
} from "../src/testnet/receipt.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const store = new TestnetDepositStore("artifacts/testnet-execution.sqlite");
try {
  const mode = process.argv[2];
  if (mode !== "submit" && mode !== "reconcile")
    throw new Error("Choose submit or reconcile explicitly");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  const apiKey = process.env.KEEPERHUB_TESTNET_WRITE_KEY;
  if (!owner || !isAddress(owner) || !apiKey)
    throw new Error(
      "Verified owner and dedicated testnet execution credential required",
    );
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpc, { timeout: 20000, retryCount: 1 }),
  });
  requireTestnetChain(await client.getChainId());
  const intent = depositIntent(owner, config.chainId);
  if (mode === "submit") {
    if (store.get(intent))
      throw new Error(
        "Deposit already started. Use reconcile; never submit another allocation.",
      );
    const block = await client.getBlock();
    const balance = await client.readContract({
      address: config.weth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber: block.number,
    });
    const preflight = await simulateTestnetDeposit(
      apiKey,
      owner,
      await client.getChainId(),
    );
    const simulationAt = Date.now();
    const gasPrice = await client.getGasPrice();
    if (BigInt(preflight.result.gasEstimate) * gasPrice > 100_000_000_000_000n)
      throw new Error("Testnet wrap gas estimate exceeds rehearsal ceiling");
    requireTestnetChain(await client.getChainId());
    const submitted = await submitTestnetDepositOnce({
      apiKey,
      owner,
      chainId: config.chainId,
      simulationAt,
      store,
      baseline: json({
        block: block.number,
        hash: block.hash,
        weth: balance,
        preflight,
      }),
    });
    console.log(json({ intent, ...submitted.result }));
  }
  const row = store.get(intent);
  if (!row) throw new Error("No deposit intent recorded");
  if (row.status === "CONFIRMED") {
    if (!row.evidence) throw new Error("Confirmed deposit evidence missing");
    await writeFile("artifacts/testnet-deposit-execution.json", row.evidence);
    console.log(row.evidence);
  } else {
    if (!row.response)
      throw new Error(
        "Submission outcome unknown; inspect KeeperHub activity for the persisted intent before reconciliation. No resend.",
      );
    const result = executionResponseSchema.parse(JSON.parse(row.response).body);
    const response = await fetch(
      `https://app.keeperhub.com/api/execute/${encodeURIComponent(result.executionId)}/status`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    if (!response.ok)
      throw new Error(
        `Execution status HTTP ${response.status}; reconcile later without resending`,
      );
    const status = (await response.json()) as {
      executionId: string;
      status: string;
      sponsored?: boolean;
      transactionHash?: Hash;
      receipts?: {
        hash: Hash;
        chainId: number;
        verified: boolean;
        receiptStatus: string;
      }[];
    };
    if (status.executionId !== result.executionId)
      throw new Error("Execution identity mismatch");
    const txHash =
      (result.transactionHash as Hash | undefined) ?? status.transactionHash;
    if (!txHash)
      throw new Error(
        "KeeperHub has not provided a transaction hash; reconcile later, do not resend",
      );
    if (
      status.transactionHash &&
      status.transactionHash.toLowerCase() !== txHash.toLowerCase()
    )
      throw new Error("Execution hash mismatch");
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 2,
      timeout: 60000,
    });
    const tx = await client.getTransaction({ hash: txHash });
    if (receipt.status !== "success")
      throw new Error("Deposit reverted; no next step");
    const executionRoute = verifyTestnetDepositTransaction(
      { ...tx, chainId: "chainId" in tx ? tx.chainId : undefined },
      owner,
      status.sponsored === true,
    );
    if (status.sponsored) {
      const code = await client.getCode({
        address: owner,
        blockNumber: receipt.blockNumber,
      });
      if (code?.toLowerCase() !== `0xef0100${TESTNET_GAS_DELEGATE.slice(2)}`)
        throw new Error("Unexpected EIP-7702 delegate at receipt block");
    }
    if (
      !status.receipts?.some(
        (r) =>
          r.hash.toLowerCase() === txHash.toLowerCase() &&
          r.chainId === config.chainId &&
          r.verified &&
          r.receiptStatus === "success",
      )
    )
      throw new Error("KeeperHub receipt not verified yet; reconcile later");
    const deposits = receipt.logs
      .filter((log) => isAddressEqual(log.address, config.weth))
      .flatMap((log) => {
        try {
          const event = decodeEventLog({
            abi: parseAbi(["event Deposit(address indexed dst, uint256 wad)"]),
            data: log.data,
            topics: log.topics,
          });
          return [event.args];
        } catch {
          return [];
        }
      });
    if (
      deposits.length !== 1 ||
      !isAddressEqual(deposits[0]!.dst, owner) ||
      deposits[0]!.wad !== TEST_DEPOSIT_WEI
    )
      throw new Error(
        "WETH Deposit event does not match the approved principal",
      );
    const baseline = JSON.parse(row.baseline) as {
      block: string;
      hash: Hash;
      weth: string;
    };
    const [sourceBlock, receiptBlock, balance] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(baseline.block) }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.readContract({
        address: config.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (
      sourceBlock.hash !== baseline.hash ||
      receiptBlock.hash !== receipt.blockHash
    )
      throw new Error("Block hash changed; reconcile again");
    if (balance - BigInt(baseline.weth) !== TEST_DEPOSIT_WEI)
      throw new Error(
        "WETH balance delta mismatch; inspect concurrent wallet activity",
      );
    const evidence = {
      mode: "BASE_SEPOLIA_KEEPERHUB_EXECUTION",
      keeperhubExecution: true,
      executionRoute,
      chainId: config.chainId,
      intent,
      owner,
      executionId: result.executionId,
      transactionHash: txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      receiptStatus: receipt.status,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      wethBefore: BigInt(baseline.weth),
      wethAfter: balance,
      wethDelta: balance - BigInt(baseline.weth),
      keeperhubStatus: status,
      verifiedAt: new Date().toISOString(),
    };
    store.recordEvidence(intent, json(evidence));
    await writeFile("artifacts/testnet-deposit-execution.json", json(evidence));
    console.log(json(evidence));
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n")[0]
      : "Testnet execution failed",
  );
  process.exitCode = 1;
} finally {
  store.close();
}
