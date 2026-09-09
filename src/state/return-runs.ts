import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hash } from "../core/serialization.js";
import {
  buildReturnWithdrawalStage,
  RETURN_STEPS,
  verifyStage,
  type AttributedCapital,
  type ReturnCall,
  type ReturnStepId,
  type StageDraft,
} from "../testnet/return-stages.js";
import type { ReturnDecisionInput } from "../testnet/return-policy.js";

// Lossless integers in private SQLite payloads. Public evidence uses normal decimal strings.
export const encodeRun = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === "bigint" ? { $rangeparkBigint: v.toString() } : v,
  );
export function decodeRun<T>(value: string): T {
  return JSON.parse(value, (_, v: unknown) => {
    if (
      v &&
      typeof v === "object" &&
      Object.keys(v).length === 1 &&
      "$rangeparkBigint" in v &&
      typeof v.$rangeparkBigint === "string" &&
      /^-?\d+$/.test(v.$rangeparkBigint)
    )
      return BigInt(v.$rangeparkBigint);
    return v;
  }) as T;
}
export type ReturnRun = {
  cycle_id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETE";
  input: ReturnDecisionInput;
  capital: AttributedCapital;
};
export type RunStep = {
  cycle_id: string;
  id: ReturnStepId;
  ordinal: number;
  status: "READY" | "SUBMITTING" | "RECONCILE" | "CONFIRMED";
  call: string | null;
  baseline: string | null;
  response: string | null;
  evidence: string | null;
  plan_hash: string | null;
};
const phaseSteps = {
  WITHDRAW: ["withdraw"],
  SWAP: ["approve-swap", "swap"],
  INCREASE: ["approve-lp0", "approve-lp1", "increase"],
};

