import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hash, json } from "../core/serialization.js";
import { observePosition } from "../core/range.js";
import type { Observation, PositionSnapshot } from "../core/models.js";
import type { ExecutionPlan } from "../keeperhub/plan.js";
import { verifyPlan } from "../keeperhub/plan.js";

export type StepStatus =
  | "READY"
  | "SUBMITTING"
  | "PENDING"
  | "UNKNOWN"
  | "CONFIRMED"
  | "REVERTED";
export type StepRecord = {
  plan_hash: string;
  step_id: string;
  ordinal: number;
  status: StepStatus;
  tx_hash: string | null;
  evidence: string | null;
};

export class Journal {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (plan_hash TEXT PRIMARY KEY, position_key TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_run ON runs(position_key) WHERE status NOT IN ('COMPLETED','CANCELLED');
      CREATE TABLE IF NOT EXISTS steps (plan_hash TEXT NOT NULL REFERENCES runs(plan_hash), step_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'READY', tx_hash TEXT, evidence TEXT, PRIMARY KEY(plan_hash,step_id));
      CREATE TABLE IF NOT EXISTS observations (position_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, plan_hash TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "paused"))
      this.db.exec(
        "ALTER TABLE runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
      );
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
  private event(plan: string, kind: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO events(plan_hash,kind,payload,created_at) VALUES (?,?,?,?)",
      )
      .run(plan, kind, json(payload), Date.now());
  }
  recordObservation(
    position: PositionSnapshot,
    maxGapSeconds: number,
  ): Observation {
    return this.transaction(() => {
      const key = `${position.chainId}:${position.tokenId}`;
      const row = this.db
        .prepare("SELECT payload FROM observations WHERE position_key=?")
        .get(key) as { payload: string } | undefined;
      const raw = row ? (JSON.parse(row.payload) as Observation) : null;
      const previous = raw
        ? { ...raw, lastBlock: BigInt(raw.lastBlock) }
        : null;
      const next = observePosition(position, previous, maxGapSeconds);
      this.db
        .prepare(
          "INSERT INTO observations(position_key,payload) VALUES (?,?) ON CONFLICT(position_key) DO UPDATE SET payload=excluded.payload",
        )
        .run(key, json(next));
      return next;
    });
  }
  create(plan: ExecutionPlan, now: number) {
    verifyPlan(plan, now);
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO runs(plan_hash,position_key,plan,status,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          plan.planHash,
          `${plan.chainId}:${plan.positionId}`,
          json(plan),
          "PLANNED",
          now,
        );
      for (const [i, step] of plan.steps.entries())
        this.db
          .prepare(
            "INSERT INTO steps(plan_hash,step_id,ordinal) VALUES (?,?,?)",
          )
          .run(plan.planHash, step.id, i);
      this.event(plan.planHash, "PLAN_CREATED", { hash: plan.planHash });
    });
  }
  approve(plan: ExecutionPlan, actor: string, now: number) {
    verifyPlan(plan, now);
    if (!actor.trim()) throw new Error("Approval actor required");
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE runs SET status='APPROVED',approved_by=? WHERE plan_hash=? AND status='PLANNED'",
        )
        .run(actor, plan.planHash);
      if (!result.changes) throw new Error("Plan cannot be approved");
      this.event(plan.planHash, "APPROVED", { actor });
    });
  }
  steps(planHash: string): StepRecord[] {
    return this.db
      .prepare("SELECT * FROM steps WHERE plan_hash=? ORDER BY ordinal")
      .all(planHash) as StepRecord[];
  }
  status(planHash: string): string | undefined {
    return (
      this.db
        .prepare("SELECT status FROM runs WHERE plan_hash=?")
        .get(planHash) as { status: string } | undefined
    )?.status;
  }
  beginStep(plan: ExecutionPlan, id: string, now: number, baseline: unknown) {
    verifyPlan(plan, now);
    this.transaction(() => {
      if (!["APPROVED", "RUNNING"].includes(this.status(plan.planHash) ?? ""))
        throw new Error("Run needs approval or reconciliation");
      const records = this.steps(plan.planHash);
      const step = records.find((s) => s.step_id === id);
      if (!step || step.status !== "READY")
        throw new Error("Step already started; reconcile before retrying");
      if (
        records.some(
          (s) => s.ordinal < step.ordinal && s.status !== "CONFIRMED",
        )
      )
        throw new Error("Dependency not confirmed");
      this.db
        .prepare(
          "UPDATE steps SET status='SUBMITTING',evidence=? WHERE plan_hash=? AND step_id=?",
        )
        .run(json({ baseline }), plan.planHash, id);
      this.db
        .prepare("UPDATE runs SET status='RUNNING' WHERE plan_hash=?")
        .run(plan.planHash);
      this.event(plan.planHash, "SUBMITTING", {
        step: id,
        idempotencyKey: this.idempotencyKey(plan.planHash, id),
        baseline,
      });
    });
  }
  recordHash(planHash: string, id: string, txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
      throw new Error("Invalid transaction hash");
    const result = this.db
      .prepare(
        "UPDATE steps SET status='PENDING',tx_hash=? WHERE plan_hash=? AND step_id=? AND status IN ('SUBMITTING','UNKNOWN') AND tx_hash IS NULL",
      )
      .run(txHash, planHash, id);
    if (!result.changes)
      throw new Error("Cannot replace a submitted transaction");
    this.event(planHash, "TRANSACTION_SUBMITTED", { step: id, txHash });
  }
  markUnknown(planHash: string, id: string, reason: string) {
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE steps SET status='UNKNOWN' WHERE plan_hash=? AND step_id=? AND status IN ('SUBMITTING','PENDING','UNKNOWN')",
        )
        .run(planHash, id);
      if (!result.changes)
        throw new Error("Only a started step can become unknown");
      this.db
        .prepare(
          "UPDATE runs SET status=CASE WHEN paused=1 THEN 'PAUSED' ELSE 'RECOVERY' END WHERE plan_hash=?",
        )
        .run(planHash);
      this.event(planHash, "RECONCILIATION_REQUIRED", { step: id, reason });
    });
  }
  confirm(
    planHash: string,
    id: string,
    txHash: string,
    evidence: unknown,
    success: boolean,
  ) {
    this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE steps SET status=?,evidence=? WHERE plan_hash=? AND step_id=? AND tx_hash=? AND status IN ('PENDING','UNKNOWN')",
        )
        .run(
          success ? "CONFIRMED" : "REVERTED",
          json(evidence),
          planHash,
          id,
          txHash,
        );
      if (!result.changes)
        throw new Error("Confirmation must match the recorded transaction");
      const complete = this.steps(planHash).every(
        (s) => s.status === "CONFIRMED",
      );
      this.db
        .prepare(
          "UPDATE runs SET status=CASE WHEN ? THEN 'COMPLETED' WHEN paused=1 THEN 'PAUSED' ELSE ? END WHERE plan_hash=?",
        )
        .run(complete ? 1 : 0, success ? "APPROVED" : "RECOVERY", planHash);
      this.event(planHash, success ? "STEP_VERIFIED" : "STEP_REVERTED", {
        id,
        txHash,
        evidence,
      });
    });
  }
  pause(planHash: string) {
    const result = this.db
      .prepare(
        "UPDATE runs SET status='PAUSED',paused=1 WHERE plan_hash=? AND status IN ('PLANNED','APPROVED','RUNNING','RECOVERY')",
      )
      .run(planHash);
    if (!result.changes) throw new Error("Cannot pause this run");
  }
  idempotencyKey(planHash: string, stepId: string) {
    return hash({ namespace: "rangepark-v1", planHash, stepId });
  }
  history(planHash: string) {
    return this.db
      .prepare(
        "SELECT kind,payload,created_at FROM events WHERE plan_hash=? ORDER BY id",
      )
      .all(planHash);
  }
}
