import { describe, it, expect, vi } from "vitest";
import {
  depositIntent,
  submitTestnetDepositOnce,
  TestnetDepositStore,
} from "../src/testnet/execution.js";

const owner = "0x1111111111111111111111111111111111111111" as const;
function fixture() {
  return {
    apiKey: "test-key",
    owner,
    chainId: 84532,
    simulationAt: Date.now(),
    baseline: "{}",
    store: new TestnetDepositStore(":memory:"),
  };
}
describe("single testnet principal allocation", () => {
  it("commits the exact request and stable idempotency key before sending", async () => {
    const args = fixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_, options) => {
        const row = args.store.get(depositIntent(owner, 84532))!;
        expect(row.status).toBe("SUBMITTING");
        expect(row.request).toBe(options?.body);
        expect(JSON.parse(row.request)).toMatchObject({
          chainId: 84532,
          value: "0.001",
          functionName: "deposit",
        });
        expect(JSON.parse(row.request)).not.toHaveProperty("simulate");
        expect(
          (options?.headers as Record<string, string>)["Idempotency-Key"],
        ).toBe(row.intent);
        return new Response(
          JSON.stringify({ executionId: "direct_test", status: "completed" }),
        );
      });
    try {
      await submitTestnetDepositOnce(args, fetcher);
      await expect(submitTestnetDepositOnce(args, fetcher)).rejects.toThrow(
        "already started",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      args.store.close();
    }
  });
  it("never resends a timed-out submission", async () => {
    const args = fixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("timeout"));
    try {
      await expect(submitTestnetDepositOnce(args, fetcher)).rejects.toThrow(
        "timeout",
      );
      expect(args.store.get(depositIntent(owner, 84532))?.status).toBe(
        "SUBMITTING",
      );
      await expect(submitTestnetDepositOnce(args, fetcher)).rejects.toThrow(
        "already started",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      args.store.close();
    }
  });
  it.each([8453, 1, 11155111])(
    "rejects chain %s without creating an intent or calling HTTP",
    async (chainId) => {
      const args = fixture();
      const fetcher = vi.fn<typeof fetch>();
      try {
        await expect(
          submitTestnetDepositOnce({ ...args, chainId }, fetcher),
        ).rejects.toThrow("only accepts");
        expect(fetcher).not.toHaveBeenCalled();
        expect(args.store.get(depositIntent(owner, 84532))).toBeUndefined();
      } finally {
        args.store.close();
      }
    },
  );
  it.each([Date.now() - 60000, Date.now() + 60000, NaN])(
    "rejects expired or invalid simulation time %s",
    async (simulationAt) => {
      const args = fixture();
      const fetcher = vi.fn<typeof fetch>();
      try {
        await expect(
          submitTestnetDepositOnce({ ...args, simulationAt }, fetcher),
        ).rejects.toThrow("less than 30 seconds");
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        args.store.close();
      }
    },
  );
  it("retains HTTP errors as evidence without automatically retrying", async () => {
    const args = fixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "insufficient_scope" }), {
          status: 403,
        }),
      );
    try {
      await expect(submitTestnetDepositOnce(args, fetcher)).rejects.toThrow(
        "HTTP 403",
      );
      expect(args.store.get(depositIntent(owner, 84532))?.response).toContain(
        "insufficient_scope",
      );
      await expect(submitTestnetDepositOnce(args, fetcher)).rejects.toThrow(
        "already started",
      );
    } finally {
      args.store.close();
    }
  });
});
