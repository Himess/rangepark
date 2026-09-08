import {
  decodeFunctionData,
  isAddressEqual,
  parseAbi,
  slice,
  type Address,
  type Hex,
} from "viem";
import { BASE_SEPOLIA, requireTestnetChain } from "./config.js";
import { TEST_DEPOSIT_WEI } from "./preflight.js";

// Sourcify exact-match deployments, chain 84532; see docs/testnet.md.
export const TESTNET_GAS_STATION =
  "0x5af5194b4b0909eb978e3cf1e25333852277f07d" as const;
export const TESTNET_GAS_DELEGATE =
  "0x955d84139e7621bc571b117d8eb5d28a4a222c6f" as const;
export const gasStationAbi = parseAbi([
  "function execute(address target,address to,uint256 ethAmount,bytes data)",
]);

export function verifyTestnetDepositTransaction(
  tx: {
    chainId?: number;
    from: Address;
    to: Address | null;
    input: Hex;
    value: bigint;
  },
  owner: Address,
  sponsored: boolean,
) {
  requireTestnetChain(tx.chainId ?? 0);
  if (!tx.to) throw new Error("Deposit target missing");
  if (!sponsored) {
    if (
      !isAddressEqual(tx.from, owner) ||
      !isAddressEqual(tx.to, BASE_SEPOLIA.weth) ||
      tx.input !== "0xd0e30db0" ||
      tx.value !== TEST_DEPOSIT_WEI
    )
      throw new Error("Direct deposit sender/target/calldata/value mismatch");
    return "DIRECT_EOA";
  }
  if (!isAddressEqual(tx.to, TESTNET_GAS_STATION) || tx.value !== 0n)
    throw new Error("Unsupported sponsored deposit route");
  const decoded = decodeFunctionData({ abi: gasStationAbi, data: tx.input });
  const [target, to, value, data] = decoded.args;
  // TKGasDelegate.execute packs signature(65), nonce(16), deadline(4), calldata.
  if (
    !isAddressEqual(target, owner) ||
    !isAddressEqual(to, BASE_SEPOLIA.weth) ||
    value !== TEST_DEPOSIT_WEI ||
    data.length !== 2 + (85 + 4) * 2 ||
    slice(data, 85) !== "0xd0e30db0"
  )
    throw new Error(
      "Sponsored deposit inner sender/target/calldata/value mismatch",
    );
  return "KEEPERHUB_EIP7702";
}
