import { writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { json } from "../src/core/serialization.js";

process.loadEnvFile(".env");
const url = "https://rangepark.semihcvlk53.chatgpt.site/api/return-monitor";
const dispatch = process.env.RANGEPARK_SITES_BYPASS_TOKEN;
const token = process.env.RETURN_MONITOR_TOKEN;
if (!dispatch || !token) throw Error("Private site and monitor credentials required");
async function call(method: string, authorized = false) {
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(65000),
    headers: {
      "OAI-Sites-Authorization": `Bearer ${dispatch}`,
      ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}
async function main() {
  const unauthorized = await call("POST");
  assert.equal(unauthorized.status, 401);
  const before = await call("GET");
  assert.equal(before.status, 200);
  const pair = await Promise.all([call("POST", true), call("POST", true)]);
  const first = pair.find((result) => result.body.status !== "SKIPPED") ?? pair[0]!;
  const duplicate = pair.find((result) => result.body.status === "SKIPPED") ?? pair[1]!;
  const after = await call("GET");
  const proof = {
    mode: "DIRECT_HOSTED_READ_ONLY_VERIFICATION",
    checkedAt: new Date().toISOString(),
    url,
    unauthorized,
    before,
    first,
    duplicate,
    after,
    broadcasts: 0,
    scheduled: false,
  };
  await writeFile("artifacts/hosted-return-monitor-check.json", json(proof));
  console.log(
    json({
      unauthorized: unauthorized.status,
      first: first.status,
      firstStatus: first.body.status,
      firstErrors: first.body.errors,
      duplicate: duplicate.body.status,
      health: after.body.health,
      broadcasts: 0,
    }),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "OBSERVED");
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.status, "SKIPPED");
  assert.equal(after.body.health, "FRESH");
}
main().catch(() => {
  console.error("Hosted monitor verification incomplete; inspect the sanitized local evidence.");
  process.exitCode = 1;
});
