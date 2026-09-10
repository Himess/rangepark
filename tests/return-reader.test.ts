import { describe, expect, it, vi } from "vitest";
import { readTimeAlignedHead, type TestnetReturnClient } from "../src/testnet/return-reader.js";
import { returnSnapshotReasons, defaultReturnPolicy } from "../src/testnet/return-policy.js";
import { returnFixture } from "./fixtures/return.js";
describe("time-aligned RETURN block reads", () => {
  it("retains a current tip without extra reads", async () => {
    const head = { number: 100n, timestamp: 10000n },
      getBlock = vi.fn().mockResolvedValue(head);
    expect(
      await readTimeAlignedHead({ getBlock } as unknown as TestnetReturnClient, 10000),
    ).toEqual(head);
    expect(getBlock).toHaveBeenCalledOnce();
  });
  it("uses an actual earlier block when the tip is ahead, preserving its timestamp", async () => {
    const head = { number: 100n, timestamp: 10001n },
      earlier = { number: 98n, timestamp: 9997n },
      getBlock = vi.fn().mockResolvedValueOnce(head).mockResolvedValue(earlier);
    expect(
      await readTimeAlignedHead({ getBlock } as unknown as TestnetReturnClient, 10000),
    ).toEqual(earlier);
    expect(getBlock).toHaveBeenLastCalledWith({ blockNumber: 98n });
  });
  it("does not make an earlier block eligible when the host clock remains too far behind", async () => {
    const head = { number: 100n, timestamp: 10101n },
      earlier = { number: 98n, timestamp: 10097n },
      getBlock = vi.fn().mockResolvedValueOnce(head).mockResolvedValue(earlier);
    const block = await readTimeAlignedHead({ getBlock } as unknown as TestnetReturnClient, 10000),
      snapshot = returnFixture(Number(block.timestamp));
    expect(returnSnapshotReasons(snapshot, defaultReturnPolicy, 10000)).toContain("STALE_DATA");
  });
  it("does not request a negative block at chain startup", async () => {
    const getBlock = vi
      .fn()
      .mockResolvedValueOnce({ number: 1n, timestamp: 10001n })
      .mockResolvedValue({ number: 0n, timestamp: 9999n });
    await readTimeAlignedHead({ getBlock } as unknown as TestnetReturnClient, 10000);
    expect(getBlock).toHaveBeenLastCalledWith({ blockNumber: 0n });
  });
  it.each([NaN, -1])("rejects invalid host time %s", async (now) => {
    const getBlock = vi.fn();
    await expect(
      readTimeAlignedHead({ getBlock } as unknown as TestnetReturnClient, now),
    ).rejects.toThrow("Invalid read time");
    expect(getBlock).not.toHaveBeenCalled();
  });
});
