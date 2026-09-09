import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "docs/evidence/testnet-return-fork.json"), "utf8");
const proof = JSON.parse(source);
if (proof.mode !== "LOCAL_BASE_SEPOLIA_FORK" || proof.keeperhubExecution !== false || !proof.complete || proof.steps.length !== 6 ||
    BigInt(proof.final.liquidity) <= 0n || source.includes("explorerUrl") || proof.initialDecision.action !== "RETURN")
  throw new Error("Complete, explicitly local RETURN proof required");
const summary = {mode: proof.mode, keeperhubExecution: false, tokenId: proof.originalLot.tokenId,
  range: proof.final.range, tick: proof.final.tick, liquidity: proof.final.liquidity,
  residual: proof.final.capital, sourceBlock: proof.forkBlock.number,
  policy: {persistenceSeconds: 300, twapSeconds: 300, oracleCapacity: proof.steps[0].before.snapshot.oracle.cardinality},
  steps: proof.steps.map(s => ({id: s.step, hash: s.transactionHash, block: s.after.snapshot.position.block.number}))};
writeFileSync(resolve(root, "apps/web/lib/return-runner-evidence.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(resolve(root, "apps/web/public/evidence/testnet-return-fork.json"), source);
console.log("Synced six local RETURN receipts; no public explorer links or execution claims.");
