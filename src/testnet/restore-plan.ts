import { encodeFunctionData, type Abi, type Address } from "viem";
import { erc20Abi } from "viem";
import { aavePoolAbi, positionManagerAbi } from "../chain/abis.js";
import { json } from "../core/serialization.js";
import { BASE_SEPOLIA as config } from "./config.js";
import { requirePrincipal, type TestnetStep } from "./park-plan.js";

export const RESTORE_STEPS = [
  "withdraw-principal",
  "approve-restore",
  "restore-original-nft",
] as const;
export type RestoreId = (typeof RESTORE_STEPS)[number];
export type RestoreStep = Omit<TestnetStep, "id"> & { id: RestoreId };
export type RestoreContext = {
  owner: Address;
  tokenId: bigint;
  principal: bigint;
  lower: number;
  upper: number;
  tick: number;
  now: number;
  manualRehearsal: boolean;
};

export function buildRestoreStep(
  id: RestoreId,
  context: RestoreContext,
): RestoreStep {
  requirePrincipal(context.principal);
  if (!context.manualRehearsal)
    throw new Error(
      "Manual testnet rehearsal must be selected explicitly; no automatic RETURN decision is implied",
    );
  if (
    context.tokenId <= 0n ||
    !Number.isSafeInteger(context.now) ||
    !Number.isInteger(context.tick) ||
    !Number.isInteger(context.lower) ||
    !Number.isInteger(context.upper) ||
    context.lower % 10 !== 0 ||
    context.upper - context.lower !== 60
  )
    throw new Error("Invalid original NFT/range");
  // This bounded recovery path is WETH-only. In-range return needs a separately
  // guarded ratio swap; never force this call to run under different conditions.
  if (context.tick >= context.lower)
    throw new Error(
      "WETH-only restoration requires price below the original range",
    );
  let address: Address;
  let abi: Abi;
  let functionName: string;
  let args: readonly unknown[];
  if (id === "withdraw-principal") {
    address = config.aavePool;
    abi = aavePoolAbi;
    functionName = "withdraw";
    args = [config.weth, context.principal, context.owner];
  } else if (id === "approve-restore") {
    address = config.weth;
    abi = erc20Abi;
    functionName = "approve";
    args = [config.positionManager, context.principal];
  } else if (id === "restore-original-nft") {
    address = config.positionManager;
    abi = positionManagerAbi;
    functionName = "increaseLiquidity";
    args = [
      {
        tokenId: context.tokenId,
        amount0Desired: context.principal,
        amount1Desired: 0n,
        amount0Min: (context.principal * 997n) / 1000n,
        amount1Min: 0n,
        deadline: BigInt(context.now + 120),
      },
    ];
  } else throw new Error("Unsupported restoration step");
  return {
    id,
    request: {
      chainId: 84532,
      contractAddress: address,
      functionName,
      functionArgs: json(args),
      abi: JSON.stringify(abi),
      value: "0",
    },
    calldata: encodeFunctionData({ abi, functionName, args }),
  };
}
