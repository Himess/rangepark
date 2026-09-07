import { z } from "zod";
import { response, sameOrigin } from "@/lib/api";
import { demoInput } from "@/lib/rangepark/demo/fixture";
import { decidePark } from "@/lib/rangepark/core/decision";
import { buildParkPlan } from "@/lib/rangepark/keeperhub/plan";
import { parseUnits } from "viem";
const amount = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/);
const schema = z.object({
  capital: amount,
  cost: amount,
  foregone: amount,
  apr: z.number().min(0).max(50),
  days: z.number().int().min(1).max(90),
  scenario: z.enum([
    "normal",
    "stale",
    "paused",
    "insufficient-history",
    "price-recovered",
  ]),
});
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const params = schema.parse(await request.json());
    const input = demoInput(Math.floor(Date.now() / 1000));
    input.position.principal1 = parseUnits(params.capital, 6);
    input.economics.roundTripCost = parseUnits(params.cost, 6);
    input.economics.foregoneLpFees = parseUnits(params.foregone, 6);
    input.economics.source =
      "User-adjustable simulation assumptions; not a live quote";
    input.policy.horizonSeconds = params.days * 86400;
    input.market.supplyAprRay =
      BigInt(Math.round(params.apr * 1e6)) * 10n ** 19n;
    if (params.scenario === "stale") input.now += 61;
    if (params.scenario === "paused") input.market.paused = true;
    if (params.scenario === "insufficient-history") input.observation = null;
    if (params.scenario === "price-recovered")
      input.position.currentTick = -200000;
    const decision = decidePark(input);
    const plan =
      decision.action === "PARK"
        ? buildParkPlan(input, input.position.owner)
        : null;
    return response({
      mode: "SYNTHETIC_SIMULATION",
      decision,
      plan,
      transactions: [],
      keeperhubSimulation: "NOT_RUN",
    });
  } catch {
    return response(
      { error: "Check the scenario amounts, APR and time horizon" },
      400,
    );
  }
}
