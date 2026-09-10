import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ReturnMonitorStore } from "../src/state/return-monitor.js";
import { ReturnObservationStore } from "../src/state/return-observations.js";
import {
  monitorReturnOnce,
  runMonitorLoop,
  type MonitorReport,
  type MonitorDependencies,
} from "../src/testnet/return-monitor.js";
import { eligibleReturnInput, returnFixture } from "./fixtures/return.js";
import { json } from "../src/core/serialization.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function setup() {
  let now = 10000;
  const history = new ReturnObservationStore(":memory:");
  cleanup.push(() => history.close());
  const deps: MonitorDependencies = {
    clock: () => now,
    lot: () => returnFixture(now).lot,
    snapshot: async () => returnFixture(now),
    economics: async () => ({
      quote: { ...eligibleReturnInput().economics!, quotedAt: now, expiresAt: now + 120 },
      evidence: "SYNTHETIC_TEST_ONLY",
    }),
    blockHash: async (number) => returnFixture(Number(number)).position.block.hash,
    history,
    commit: (_now, make) => make(),
  };
  // Fixture block numbers equal fixture timestamps.
  return {
    deps,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe("read-only RETURN monitor", () => {
  it("rebuilds five-minute persistence with fresh economics on each sample", async () => {
    const f = setup();
    let last: MonitorReport | undefined;
    for (let now = 10000; now <= 10300; now += 60) {
      f.setNow(now);
      last = await monitorReturnOnce(f.deps);
    }
    expect(last?.decision?.action).toBe("RETURN");
    expect(last?.broadcasts).toBe(0);
    expect(last?.economics?.quotedAt).toBe(10300);
  });
  it("does not reuse an old quote after an economics failure", async () => {
    const f = setup();
    await monitorReturnOnce(f.deps);
    f.setNow(10060);
    f.deps.economics = async () => {
      throw Error("secret RPC URL");
    };
    const report = await monitorReturnOnce(f.deps);
    expect(report.status).toBe("DEGRADED");
    expect(report.economics).toBeNull();
    expect(report.decision?.reasons).toContain("RETURN_ECONOMICS_MISSING");
    expect(json(report)).not.toContain("secret RPC");
  });
  it("clears the current decision on RPC failure without fabricating an observation", async () => {
    const f = setup();
    await monitorReturnOnce(f.deps);
    const previous = f.deps.history.get(f.deps.lot().cycleId);
    f.setNow(10060);
    f.deps.snapshot = async () => {
      throw Error("unavailable");
    };
    const report = await monitorReturnOnce(f.deps);
    expect(report.decision).toBeNull();
    expect(report.errors).toEqual(["SNAPSHOT_FAILED"]);
    expect(f.deps.history.get(f.deps.lot().cycleId)).toEqual(previous);
  });
  it("resets persistence after a monitoring gap", async () => {
    const f = setup();
    await monitorReturnOnce(f.deps);
    f.setNow(10121);
    const report = await monitorReturnOnce(f.deps);
    expect(report.observation?.samples).toBe(1);
    expect(report.decision?.action).toBe("HOLD");
  });
  it("discards snapshots that expire while economics is being read", async () => {
    const f = setup();
    f.deps.economics = async () => {
      f.setNow(10061);
      return { quote: eligibleReturnInput().economics!, evidence: null };
    };
    const report = await monitorReturnOnce(f.deps);
    expect(report.decision).toBeNull();
    expect(report.errors).toEqual(["REVALIDATE_FAILED"]);
    expect(f.deps.history.get(f.deps.lot().cycleId)).toBeNull();
  });
  it("rejects an allocation changed during RPC reads", async () => {
    const f = setup();
    const lot = f.deps.lot();
    let calls = 0;
    f.deps.lot = () => (++calls === 1 ? lot : { ...lot, status: "RECOVERY" });
    const report = await monitorReturnOnce(f.deps);
    expect(report.decision).toBeNull();
    expect(report.errors).toEqual(["REVALIDATE_FAILED"]);
  });
  it("rejects a reorg of the current snapshot", async () => {
    const f = setup();
    f.deps.blockHash = async () => "different";
    const report = await monitorReturnOnce(f.deps);
    expect(report.decision).toBeNull();
    expect(report.errors).toEqual(["REVALIDATE_FAILED"]);
  });
});
describe("monitor lease and journal", () => {
  it("excludes other processes, survives reopen, and fences a crashed owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "rangepark-monitor-"));
    cleanup.push(() => {
      const target = resolve(dir);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("rangepark-monitor-"))
        throw Error("Unsafe test cleanup path");
      rmSync(target, { recursive: true, force: true });
    });
    const path = join(dir, "monitor.sqlite"),
      first = new ReturnMonitorStore(path);
    first.acquire("first", 1000);
    first.commit("first", 1001, () => ({ decision: "HOLD" }));
    first.close();
    const second = new ReturnMonitorStore(path);
    cleanup.push(() => second.close());
    expect(second.read()?.report).toEqual({ decision: "HOLD" });
    expect(() => second.acquire("second", 1100)).toThrow("Another");
    second.acquire("second", 1120);
    const staleWrite = vi.fn();
    expect(() => second.commit("first", 1121, staleWrite)).toThrow("lost");
    expect(staleWrite).not.toHaveBeenCalled();
    second.release("first");
    second.renew("second", 1122);
  });
  it("cannot revive an expired lease with a late heartbeat", () => {
    const store = new ReturnMonitorStore(":memory:");
    cleanup.push(() => store.close());
    store.acquire("a", 1000);
    expect(() => store.renew("a", 1120)).toThrow("expired");
  });
  it("retains the latest 120 samples and clears actionable status at stop", () => {
    const store = new ReturnMonitorStore(":memory:");
    cleanup.push(() => store.close());
    store.acquire("a", 1000);
    for (let i = 0; i < 125; i++) store.commit("a", 1001, () => ({ sample: i }));
    store.commit("a", 1002, () => ({ status: "STOPPED", decision: null }), false);
    expect(store.samples()).toHaveLength(120);
    expect(store.samples()[0]).toEqual({ sample: 5 });
    expect(store.read()?.report).toEqual({ status: "STOPPED", decision: null });
  });
});
describe("sequential monitor scheduling", () => {
  it("does not overlap slow samples or burst to catch up", async () => {
    let time = 0;
    const waits: number[] = [];
    await runMonitorLoop({
      signal: new AbortController().signal,
      maxSamples: 3,
      clock: () => time,
      tick: async () => {
        time += 80000;
      },
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    });
    expect(waits).toEqual([1000, 1000]);
  });
  it("aborts during the interval without another sample", async () => {
    const controller = new AbortController(),
      tick = vi.fn(async () => {});
    await runMonitorLoop({
      signal: controller.signal,
      tick,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
