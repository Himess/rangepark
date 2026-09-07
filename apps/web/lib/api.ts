export function response(value: unknown, status = 200) {
  return new Response(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new Error("Request origin not allowed");
}
export function revive<T>(text: string): T {
  const keys = new Set([
    "number",
    "tokenId",
    "sqrtPriceX96",
    "liquidity",
    "principal0",
    "principal1",
    "checkpointOwed0",
    "checkpointOwed1",
    "supplyAprRay",
    "availableLiquidity",
    "supplyCapRemaining",
    "lastBlock",
  ]);
  return JSON.parse(text, (key, value) =>
    keys.has(key) && typeof value === "string" && /^[0-9]+$/.test(value)
      ? BigInt(value)
      : value,
  ) as T;
}
