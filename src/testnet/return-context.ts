import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { TestnetDepositStore } from "./execution.js";
import { parkIntent } from "./park-executor.js";
import { restoreIntent } from "./restore-executor.js";
import { RESTORE_STEPS } from "./restore-plan.js";
import { ReturnRunStore } from "../state/return-runs.js";
import { BASE_SEPOLIA as config } from "./config.js";
import type { ParkedLot, ReturnEconomics } from "./return-policy.js";
import { readReparkAnchor, selectReparkLot } from "./repark-context.js";
import { FIXTURE_STEPS, fixtureIntent } from "./price-fixture.js";

export function readOriginalReturnLot(owner: Address, includeRunnerState = true): ParkedLot {
  if (!existsSync("artifacts/testnet-park.sqlite"))
    throw new Error("Confirmed PARK journal required");
  const db = new TestnetDepositStore("artifacts/testnet-park.sqlite");
  let restore: TestnetDepositStore | undefined, returns: ReturnRunStore | undefined;
  try {
    const mintRow = db.get(parkIntent(owner, "mint")),
      supplyRow = db.get(parkIntent(owner, "supply"));
    if (mintRow?.status !== "CONFIRMED" || supplyRow?.status !== "CONFIRMED")
      throw new Error("Confirmed mint and supply required");
    const mint = JSON.parse(mintRow.evidence!),
      supply = JSON.parse(supplyRow.evidence!);
    let status: ParkedLot["status"] = "PARKED";
    if (existsSync("artifacts/testnet-restore.sqlite")) {
      restore = new TestnetDepositStore("artifacts/testnet-restore.sqlite");
      const rows = RESTORE_STEPS.map((id) => restore!.get(restoreIntent(owner, id)));
      if (rows.every((row) => row?.status === "CONFIRMED")) status = "RESTORED";
      else if (rows.some(Boolean)) status = "RECOVERY";
    }
    if (includeRunnerState && existsSync("artifacts/testnet-return-runs.sqlite")) {
      returns = new ReturnRunStore("artifacts/testnet-return-runs.sqlite");
      const run = returns.get(supply.transactionHash);
      if (run?.status === "COMPLETE") status = "RESTORED";
      else if (run?.status === "PAUSED" || (run?.status === "ACTIVE" && status === "RESTORED"))
        status = "RECOVERY";
    }
    return {
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
  } finally {
    db.close();
    restore?.close();
    returns?.close();
  }
}
export function readRecordedReturnLot(
  owner: Address,
  includeRunnerState = true,
  includePriceFixture = true,
): ParkedLot {
  let lot = readOriginalReturnLot(owner, includeRunnerState);
  if (lot.status !== "RESTORED" || !existsSync("artifacts/testnet-repark.sqlite")) return lot;
  const store = new TestnetDepositStore("artifacts/testnet-repark.sqlite");
  try {
    lot = selectReparkLot(lot, readReparkAnchor(lot), store);
  } finally {
    store.close();
  }
  if (
    lot.status === "PARKED" &&
    includeRunnerState &&
    existsSync("artifacts/testnet-return-runs.sqlite")
  ) {
    const returns = new ReturnRunStore("artifacts/testnet-return-runs.sqlite");
    try {
      const run = returns.get(lot.cycleId);
      if (run?.status === "COMPLETE") lot = { ...lot, status: "RESTORED" };
      else if (run?.status === "PAUSED") lot = { ...lot, status: "RECOVERY" };
    } finally {
      returns.close();
    }
  }
  if (
    includePriceFixture &&
    lot.status === "PARKED" &&
    existsSync("artifacts/testnet-price-fixture.sqlite")
  ) {
    const fixture = new TestnetDepositStore("artifacts/testnet-price-fixture.sqlite");
    try {
      const rows = FIXTURE_STEPS.map((id) => fixture.get(fixtureIntent(lot, id)));
      if (rows.some(Boolean) && !rows.every((row) => row?.status === "CONFIRMED"))
        lot = { ...lot, status: "RECOVERY" };
    } finally {
      fixture.close();
    }
  }
  return lot;
}
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
export async function readReturnEconomics(
  path = process.env.RANGEPARK_RETURN_ECONOMICS_FILE ||
    (existsSync("artifacts/testnet-return-economics.json")
      ? "artifacts/testnet-return-economics.json"
      : undefined),
): Promise<ReturnEconomics | null> {
  if (!path) return null;
  const q = quoteSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return {
    ...q,
    cycleId: q.cycleId as Hex,
    asset: q.asset as Address,
    expectedLpFees: BigInt(q.expectedLpFees),
    executionCost: BigInt(q.executionCost),
  };
}
