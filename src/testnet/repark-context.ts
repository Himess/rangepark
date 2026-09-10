import { existsSync } from "node:fs";
import { isAddressEqual, type Hex } from "viem";
import { hash } from "../core/serialization.js";
import { TestnetDepositStore } from "./execution.js";
import { restoreIntent } from "./restore-executor.js";
import { RESTORE_STEPS } from "./restore-plan.js";
import type { ParkedLot } from "./return-policy.js";
import type { TestnetStep } from "./park-plan.js";
import { decodeRun } from "../state/return-runs.js";
import type { BlockRef } from "../core/models.js";

export const REPARK_STEPS = ["release", "approve-aave", "supply"] as const;
export type ReparkId = (typeof REPARK_STEPS)[number];
export type ReparkAnchor = {
  lot: ParkedLot;
  restorationHash: Hex;
  block: BlockRef;
  liquidity: bigint;
  parentCall: Pick<TestnetStep, "request" | "calldata">;
  sponsored: boolean;
};
export function reparkIntent(anchor: ReparkAnchor, id: ReparkId) {
  return hash({
    namespace: "rangepark-sepolia-repark-v1",
    chainId: 84532,
    owner: anchor.lot.owner.toLowerCase(),
    tokenId: anchor.lot.tokenId,
    parent: anchor.restorationHash.toLowerCase(),
    id,
  });
}
export function readReparkAnchor(lot: ParkedLot): ReparkAnchor {
  if (
    lot.status !== "RESTORED" ||
    lot.chainId !== 84532 ||
    !existsSync("artifacts/testnet-restore.sqlite")
  )
    throw new Error("A completed original restoration is required for this one-time re-PARK");
  const db = new TestnetDepositStore("artifacts/testnet-restore.sqlite");
  try {
    const rows = RESTORE_STEPS.map((id) => db.get(restoreIntent(lot.owner, id)));
    if (rows.some((row) => row?.status !== "CONFIRMED"))
      throw new Error("Restoration must be fully reconciled");
    const proof = JSON.parse(rows.at(-1)!.evidence!),
      c = proof.baseline.context;
    if (
      !isAddressEqual(c.owner, lot.owner) ||
      BigInt(c.tokenId) !== lot.tokenId ||
      c.lower !== lot.lower ||
      c.upper !== lot.upper ||
      BigInt(c.principal) !== lot.principal
    )
      throw new Error("Restoration identity differs from original PARK");
    return {
      lot,
      restorationHash: proof.transactionHash,
      block: {
        number: BigInt(proof.after.block),
        hash: proof.after.hash,
        timestamp: proof.after.timestamp,
      },
      liquidity: BigInt(proof.after.liquidity),
      parentCall: proof.baseline.step,
      sponsored: proof.sponsored,
    };
  } finally {
    db.close();
  }
}
// A partial new allocation must never be exposed as eligible parked principal.
export function selectReparkLot(
  original: ParkedLot,
  anchor: ReparkAnchor,
  store: TestnetDepositStore,
): ParkedLot {
  if (hash(original) !== hash(anchor.lot) || original.status !== "RESTORED")
    throw new Error("Re-PARK parent allocation mismatch");
  const rows = REPARK_STEPS.map((id) => store.get(reparkIntent(anchor, id)));
  if (!rows.some(Boolean)) return original;
  if (rows.some((row) => row?.status !== "CONFIRMED")) return { ...original, status: "RECOVERY" };
  const proofs = rows.map((row) =>
    decodeRun<{
      id: ReparkId;
      anchor: ReparkAnchor;
      amount: bigint;
      transactionHash: Hex;
      after: { snapshot: { position: { block: BlockRef } } };
    }>(row!.evidence!),
  );
  if (
    proofs.some(
      (proof, i) =>
        hash(proof.anchor) !== hash(anchor) ||
        proof.id !== REPARK_STEPS[i] ||
        !/^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash),
    ) ||
    proofs[0]!.amount <= 0n ||
    proofs[0]!.amount > original.principal ||
    proofs.some((proof) => proof.amount !== proofs[0]!.amount)
  )
    throw new Error("Re-PARK evidence identity or principal mismatch");
  const supply = proofs[2]!;
  return {
    ...original,
    cycleId: supply.transactionHash,
    principal: supply.amount,
    parkedAt: supply.after.snapshot.position.block.timestamp,
    status: "PARKED",
  };
}
