import assert from "node:assert/strict";
const origin = "http://localhost:3000";
const send = (path, body, headers = {}) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
assert.equal((await fetch(origin)).status, 200);
for (const [scenario, action] of [
  ["normal", "PARK"],
  ["stale", "HOLD"],
  ["paused", "HOLD"],
  ["insufficient-history", "HOLD"],
  ["price-recovered", "HOLD"],
]) {
  const response = await send("/api/scenario", {
    capital: "10000",
    cost: "2",
    foregone: "1",
    apr: 5,
    days: 7,
    scenario,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "SYNTHETIC_SIMULATION");
  assert.equal(body.decision.action, action);
  assert.equal(body.plan === null, action === "HOLD");
  assert.deepEqual(body.transactions, []);
  console.log(`${scenario}: ${action}`);
}
assert.equal((await send("/api/scenario", { capital: "NaN" })).status, 400);
assert.equal(
  (await send("/api/positions", { tokenId: "not-an-nft" })).status,
  400,
);
const saved = await fetch(`${origin}/api/positions?id=5950133`);
assert.equal(saved.status, 200);
const body = await saved.json();
assert.equal(body.mode, "LIVE_READ_ONLY");
assert.equal(body.position.tokenId, "5950133");
assert.equal(body.aaveMarkets.length, 2);
console.log(
  "HTTP routes, five policy branches, invalid input, and saved D1 snapshot verified.",
);
