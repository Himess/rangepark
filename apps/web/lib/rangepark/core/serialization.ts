import { keccak256, stringToHex } from "viem";

export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash undefined or non-finite values");
}

export function hash(value: unknown) {
  return keccak256(stringToHex(canonical(value)));
}
