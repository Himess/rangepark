import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Hex } from "viem";
import { BASE_SEPOLIA } from "../src/testnet/config.js";
import { TEST_DEPOSIT_WEI } from "../src/testnet/preflight.js";
import {
  gasStationAbi,
  TESTNET_GAS_STATION,
  verifyTestnetDepositTransaction,
} from "../src/testnet/receipt.js";
const owner = "0x1111111111111111111111111111111111111111" as const;
const relay = "0x2222222222222222222222222222222222222222" as const;
const packed = `0x${"00".repeat(85)}d0e30db0` as Hex;
const direct = {
  chainId: 84532,
  from: owner,
  to: BASE_SEPOLIA.weth,
  input: "0xd0e30db0" as Hex,
  value: TEST_DEPOSIT_WEI,
};
const wrapped = {
  chainId: 84532,
  from: relay,
  to: TESTNET_GAS_STATION,
  input: encodeFunctionData({
    abi: gasStationAbi,
    functionName: "execute",
    args: [owner, BASE_SEPOLIA.weth, TEST_DEPOSIT_WEI, packed],
  }),
  value: 0n,
};
describe("deposit receipt routing", () => {
  it("accepts an exact direct deposit", () => {
    expect(verifyTestnetDepositTransaction(direct, owner, false)).toBe(
      "DIRECT_EOA",
    );
  });
  it("decodes sponsored inner owner, target, amount and full calldata", () => {
    expect(verifyTestnetDepositTransaction(wrapped, owner, true)).toBe(
      "KEEPERHUB_EIP7702",
    );
  });
  it("does not confuse a relay transaction with an EOA transaction", () => {
    expect(() =>
      verifyTestnetDepositTransaction(wrapped, owner, false),
    ).toThrow();
  });
  it.each([8453, 1, 0])("rejects sponsored chain %s", (chainId) => {
    expect(() =>
      verifyTestnetDepositTransaction({ ...wrapped, chainId }, owner, true),
    ).toThrow();
  });
  it.each([
    [relay, BASE_SEPOLIA.weth, TEST_DEPOSIT_WEI, packed],
    [owner, BASE_SEPOLIA.aavePool, TEST_DEPOSIT_WEI, packed],
    [owner, BASE_SEPOLIA.weth, TEST_DEPOSIT_WEI + 1n, packed],
    [owner, BASE_SEPOLIA.weth, TEST_DEPOSIT_WEI, `${packed}00` as Hex],
    [owner, BASE_SEPOLIA.weth, TEST_DEPOSIT_WEI, `0x${"00".repeat(89)}` as Hex],
  ] as const)("rejects an altered inner call %s", (target, to, value, data) => {
    const input = encodeFunctionData({
      abi: gasStationAbi,
      functionName: "execute",
      args: [target, to, value, data],
    });
    expect(() =>
      verifyTestnetDepositTransaction({ ...wrapped, input }, owner, true),
    ).toThrow("mismatch");
  });
  it("rejects an unknown relay contract", () => {
    expect(() =>
      verifyTestnetDepositTransaction({ ...wrapped, to: relay }, owner, true),
    ).toThrow("Unsupported");
  });
});
