import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { TestnetDepositStore } from "../src/testnet/execution.js";
import { parkIntent } from "../src/testnet/park-executor.js";
import { restoreIntent } from "../src/testnet/restore-executor.js";
import { RESTORE_STEPS } from "../src/testnet/restore-plan.js";
import { BASE_SEPOLIA as config } from "../src/testnet/config.js";
import {
  decideReturn,
  defaultReturnPolicy,
  type ParkedLot,
  type ReturnEconomics,
} from "../src/testnet/return-policy.js";
import { readReturnSnapshot, testnetReturnClient } from "../src/testnet/return-reader.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import { json } from "../src/core/serialization.js";
import { buildReturnWithdrawDraft, preflightReturnWithdrawal } from "../src/testnet/return-plan.js";

const quoteSchema = z
  .object({
    chainId: z.literal(84532),
    cycleId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    asset: z.string().refine(isAddress),
    horizonSeconds: z.number().int().positive(),
    quotedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    expectedLpFees: z.string().regex(/^\d+$/),
    executionCost: z.string().regex(/^\d+$/),
    source: z.string().min(1),
  })
  .strict();
if (existsSync(".env")) process.loadEnvFile(".env");
let parkDb: TestnetDepositStore | undefined,
  restoreDb: TestnetDepositStore | undefined,
  history: ReturnObservationStore | undefined;
try {
  const mode = process.argv[2] ?? "observe";
  if (mode !== "observe" && mode !== "preflight")
    throw new Error("Choose observe or preflight; neither broadcasts");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified testnet owner required");
  if (!existsSync("artifacts/testnet-park.sqlite"))
    throw new Error("Confirmed PARK journal required");
  parkDb = new TestnetDepositStore("artifacts/testnet-park.sqlite");
  const mintRow = parkDb.get(parkIntent(owner, "mint"));
  const supplyRow = parkDb.get(parkIntent(owner, "supply"));
  if (mintRow?.status !== "CONFIRMED" || supplyRow?.status !== "CONFIRMED")
    throw new Error("Confirmed mint and supply required");
  const mint = JSON.parse(mintRow.evidence!),
    supply = JSON.parse(supplyRow.evidence!);
  let status: ParkedLot["status"] = "PARKED";
  if (existsSync("artifacts/testnet-restore.sqlite")) {
    restoreDb = new TestnetDepositStore("artifacts/testnet-restore.sqlite");
    const rows = RESTORE_STEPS.map((id) => restoreDb!.get(restoreIntent(owner, id)));
    if (rows.every((row) => row?.status === "CONFIRMED")) status = "RESTORED";
    else if (rows.some(Boolean)) status = "RECOVERY";
  }
  const lot: ParkedLot = {
    cycleId: supply.transactionHash,
    chainId: 84532,
    owner,
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
    status,
  };
  let economics: ReturnEconomics | null = null;
  if (process.env.RANGEPARK_RETURN_ECONOMICS_FILE) {
    const q = quoteSchema.parse(
      JSON.parse(await readFile(process.env.RANGEPARK_RETURN_ECONOMICS_FILE, "utf8")),
    );
    economics = {
      ...q,
      cycleId: q.cycleId as Hex,
      asset: q.asset as Address,
      expectedLpFees: BigInt(q.expectedLpFees),
      executionCost: BigInt(q.executionCost),
    };
  }
  const policy = defaultReturnPolicy,
    client = testnetReturnClient();
  const snapshot = await readReturnSnapshot(client, lot, policy);
  history = new ReturnObservationStore("artifacts/testnet-return-observations.sqlite");
  const previous = history.get(lot.cycleId);
  const previousIsCanonical =
    !previous ||
    (await client.getBlock({ blockNumber: previous.block.number })).hash === previous.block.hash;
  const now = Math.floor(Date.now() / 1000);
  const observation = history.record(snapshot, policy, now, previous, previousIsCanonical);
  const decision = decideReturn({ ...snapshot, observation, policy, economics, now });
  const withdrawalDraft =
    decision.action === "RETURN"
      ? buildReturnWithdrawDraft({ ...snapshot, observation, policy, economics, now })
      : null;
  const preflight =
    mode === "preflight" && withdrawalDraft
      ? await preflightReturnWithdrawal(
          { ...snapshot, observation, policy, economics, now },
          process.env.KEEPERHUB_API_KEY ?? "",
        )
      : null;
  const report = {
    mode: "BASE_SEPOLIA_RETURN_POLICY_READ_ONLY",
    broadcastEnabled: false,
    snapshot,
    observation,
    previousIsCanonical,
    policy,
    economics,
    decision,
    withdrawalDraft,
    preflight,
    remainingExecutionGates: [
      "Fresh next-step simulation and contract-enforced bounds",
      "Confirmed withdrawal then fresh ratio swap and original-NFT reentry",
    ],
    transactions: [],
  };
  await writeFile("artifacts/testnet-return-observation.json", json(report));
  console.log(
    json({
      mode: report.mode,
      broadcastEnabled: false,
      tokenId: lot.tokenId,
      lotStatus: status,
      spot: snapshot.position.currentTick,
      twap: snapshot.position.twapTick,
      observation,
      decision,
      withdrawalDraft,
      preflight,
      transactions: [],
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message.split("\n")[0] : "RETURN observation failed",
  );
  process.exitCode = 1;
} finally {
  parkDb?.close();
  restoreDb?.close();
  history?.close();
}
