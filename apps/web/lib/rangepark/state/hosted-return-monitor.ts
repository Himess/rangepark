import { json } from "../core/serialization.js";
import type { ReturnObservation } from "../testnet/return-policy.js";

export interface MonitorDatabase {
  prepare(sql: string): {
    bind(...args: (string | number | null)[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}
export type HostedMonitorRow = {
  id: string;
  lease_owner: string;
  lease_until: number;
  slot: number;
  observation: string | null;
  report: string | null;
  recent: string;
  updated_at: number;
};

export class HostedReturnMonitorStore {
  constructor(
    private db: MonitorDatabase,
    private id: string,
  ) {}
  async get() {
    return this.db
      .prepare("SELECT * FROM hosted_return_monitor WHERE id=?")
      .bind(this.id)
      .first<HostedMonitorRow>();
  }
  async acquire(owner: string, now: number) {
    const result = await this.db
      .prepare(`INSERT INTO hosted_return_monitor
      (id,lease_owner,lease_until,slot,observation,report,recent,updated_at)
      VALUES (?,?,?,?,NULL,NULL,'[]',0)
      ON CONFLICT(id) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,slot=excluded.slot
      WHERE hosted_return_monitor.lease_until<=? AND hosted_return_monitor.slot<excluded.slot`)
      .bind(this.id, owner, now + 55, Math.floor(now / 60), now)
      .run();
    return result.meta?.changes === 1;
  }
  async complete(
    owner: string,
    now: number,
    observation: ReturnObservation | null,
    report: unknown,
    recent: unknown[],
  ) {
    const result = await this.db
      .prepare(`UPDATE hosted_return_monitor SET
      observation=?,report=?,recent=?,updated_at=?,lease_until=0
      WHERE id=? AND lease_owner=? AND lease_until>?`)
      .bind(
        observation ? json(observation) : null,
        json(report),
        json(recent.slice(-120)),
        now,
        this.id,
        owner,
        now,
      )
      .run();
    if (result.meta?.changes !== 1) throw Error("Hosted monitor lease lost");
  }
}

export function decodeHostedObservation(row: HostedMonitorRow | null): ReturnObservation | null {
  if (!row?.observation) return null;
  const observation = JSON.parse(row.observation) as ReturnObservation;
  observation.block.number = BigInt(observation.block.number);
  return observation;
}
