import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { aavePoolAbi, positionManagerAbi } from "../chain/abis.js";
import { json } from "../core/serialization.js";
import { BASE_SEPOLIA as config } from "./config.js";
import { TEST_DEPOSIT_WEI } from "./preflight.js";

export const PARK_STEPS = [
  "approve-position",
  "mint",
  "release",
  "approve-aave",
  "supply",
] as const;
export type ParkStepId = (typeof PARK_STEPS)[number];
export type TestnetStep = {
  id: ParkStepId;
  calldata: Hex;
  request: {
    chainId: 84532;
    contractAddress: Address;
    functionName: string;
    functionArgs: string;
    abi: string;
    value: "0";
  };
};
function step(
  id: ParkStepId,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): TestnetStep {
  return {
    id,
    calldata: encodeFunctionData({ abi, functionName, args }),
    request: {
      chainId: 84532,
      contractAddress: address,
      functionName,
      functionArgs: json(args),
      abi: JSON.stringify(abi),
      value: "0",
    },
  };
}
export function requirePrincipal(amount: bigint) {
  if (amount <= 0n || amount > TEST_DEPOSIT_WEI)
    throw new Error(
      "Rehearsal amount must be within the original 0.001 WETH allocation",
    );
}
export function buildPositionApproval() {
  return step("approve-position", config.weth, erc20Abi, "approve", [
    config.positionManager,
    TEST_DEPOSIT_WEI,
  ]);
}
export function buildTestnetMint(owner: Address, tick: number, now: number) {
  if (!Number.isInteger(tick) || tick < -887000 || tick > 886000)
    throw new Error("Unsupported testnet tick");
  const lower = Math.ceil(tick / 10) * 10 + 20;
  const params = {
    token0: config.weth,
    token1: config.aaveUsdc,
    fee: 500,
    tickLower: lower,
    tickUpper: lower + 60,
    amount0Desired: TEST_DEPOSIT_WEI,
    amount1Desired: 0n,
    amount0Min: (TEST_DEPOSIT_WEI * 997n) / 1000n,
    amount1Min: 0n,
    recipient: owner,
    deadline: BigInt(now + 120),
  };
  return {
    step: step("mint", config.positionManager, positionManagerAbi, "mint", [
      params,
    ]),
    params,
  };
}
export function buildTestnetRelease(
  owner: Address,
  tokenId: bigint,
  liquidity: bigint,
  amount0: bigint,
  now: number,
) {
  requirePrincipal(amount0);
  if (tokenId <= 0n || liquidity <= 0n)
    throw new Error("Owned, non-empty testnet NFT required");
  const decrease = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min: (amount0 * 997n) / 1000n,
        amount1Min: 0n,
        deadline: BigInt(now + 120),
      },
    ],
  });
  const collect = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: owner,
        amount0Max: (1n << 128n) - 1n,
        amount1Max: (1n << 128n) - 1n,
      },
    ],
  });
  return step(
    "release",
    config.positionManager,
    positionManagerAbi,
    "multicall",
    [[decrease, collect]],
  );
}
export function buildAaveApproval(amount: bigint) {
  requirePrincipal(amount);
  return step("approve-aave", config.weth, erc20Abi, "approve", [
    config.aavePool,
    amount,
  ]);
}
export function buildTestnetSupply(owner: Address, amount: bigint) {
  requirePrincipal(amount);
  return step("supply", config.aavePool, aavePoolAbi, "supply", [
    config.weth,
    amount,
    owner,
    0,
  ]);
}

export function validateParkStep(candidate: TestnetStep, owner: Address) {
  const { id, calldata, request } = candidate;
  if (request.chainId !== 84532 || request.value !== "0")
    throw new Error("Only zero-native-value Base Sepolia park calls allowed");
  if (id === "approve-position" || id === "approve-aave") {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    if (
      decoded.functionName !== "approve" ||
      request.functionName !== "approve" ||
      !isAddressEqual(request.contractAddress, config.weth)
    )
      throw new Error("Approval call required");
    const [spender, amount] = decoded.args;
    requirePrincipal(amount);
    if (
      !isAddressEqual(
        spender,
        id === "approve-position" ? config.positionManager : config.aavePool,
      )
    )
      throw new Error("Approval spender outside rehearsal");
    if (id === "approve-position" && amount !== TEST_DEPOSIT_WEI)
      throw new Error("Initial approval budget mismatch");
  } else if (id === "mint") {
    const decoded = decodeFunctionData({
      abi: positionManagerAbi,
      data: calldata,
    });
    if (
      decoded.functionName !== "mint" ||
      request.functionName !== "mint" ||
      !isAddressEqual(request.contractAddress, config.positionManager)
    )
      throw new Error("Mint call required");
    const p = decoded.args[0];
    if (
      !isAddressEqual(p.recipient, owner) ||
      !isAddressEqual(p.token0, config.weth) ||
      !isAddressEqual(p.token1, config.aaveUsdc) ||
      p.fee !== 500 ||
      p.amount0Desired !== TEST_DEPOSIT_WEI ||
      p.amount1Desired !== 0n ||
      p.amount0Min < (TEST_DEPOSIT_WEI * 997n) / 1000n ||
      p.amount0Min > TEST_DEPOSIT_WEI ||
      p.amount1Min !== 0n ||
      p.tickLower % 10 !== 0 ||
      p.tickUpper - p.tickLower !== 60
    )
      throw new Error("Mint outside fixed rehearsal bounds");
  } else if (id === "release") {
    const decoded = decodeFunctionData({
      abi: positionManagerAbi,
      data: calldata,
    });
    if (
      decoded.functionName !== "multicall" ||
      request.functionName !== "multicall" ||
      !isAddressEqual(request.contractAddress, config.positionManager) ||
      decoded.args[0].length !== 2
    )
      throw new Error("Atomic release required");
    const decrease = decodeFunctionData({
      abi: positionManagerAbi,
      data: decoded.args[0][0]!,
    });
    const collect = decodeFunctionData({
      abi: positionManagerAbi,
      data: decoded.args[0][1]!,
    });
    if (
      decrease.functionName !== "decreaseLiquidity" ||
      collect.functionName !== "collect"
    )
      throw new Error("Release order mismatch");
    if (
      decrease.args[0].tokenId !== collect.args[0].tokenId ||
      decrease.args[0].liquidity <= 0n ||
      !isAddressEqual(collect.args[0].recipient, owner)
    )
      throw new Error("Release owner/position mismatch");
    requirePrincipal(decrease.args[0].amount0Min);
  } else if (id === "supply") {
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: calldata });
    if (
      decoded.functionName !== "supply" ||
      request.functionName !== "supply" ||
      !isAddressEqual(request.contractAddress, config.aavePool)
    )
      throw new Error("Aave supply required");
    const [asset, amount, recipient, referral] = decoded.args;
    requirePrincipal(amount);
    if (
      !isAddressEqual(asset, config.weth) ||
      !isAddressEqual(recipient, owner) ||
      referral !== 0
    )
      throw new Error("Supply asset/beneficiary mismatch");
  } else throw new Error("Unknown rehearsal step");
}
