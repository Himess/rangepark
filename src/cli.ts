import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { formatUnits, isAddressEqual } from "viem";
import { BASE } from "./config/base.js";
import { baseClient, readBlock, verifyBlock } from "./chain/client.js";
import { discoverPositions, readPosition } from "./chain/uniswap.js";
import { readAaveMarket } from "./chain/aave.js";
import { decidePark, defaultPolicy } from "./core/decision.js";
import { observePosition, rangeSide } from "./core/range.js";
import { json } from "./core/serialization.js";
import { demoInput } from "./demo/fixture.js";
import { buildParkPlan, buildReleaseCall } from "./keeperhub/plan.js";
import { KeeperHubClient, KeeperHubError } from "./keeperhub/client.js";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

async function save(name: string, value: unknown) {
  await mkdir("artifacts", { recursive: true });
  const path = resolve("artifacts", name);
  await writeFile(path, `${json(value)}\n`, "utf8");
  return path;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "demo") {
    const input = demoInput();
    const decision = decidePark(input);
    const expensive = decidePark({
      ...input,
      economics: { ...input.economics, roundTripCost: 100000000n },
    });
    const stale = decidePark({ ...input, now: input.now + 61 });
    const paused = decidePark({
      ...input,
      market: { ...input.market, paused: true },
    });
    const plan = buildParkPlan(input, input.position.owner);
    const path = await save("demo.json", {
      mode: "SYNTHETIC_OFFLINE",
      input,
      decision,
      plan,
      scenarios: { expensive, stale, paused },
      transactions: [],
      keeperhubSimulation: "NOT_RUN",
    });
    console.log(
      json({
        mode: "SYNTHETIC_OFFLINE",
        action: decision.action,
        capital: `${formatUnits(input.position.principal1, 6)} USDC`,
        fixedSupply: `${formatUnits(decision.supplyAmount, 6)} USDC`,
        estimatedYield: `${formatUnits(decision.expectedYield, 6)} USDC / 7 days`,
        requiredBenefit: `${formatUnits(decision.requiredBenefit, 6)} USDC`,
        refusalScenarios: {
          expensive: expensive.reasons,
          stale: stale.reasons,
          paused: paused.reasons,
        },
        planHash: plan.planHash,
        steps: plan.steps.map((s) => s.id),
        artifact: path,
        next: "Inspect a real NFT with npm run inspect -- <tokenId>. Demo is not transaction evidence.",
      }),
    );
    return;
  }
  if (!["inspect", "observe", "discover", "preflight"].includes(command ?? "")) {
    throw new Error(
      "Usage: npm run demo | npm run discover -- [1-64] | npm run inspect -- <tokenId> | npm run observe -- <tokenId> | npm run preflight -- <tokenId>",
    );
  }
  if (command !== "discover" && !/^[0-9]+$/.test(argument ?? ""))
    throw new Error("Provide a numeric NFT token ID");
  const client = baseClient();
  const block = await readBlock(client);
  if (command === "discover") {
    const result = await discoverPositions(
      client,
      block,
      argument ? Number(argument) : 16,
    );
    await verifyBlock(client, block);
    console.log(json({ mode: "LIVE_READ_ONLY", block, ...result }));
    return;
  }
  const position = await readPosition(client, BigInt(argument!), block);
  const supported =
    isAddressEqual(position.token0.address, BASE.weth) &&
    isAddressEqual(position.token1.address, BASE.usdc);
  const side = rangeSide(
    position.currentTick,
    position.tickLower,
    position.tickUpper,
  );
  const asset = side === "BELOW" ? position.token0 : position.token1;
  const aaveMarkets = supported
    ? await Promise.all([
        readAaveMarket(client, position.token0, block),
        readAaveMarket(client, position.token1, block),
      ])
    : [];
  const market =
    aaveMarkets.find((m) => isAddressEqual(m.asset.address, asset.address)) ??
    null;
  await verifyBlock(client, block);
  if (command === "preflight") {
    if (!supported)
      throw new Error("Only Base WETH/USDC positions are supported");
    const key = process.env.KEEPERHUB_API_KEY;
    if (!key)
      throw new Error(
        "Set KEEPERHUB_API_KEY in local .env for authenticated simulation. No transaction was sent.",
      );
    const step = buildReleaseCall(
      position,
      block.timestamp + defaultPolicy.planTtlSeconds,
      defaultPolicy.maxSlippageBps,
    );
    const simulation = await new KeeperHubClient(key).simulate(
      step,
      position.owner,
    );
    const path = await save(`preflight-${position.tokenId}.json`, {
      mode: "KEEPERHUB_SIMULATION_ONLY",
      position,
      step,
      simulation,
      policyApproval: "NOT_EVALUATED",
      fullWorkflowSimulation: false,
      transactions: [],
    });
    console.log(
      json({ mode: "KEEPERHUB_SIMULATION_ONLY", simulation, artifact: path }),
    );
    return;
  }
  let observation = observePosition(
    position,
    null,
    defaultPolicy.maxObservationGapSeconds,
  );
  let decision: unknown = "NOT_EVALUATED";
  let plan: unknown = null;
  let reason = "A single snapshot does not establish persistence. Live cost and opportunity-cost assumptions are also required.";
  if (command === "observe") {
    const { Journal } = await import("./state/journal.js");
    const journal = new Journal(resolve("artifacts", "rangepark.sqlite"));
    try { observation = journal.recordObservation(position, defaultPolicy.maxObservationGapSeconds); }
    finally { journal.close(); }
    reason = "Observation saved durably. Provide a current economic quote to evaluate the live policy.";
    if (process.env.RANGEPARK_ECONOMICS_FILE && supported && market) {
      const quote = z.object({
        chainId: z.literal(8453), asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        roundTripCost: z.string().regex(/^[0-9]+$/), foregoneLpFees: z.string().regex(/^[0-9]+$/),
        source: z.string().min(1), quotedAt: z.number().int(), expiresAt: z.number().int(),
        lastActionAt: z.number().int().nullable(),
      }).strict().parse(JSON.parse(await readFile(process.env.RANGEPARK_ECONOMICS_FILE,"utf8")));
      const now = Math.floor(Date.now()/1000);
      if (!isAddressEqual(quote.asset as `0x${string}`,asset.address) || quote.quotedAt>now || quote.expiresAt<=now || quote.expiresAt-quote.quotedAt>120 || (quote.lastActionAt!==null&&quote.lastActionAt>now)) throw new Error("Economic quote is expired, future-dated, or for another asset");
      const input = {position,market,observation,policy:defaultPolicy,economics:{roundTripCost:BigInt(quote.roundTripCost),foregoneLpFees:BigInt(quote.foregoneLpFees),source:quote.source},now,lastActionAt:quote.lastActionAt};
      const receipt=decidePark(input);decision=receipt;
      if(receipt.action==='PARK')plan=buildParkPlan(input,position.owner);
      reason="Live policy evaluated using the supplied economic quote. No execution was authorized or submitted.";
    }
  }
  const path = await save(`position-${position.tokenId}.json`, {
    mode: "LIVE_READ_ONLY",
    position,
    aaveMarkets,
    observation,
    decision, plan, reason,
  });
  console.log(
    json({
      mode: "LIVE_READ_ONLY",
      tokenId: position.tokenId,
      owner: position.owner,
      pair: `${position.token0.symbol}/${position.token1.symbol}`,
      supported,
      range: [position.tickLower, position.tickUpper],
      currentTick: position.currentTick,
      side,
      twapTick: position.twapTick,
      principal: [
        formatUnits(position.principal0, position.token0.decimals),
        formatUnits(position.principal1, position.token1.decimals),
      ],
      aaveMarkets: aaveMarkets.map((m) => ({
        asset: m.asset.symbol,
        supplyAprPercent: Number(m.supplyAprRay) / 1e25,
        availableLiquidity: formatUnits(m.availableLiquidity, m.asset.decimals),
        supplyCapRemaining:
          m.supplyCapRemaining === null
            ? "UNCAPPED"
            : formatUnits(m.supplyCapRemaining, m.asset.decimals),
        active: m.active,
        frozen: m.frozen,
        paused: m.paused,
      })),
      block,
      observation, decision, reason,
      artifact: path,
    }),
  );
}

main().catch((error) => {
  // Do not dump transport errors: RPC URLs may contain credentials.
  if (error instanceof KeeperHubError)
    console.error(
      json({
        error: error.message,
        status: error.status,
        details: error.details,
      }),
    );
  else
    console.error(
      error instanceof Error
        ? error.message.split("\n")[0]
        : "RangePark failed",
    );
  process.exitCode = 1;
});
