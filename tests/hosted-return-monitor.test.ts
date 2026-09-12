import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  HostedReturnMonitorStore,
  decodeHostedObservation,
  type MonitorDatabase,
} from "../src/state/hosted-return-monitor.js";
import {
  authorizedMonitorRequest,
  hostedReturnTick,
} from "../src/testnet/hosted-return-monitor.js";
import { eligibleReturnInput, returnFixture } from "./fixtures/return.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
function setup() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec(readFileSync("apps/web/drizzle/0001_sleepy_wrecking_crew.sql", "utf8"));
  const adapter: MonitorDatabase = {
    prepare: (query) => ({
      bind: (...args) => ({
        first: async <T>() => (sql.prepare(query).get(...args) as T | undefined) ?? null,
        run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
      }),
    }),
  };
  const store = new HostedReturnMonitorStore(adapter, "allocation");
  let now = 10000;
  const dependencies = {
    store,
    lot: returnFixture().lot,
    snapshot: async () => returnFixture(now),
    economics: async () => ({
      quote: { ...eligibleReturnInput().economics!, quotedAt: now, expiresAt: now + 120 },
      evidence: "SYNTHETIC_TEST",
    }),
    blockHash: async (number: bigint) => returnFixture(Number(number)).position.block.hash,
    clock: () => now,
  };
  return {
    store,
    dependencies,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe("hosted RETURN ownership using production migration and SQL", () => {
  it("deduplicates a minute even after a completed run releases its lease", async () => {
    const { store } = setup();
    expect(await store.acquire("one", 10000)).toBe(true);
    await store.complete("one", 10001, null, {}, []);
    expect(await store.acquire("duplicate", 10002)).toBe(false);
    expect(await store.acquire("next", 10060)).toBe(true);
  });
  it("does not overlap work across minute boundaries", async () => {
    const { store } = setup();
    expect(await store.acquire("one", 10019)).toBe(true);
    expect(await store.acquire("two", 10020)).toBe(false);
  });
  it("fences late writes after an expired lease is replaced", async () => {
    const { store } = setup();
    await store.acquire("old", 10000);
    expect(await store.acquire("new", 10060)).toBe(true);
    await expect(store.complete("old", 10061, null, { bad: true }, [])).rejects.toThrow("lost");
    await store.complete("new", 10062, null, { good: true }, []);
    expect(JSON.parse((await store.get())!.report!)).toEqual({ good: true });
  });
  it("commits observation and decision together and bounds recent history", async () => {
    const { store } = setup(),
      observation = eligibleReturnInput().observation!;
    await store.acquire("owner", 10000);
    await store.complete(
      "owner",
      10001,
      observation,
      { action: "HOLD" },
      Array.from({ length: 130 }, (_, i) => i),
    );
    const row = await store.get();
    expect(decodeHostedObservation(row)).toEqual(observation);
    expect(JSON.parse(row!.recent)).toHaveLength(120);
    expect(JSON.parse(row!.recent)[0]).toBe(10);
  });
});
describe("hosted read-only checks", () => {
  it("accumulates independent requests into a passing review decision", async () => {
    const f = setup();
    for (let at = 10000; at <= 10300; at += 60) {
      f.setNow(at);
      await hostedReturnTick(f.dependencies);
    }
    const report = JSON.parse((await f.store.get())!.report!);
    expect(report.decision.action).toBe("RETURN");
    expect(report.broadcasts).toBe(0);
  });
  it("performs no RPC on an already claimed minute", async () => {
    const f = setup();
    await hostedReturnTick(f.dependencies);
    f.dependencies.snapshot = vi.fn(f.dependencies.snapshot);
    expect((await hostedReturnTick(f.dependencies)).status).toBe("SKIPPED");
    expect(f.dependencies.snapshot).not.toHaveBeenCalled();
  });
  it("starts both canonicality reads together without omitting either block", async () => {
    const f = setup();
    await hostedReturnTick(f.dependencies);
    f.setNow(10060);
    const pending: (() => void)[] = [];
    const numbers: bigint[] = [];
    f.dependencies.blockHash = (number) => new Promise<`0x${string}`>((resolve) => {
      numbers.push(number);
      pending.push(() => resolve(returnFixture(Number(number)).position.block.hash));
      if (pending.length === 2) pending.forEach((finish) => finish());
    });
    await hostedReturnTick(f.dependencies);
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).not.toBe(numbers[1]);
    expect(JSON.parse((await f.store.get())!.report!).status).toBe("OBSERVED");
  });
  it("reports a provider request budget failure without leaking its endpoint", async () => {
    const f = setup();
    f.dependencies.blockHash = async () => { throw Error("Too many API requests: secret endpoint"); };
    await hostedReturnTick(f.dependencies);
    const report = (await f.store.get())!.report!;
    expect(JSON.parse(report).failureReason).toBe("RPC_SUBREQUEST_LIMIT");
    expect(report).not.toContain("secret endpoint");
    expect(JSON.parse(report).decision).toBeNull();
  });
  it("classifies upstream throttling while preserving the previous observation", async () => {
    const f = setup();
    await hostedReturnTick(f.dependencies);
    const before = (await f.store.get())!.observation;
    f.setNow(10060);
    f.dependencies.blockHash = async () => { throw Error("RPC Request failed. Details: over rate limit"); };
    await hostedReturnTick(f.dependencies);
    const row = (await f.store.get())!;
    expect(JSON.parse(row.report!).failureReason).toBe("RPC_RATE_LIMIT");
    expect(JSON.parse(row.report!).decision).toBeNull();
    expect(row.observation).toBe(before);
  });
  it("clears the current decision on RPC failure while preserving historical observations", async () => {
    const f = setup();
    await hostedReturnTick(f.dependencies);
    const before = (await f.store.get())!.observation;
    f.setNow(10060);
    f.dependencies.snapshot = async () => {
      throw Error("secret endpoint");
    };
    await hostedReturnTick(f.dependencies);
    const row = await f.store.get(),
      report = JSON.parse(row!.report!);
    expect(report.decision).toBeNull();
    expect(report.errors).toEqual(["SNAPSHOT_FAILED"]);
    expect(row!.observation).toBe(before);
    expect(row!.report).not.toContain("secret endpoint");
  });
  it("does not reuse previous economics when its refresh fails", async () => {
    const f = setup();
    await hostedReturnTick(f.dependencies);
    f.setNow(10060);
    f.dependencies.economics = async () => {
      throw Error("unavailable");
    };
    await hostedReturnTick(f.dependencies);
    const report = JSON.parse((await f.store.get())!.report!);
    expect(report.economics).toBeNull();
    expect(report.decision.reasons).toContain("RETURN_ECONOMICS_MISSING");
  });
  it("refuses a sample whose source block changed", async () => {
    const f = setup();
    f.dependencies.blockHash = async () => "0xabcdef";
    await hostedReturnTick(f.dependencies);
    expect(JSON.parse((await f.store.get())!.report!).decision).toBeNull();
    expect((await f.store.get())!.observation).toBeNull();
  });
  it("does not commit after its 55-second lease expires", async () => {
    const f = setup();
    f.dependencies.economics = async () => {
      f.setNow(10056);
      throw Error("timeout");
    };
    await expect(hostedReturnTick(f.dependencies)).rejects.toThrow("lost");
    expect((await f.store.get())!.report).toBeNull();
  });
});
describe("scheduler authentication", () => {
  it("rejects missing, malformed and incorrect bearer credentials", async () => {
    for (const [header, secret] of [
      [null, undefined],
      ["Bearer " + "a".repeat(64), undefined],
      ["Basic abc", "a".repeat(64)],
      ["Bearer " + "b".repeat(64), "a".repeat(64)],
    ] as const)
      expect(await authorizedMonitorRequest(header, secret)).toBe(false);
  });
  it("accepts only the configured monitor secret", async () => {
    expect(await authorizedMonitorRequest("Bearer " + "a".repeat(64), "a".repeat(64))).toBe(true);
  });
});
