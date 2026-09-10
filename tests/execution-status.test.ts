import { describe, expect, it, vi } from "vitest";
import {
  ExecutionReceiptPending,
  verifiedTestnetExecution,
} from "../src/testnet/execution-status.js";
import { pollReturnReceipt } from "../src/testnet/return-receipts.js";
const transactionHash = `0x${"ab".repeat(32)}`;
function complete() {
  return {
    executionId: "known",
    status: "completed",
    sponsored: true,
    transactionHash,
    receipts: [{ hash: transactionHash, chainId: 84532, verified: true, receiptStatus: "success" }],
  };
}
const headers = (hint?: string) =>
  new Headers(hint === undefined ? {} : { "X-Poll-Interval-Hint": hint });
describe("KeeperHub authoritative status and poll hints", () => {
  it.each(["pending", "running", "unconfirmed", "settling_v2"])(
    "keeps %s pending even before a hash exists",
    (status) => {
      expect(() =>
        verifiedTestnetExecution({ executionId: "known", status }, "known", headers("7")),
      ).toThrow(ExecutionReceiptPending);
    },
  );
  it("uses the positive header despite a completed status string and available receipt", () => {
    try {
      verifiedTestnetExecution(complete(), "known", headers("7"));
      throw Error("Should remain pending");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutionReceiptPending);
      expect((e as ExecutionReceiptPending).retryAfterMs).toBe(7000);
    }
  });
  it("accepts a new terminal status only with zero hint and a verified testnet receipt", () => {
    expect(
      verifiedTestnetExecution({ ...complete(), status: "settled_v2" }, "known", headers("0"))
        .transactionHash,
    ).toBe(transactionHash);
    expect(() =>
      verifiedTestnetExecution(
        { ...complete(), status: "settled_v2", receipts: [] },
        "known",
        headers("0"),
      ),
    ).toThrow("lacks a verified");
  });
  it.each([undefined, "junk", "-1", ""])(
    "keeps unknown status pending with missing/malformed hint %s",
    (hint) => {
      expect(() =>
        verifiedTestnetExecution({ ...complete(), status: "settling_v2" }, "known", headers(hint)),
      ).toThrow(ExecutionReceiptPending);
    },
  );
  it.each(["0", undefined])(
    "allows a completed execution only with positive receipt proof (hint %s)",
    (hint) => {
      expect(verifiedTestnetExecution(complete(), "known", headers(hint)).sponsored).toBe(true);
    },
  );
  it.each([
    "failed",
    "foreign-id",
    "other-chain",
    "other-hash",
    "unverified",
    "reverted",
    "safe-inner-failure",
    "no-receipt",
  ])("never polls or treats %s as successful", (kind) => {
    const body = complete();
    if (kind === "failed") body.status = "failed";
    if (kind === "foreign-id") body.executionId = "other";
    if (kind === "other-chain") body.receipts[0]!.chainId = 8453;
    if (kind === "other-hash") body.receipts[0]!.hash = `0x${"cd".repeat(32)}`;
    if (kind === "unverified") body.receipts[0]!.verified = false;
    if (kind === "reverted") body.receipts[0]!.receiptStatus = "reverted";
    if (kind === "safe-inner-failure") body.receipts[0]!.receiptStatus = "safe_inner_failure";
    if (kind === "no-receipt") body.receipts = [];
    try {
      verifiedTestnetExecution(body, "known", headers("0"));
      throw Error("unexpected acceptance");
    } catch (e) {
      expect(e).not.toBeInstanceOf(ExecutionReceiptPending);
      expect((e as Error).message).not.toBe("unexpected acceptance");
    }
  });
  it("honors the server interval rather than the shorter fallback", async () => {
    const verify = vi
        .fn()
        .mockRejectedValueOnce(new ExecutionReceiptPending("wait", 7000))
        .mockResolvedValue("verified"),
      wait = vi.fn().mockResolvedValue(undefined);
    await expect(pollReturnReceipt(verify, { wait, delayMs: 1 })).resolves.toBe("verified");
    expect(wait).toHaveBeenCalledWith(7000);
  });
  it("bounds accumulated wait without shortening the server interval", async () => {
    const verify = vi.fn().mockRejectedValue(new ExecutionReceiptPending("wait", 40000)),
      wait = vi.fn().mockResolvedValue(undefined);
    await expect(pollReturnReceipt(verify, { wait, attempts: 5 })).rejects.toThrow("wait");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(40000);
    expect(verify).toHaveBeenCalledTimes(2);
  });
  it("does not wait or recheck when one server interval exceeds the entire budget", async () => {
    const verify = vi.fn().mockRejectedValue(new ExecutionReceiptPending("wait", 61000)),
      wait = vi.fn();
    await expect(pollReturnReceipt(verify, { wait })).rejects.toThrow("wait");
    expect(verify).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
  it("converts fractional seconds correctly without early polling", () => {
    try {
      verifiedTestnetExecution(
        { executionId: "known", status: "pending" },
        "known",
        headers("0.0011"),
      );
    } catch (e) {
      expect((e as ExecutionReceiptPending).retryAfterMs).toBe(2);
      return;
    }
    throw Error("Expected pending");
  });
  it("rejects unsafe numeric hints without silently polling on a short fallback", () => {
    expect(() =>
      verifiedTestnetExecution(complete(), "known", headers("9999999999999999999999999999999")),
    ).toThrow("Invalid KeeperHub poll interval");
  });
});
