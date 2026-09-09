import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hash, json } from "../core/serialization.js";
import {
  observeReturn,
  type ReturnObservation,
  type ReturnPolicy,
  type ReturnSnapshot,
} from "../testnet/return-policy.js";

// Separate from PARK samples: eligibility includes every observed TWAP and lot identity.
export class ReturnObservationStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS return_observations (cycle_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  get(cycleId: string): ReturnObservation | null {
    const row = this.db
      .prepare("SELECT payload FROM return_observations WHERE cycle_id=?")
      .get(cycleId) as { payload: string } | undefined;
    if (!row) return null;
    const result = JSON.parse(row.payload) as ReturnObservation;
    result.block.number = BigInt(result.block.number);
    return result;
  }
  record(
    snapshot: ReturnSnapshot,
    policy: ReturnPolicy,
    now: number,
    checkedPrevious: ReturnObservation | null,
    previousIsCanonical: boolean,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(snapshot.lot.cycleId);
      // The caller checked this previous block against RPC. A competing sample
      // invalidates that check; never overwrite it or reuse an unchecked ancestor.
      if (hash(current) !== hash(checkedPrevious))
        throw new Error("Observation changed concurrently; read again");
      const next = observeReturn(snapshot, policy, current, now, previousIsCanonical);
      this.db
        .prepare(
          "INSERT INTO return_observations(cycle_id,payload) VALUES (?,?) ON CONFLICT(cycle_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(snapshot.lot.cycleId, json(next));
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
