import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { json } from "../core/serialization.js";

// A renewable process lease prevents overlapping monitors; crashed owners expire.
// Status is historical: consumers must check updated_at, never infer liveness from RUNNING.
export class ReturnMonitorStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS status (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL, payload TEXT NOT NULL);`);
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
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquire(owner: string, now: number) {
    this.transaction(() => {
      const current = this.db.prepare("SELECT expires FROM lease WHERE id=1").get() as
        | { expires: number }
        | undefined;
      if (current && current.expires > now) throw Error("Another RETURN monitor holds the lease");
      this.db.prepare("INSERT OR REPLACE INTO lease VALUES (1,?,?)").run(owner, now + 120);
    });
  }
  renew(owner: string, now: number) {
    const result = this.db
      .prepare("UPDATE lease SET expires=? WHERE id=1 AND owner=? AND expires>?")
      .run(now + 120, owner, now);
    if (result.changes !== 1) throw Error("RETURN monitor lease expired or changed");
  }
  commit<T>(owner: string, now: number, makeReport: () => T, sample = true) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT owner,expires FROM lease WHERE id=1").get() as
        | { owner: string; expires: number }
        | undefined;
      if (!current || current.owner !== owner || current.expires <= now)
        throw Error("RETURN monitor lost its lease");
      const report = makeReport(),
        payload = json(report);
      if (sample) {
        this.db.prepare("INSERT INTO samples(at,payload) VALUES (?,?)").run(now, payload);
        this.db.exec(
          "DELETE FROM samples WHERE id NOT IN (SELECT id FROM samples ORDER BY id DESC LIMIT 120)",
        );
      }
      this.db.prepare("INSERT OR REPLACE INTO status VALUES (1,?,?)").run(now, payload);
      return report;
    });
  }
  release(owner: string) {
    this.db.prepare("DELETE FROM lease WHERE id=1 AND owner=?").run(owner);
  }
  read() {
    const row = this.db.prepare("SELECT at,payload FROM status WHERE id=1").get() as
      | { at: number; payload: string }
      | undefined;
    return row ? { updatedAt: row.at, report: JSON.parse(row.payload) as unknown } : null;
  }
  samples() {
    return (
      this.db.prepare("SELECT payload FROM samples ORDER BY id").all() as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as unknown);
  }
}
