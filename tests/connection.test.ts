import { describe, expect, it, vi } from "vitest";
import { BASE } from "../src/config/base.js";
import { KeeperHubClient } from "../src/keeperhub/client.js";
import { probeConnection } from "../src/keeperhub/connection.js";

const owner = "0x1111111111111111111111111111111111111111";
describe("authenticated connection probe", () => {
  it("only simulates, verifies the signer, and never grants an allowance", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_, options) => {
        const request = JSON.parse(options!.body as string);
        expect(request.simulate).toBe(true);
        expect(request.value).toBe("0");
        if (request.functionName === "balanceOf")
          return new Response(JSON.stringify({ result: "0" }));
        if (request.functionName === "approve")
          expect(JSON.parse(request.functionArgs)).toEqual([
            BASE.aavePool,
            "0",
          ]);
        return new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: owner,
            to: request.contractAddress,
            value: "0",
            gasEstimate: "45000",
          }),
        );
      });
    const result = await probeConnection(
      new KeeperHubClient("kh_test", fetcher),
      owner,
    );
    expect(result.success).toBe(true);
    expect(result.transactions).toEqual([]);
    expect(result.valueMovementProven).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops on invalid credentials and retains no reflected secret", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "kh_secret_should_not_be_saved",
          code: "insufficient_scope",
        }),
        { status: 403 },
      ),
    );
    const result = await probeConnection(
      new KeeperHubClient("kh_test", fetcher),
      owner,
    );
    expect(result.success).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("kh_secret");
    expect(result.checks[0]?.code).toBe("insufficient_scope");
  });
  it("refuses a simulation from another organization", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0" })))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            status: "simulated",
            wouldRevert: false,
            from: BASE.factory,
            to: BASE.weth,
            value: "0",
            gasEstimate: "1000",
          }),
        ),
      );
    await expect(
      probeConnection(new KeeperHubClient("kh_test", fetcher), owner),
    ).rejects.toThrow("mismatch");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a direct read result for a write simulation receipt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ result: "0" })),
      );
    await expect(
      probeConnection(new KeeperHubClient("kh_test", fetcher), owner),
    ).rejects.toThrow("Unexpected KeeperHub simulation response");
  });
});
