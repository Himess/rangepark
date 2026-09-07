import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/state/journal.js";
import { demoInput } from "../src/demo/fixture.js";
import { buildParkPlan } from "../src/keeperhub/plan.js";
const tx = `0x${"12".repeat(32)}`;
function fixture() {
  const input = demoInput();
  const plan = buildParkPlan(input, input.position.owner);
  return { input, plan };
}
describe("durable journal", () => {
  it("keeps an explicit pause after a pending transaction is reconciled", () => {
    const db = new Journal(":memory:");
    const { input, plan } = fixture();
    db.create(plan, input.now);
    db.approve(plan, "owner", input.now);
    db.beginStep(plan, "release", input.now, {});
    db.recordHash(plan.planHash, "release", tx);
    db.pause(plan.planHash);
    db.markUnknown(plan.planHash, "release", "Receipt lookup timeout");
    db.confirm(plan.planHash, "release", tx, { verified: true }, true);
    expect(db.status(plan.planHash)).toBe("PAUSED");
    expect(() => db.beginStep(plan, "approve", input.now, {})).toThrow();
    db.close();
  });
  it("keeps observations after a process restart and resets on gaps", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "rangepark-")),
      "state.sqlite",
    );
    const { input } = fixture();
    const one = new Journal(path);
    one.recordObservation(input.position, 120);
    one.close();
    const two = new Journal(path);
    const next = {
      ...input.position,
      block: {
        ...input.position.block,
        number: input.position.block.number + 30n,
        timestamp: input.now + 60,
      },
    };
    expect(two.recordObservation(next, 120).since).toBe(input.now);
    two.close();
  });
  it("prevents duplicate plans and overlapping runs on one position", () => {
    const db = new Journal(":memory:");
    const { input, plan } = fixture();
    db.create(plan, input.now);
    expect(() => db.create(plan, input.now)).toThrow();
    const another = buildParkPlan(
      { ...input, economics: { ...input.economics, roundTripCost: 1n } },
      input.position.owner,
    );
    expect(() => db.create(another, input.now)).toThrow();
    db.close();
  });
  it("requires approval and confirmed dependencies", () => {
    const db = new Journal(":memory:");
    const { input, plan } = fixture();
    db.create(plan, input.now);
    expect(() => db.beginStep(plan, "release", input.now, {})).toThrow(
      "approval",
    );
    db.approve(plan, "fork-test", input.now);
    expect(() => db.beginStep(plan, "supply", input.now, {})).toThrow(
      "Dependency",
    );
    db.close();
  });
  it("never blindly retries an ambiguous submission, including after restart", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "rangepark-")),
      "state.sqlite",
    );
    const { input, plan } = fixture();
    const db = new Journal(path);
    db.create(plan, input.now);
    db.approve(plan, "fork-test", input.now);
    db.beginStep(plan, "release", input.now, { balance: "10" });
    db.markUnknown(plan.planHash, "release", "timeout");
    db.close();
    const reopened = new Journal(path);
    expect(reopened.status(plan.planHash)).toBe("RECOVERY");
    expect(() => reopened.beginStep(plan, "release", input.now, {})).toThrow();
    reopened.recordHash(plan.planHash, "release", tx);
    reopened.confirm(plan.planHash, "release", tx, { verified: true }, true);
    expect(() => reopened.beginStep(plan, "release", input.now, {})).toThrow(
      "already started",
    );
    reopened.beginStep(plan, "approve", input.now, {});
    reopened.close();
  });
  it("cannot replace an existing hash or confirm the wrong transaction", () => {
    const db = new Journal(":memory:");
    const { input, plan } = fixture();
    db.create(plan, input.now);
    db.approve(plan, "fork", input.now);
    db.beginStep(plan, "release", input.now, {});
    db.recordHash(plan.planHash, "release", tx);
    expect(() =>
      db.recordHash(plan.planHash, "release", `0x${"34".repeat(32)}`),
    ).toThrow();
    expect(() =>
      db.confirm(plan.planHash, "release", `0x${"34".repeat(32)}`, {}, true),
    ).toThrow();
    db.close();
  });
  it("only completes after all confirmed steps", () => {
    const db = new Journal(":memory:");
    const { input, plan } = fixture();
    db.create(plan, input.now);
    db.approve(plan, "fork", input.now);
    for (const step of plan.steps) {
      db.beginStep(plan, step.id, input.now, {});
      db.recordHash(plan.planHash, step.id, tx);
      db.confirm(plan.planHash, step.id, tx, { verified: true }, true);
    }
    expect(db.status(plan.planHash)).toBe("COMPLETED");
    expect(db.history(plan.planHash)).toHaveLength(11);
    db.close();
  });
});