export class ReturnRunStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS return_runs (cycle_id TEXT PRIMARY KEY, position_key TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, capital TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_return_per_position ON return_runs(position_key) WHERE status != 'COMPLETE';
      CREATE TABLE IF NOT EXISTS return_phases (cycle_id TEXT NOT NULL REFERENCES return_runs(cycle_id), phase TEXT NOT NULL, plan TEXT NOT NULL, PRIMARY KEY(cycle_id,phase));
      CREATE TABLE IF NOT EXISTS return_steps (cycle_id TEXT NOT NULL REFERENCES return_runs(cycle_id), id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL,
        call TEXT, baseline TEXT, response TEXT, evidence TEXT, plan_hash TEXT, PRIMARY KEY(cycle_id,id));`);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(cycle: string): ReturnRun | null {
    const row = this.db.prepare("SELECT * FROM return_runs WHERE cycle_id=?").get(cycle) as
      | { cycle_id: string; status: ReturnRun["status"]; input: string; capital: string }
      | undefined;
    return row ? { ...row, input: decodeRun(row.input), capital: decodeRun(row.capital) } : null;
  }
  steps(cycle: string): RunStep[] {
    return this.db
      .prepare("SELECT * FROM return_steps WHERE cycle_id=? ORDER BY ordinal")
      .all(cycle) as RunStep[];
  }
  phase(cycle: string, phase: StageDraft["phase"]): StageDraft | null {
    const row = this.db
      .prepare("SELECT plan FROM return_phases WHERE cycle_id=? AND phase=?")
      .get(cycle, phase) as { plan: string } | undefined;
    return row ? decodeRun(row.plan) : null;
  }
  create(input: ReturnDecisionInput) {
    const draft = buildReturnWithdrawalStage(input);
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO return_runs(cycle_id,position_key,status,input,capital) VALUES (?,?,'ACTIVE',?,?)",
        )
        .run(
          input.lot.cycleId,
          `84532:${input.lot.owner.toLowerCase()}:${input.lot.tokenId}`,
          encodeRun(input),
          encodeRun({ amount0: 0n, amount1: 0n }),
        );
      RETURN_STEPS.forEach((id, ordinal) =>
        this.db
          .prepare("INSERT INTO return_steps(cycle_id,id,ordinal,status) VALUES (?,?,?,'READY')")
          .run(input.lot.cycleId, id, ordinal),
      );
      this.db
        .prepare("INSERT INTO return_phases(cycle_id,phase,plan) VALUES (?,?,?)")
        .run(input.lot.cycleId, "WITHDRAW", encodeRun(draft));
    });
    return draft;
  }
  savePhase(plan: StageDraft, now: number) {
    verifyStage(plan, now);
    this.transaction(() => {
      const run = this.get(plan.cycleId);
      if (
        !run ||
        run.status !== "ACTIVE" ||
        plan.tokenId !== run.input.lot.tokenId ||
        hash(plan.capital) !== hash(run.capital)
      )
        throw new Error("Phase does not match active run and attributed capital");
      if (
        plan.phase === "WITHDRAW" ||
        hash(plan.calls.map((c) => c.id)) !== hash(phaseSteps[plan.phase])
      )
        throw new Error("Unexpected phase calls");
      const first = RETURN_STEPS.indexOf(plan.calls[0]!.id);
      if (this.steps(plan.cycleId).some((s) => s.ordinal < first && s.status !== "CONFIRMED"))
        throw new Error("Phase dependency unconfirmed");
      this.db
        .prepare("INSERT INTO return_phases(cycle_id,phase,plan) VALUES (?,?,?)")
        .run(plan.cycleId, plan.phase, encodeRun(plan));
    });
  }
  claim(cycle: string, plan: StageDraft, call: ReturnCall, baseline: unknown, now: number) {
    verifyStage(plan, now);
    this.transaction(() => {
      const run = this.get(cycle),
        saved = this.phase(cycle, plan.phase);
      if (
        !run ||
        run.status !== "ACTIVE" ||
        !saved ||
        saved.planHash !== plan.planHash ||
        plan.cycleId !== cycle ||
        !saved.calls.some((c) => hash(c) === hash(call))
      )
        throw new Error("Frozen run/phase/call mismatch or paused");
      const rows = this.steps(cycle),
        step = rows.find((s) => s.id === call.id);
      if (!step || step.status !== "READY")
        throw new Error("Step already started; reconcile without resending");
      if (rows.some((s) => s.ordinal < step.ordinal && s.status !== "CONFIRMED"))
        throw new Error("Previous step unconfirmed");
      this.db
        .prepare(
          "UPDATE return_steps SET status='SUBMITTING',call=?,baseline=?,plan_hash=? WHERE cycle_id=? AND id=?",
        )
        .run(encodeRun(call), encodeRun(baseline), plan.planHash, cycle, call.id);
    });
    return this.intent(cycle, call.id);
  }
  response(cycle: string, id: ReturnStepId, response: unknown) {
    const result = this.db
      .prepare(
        "UPDATE return_steps SET status='RECONCILE',response=? WHERE cycle_id=? AND id=? AND status='SUBMITTING'",
      )
      .run(encodeRun(response), cycle, id);
    if (!result.changes) throw new Error("Cannot overwrite recorded response");
  }
  confirm(cycle: string, id: ReturnStepId, evidence: unknown, capital: AttributedCapital) {
    this.transaction(() => {
      if (capital.amount0 < 0n || capital.amount1 < 0n)
        throw new Error("Negative attributed capital");
      const changed = this.db
        .prepare(
          "UPDATE return_steps SET status='CONFIRMED',evidence=? WHERE cycle_id=? AND id=? AND status='RECONCILE'",
        )
        .run(encodeRun(evidence), cycle, id);
      if (!changed.changes) throw new Error("Step is not awaiting receipt verification");
      this.db
        .prepare(
          "UPDATE return_runs SET capital=?,status=CASE WHEN ? THEN 'COMPLETE' ELSE status END WHERE cycle_id=?",
        )
        .run(
          encodeRun(capital),
          this.steps(cycle).every((s) => s.status === "CONFIRMED") ? 1 : 0,
          cycle,
        );
    });
  }
  pause(cycle: string) {
    const r = this.db
      .prepare("UPDATE return_runs SET status='PAUSED' WHERE cycle_id=? AND status='ACTIVE'")
      .run(cycle);
    if (!r.changes) throw new Error("Run is not active");
  }
  intent(cycle: string, id: ReturnStepId) {
    return hash({ namespace: "rangepark-return-testnet-v1", cycle, id });
  }
}
