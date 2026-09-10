import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAddress, isAddressEqual, parseAbi } from "viem";
import { json } from "../src/core/serialization.js";
import { BASE_SEPOLIA as config, requireTestnetChain } from "../src/testnet/config.js";
import { testnetReturnClient } from "../src/testnet/return-reader.js";

// Verified TestnetERC20 owner and its Sourcify-matched Faucet implementation.
// This command has no signing, KeeperHub write or transaction submission path.
const faucet = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc" as const;
const abi = parseAbi([
  "function isPermissioned() view returns (bool)",
  "function getTokenConfig(address token) view returns (uint256 timelockPerMint,uint256 maxAmountPerMint)",
  "function getUserLastUpdated(address user,address token) view returns (uint256)",
  "function mint(address token,address to,uint256 amount) returns (uint256)",
]);
async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const owner = process.env.KEEPERHUB_EXPECTED_SENDER;
  if (!owner || !isAddress(owner)) throw new Error("Verified KeeperHub owner required");
  const client = testnetReturnClient();
  requireTestnetChain(await client.getChainId());
  const block = await client.getBlock();
  const [tokenOwner, permissioned, tokenConfig, lastMint] = await Promise.all([
    client.readContract({
      address: config.aaveUsdc,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
      blockNumber: block.number,
    }),
    client.readContract({
      address: faucet,
      abi,
      functionName: "isPermissioned",
      blockNumber: block.number,
    }),
    client.readContract({
      address: faucet,
      abi,
      functionName: "getTokenConfig",
      args: [config.aaveUsdc],
      blockNumber: block.number,
    }),
    // The verified implementation writes _userLastUpdated[token][to]. Its getter
    // parameter labels are reversed relative to the storage usage; follow storage.
    client.readContract({
      address: faucet,
      abi,
      functionName: "getUserLastUpdated",
      args: [config.aaveUsdc, owner],
      blockNumber: block.number,
    }),
  ]);
  if (!isAddressEqual(tokenOwner, faucet)) throw new Error("Aave test USDC ownership changed");
  const amount = 100n * 10n ** 6n;
  let mintSimulation: { success: boolean; amount?: bigint; reason?: string };
  if (
    permissioned ||
    tokenConfig[1] * 10n ** 6n < amount ||
    lastMint + tokenConfig[0] > block.timestamp
  )
    mintSimulation = {
      success: false,
      reason: "Faucet permission, amount limit or cooldown blocks the rehearsal",
    };
  else {
    const simulation = await client.simulateContract({
      address: faucet,
      abi,
      functionName: "mint",
      args: [config.aaveUsdc, owner, amount],
      account: owner,
      blockNumber: block.number,
    });
    if (simulation.result !== amount) throw new Error("Unexpected faucet simulated amount");
    mintSimulation = { success: true, amount };
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
    throw new Error("Faucet source block changed");
  const report = {
    mode: "READ_ONLY_FAUCET_PREFLIGHT",
    chainId: 84532,
    owner,
    token: config.aaveUsdc,
    faucet,
    block: { number: block.number, hash: block.hash },
    permissioned,
    timelockPerMint: tokenConfig[0],
    maxWholeTokensPerMint: tokenConfig[1],
    lastMint,
    mintSimulation,
    transactions: [],
  };
  await writeFile("artifacts/testnet-faucet-preflight.json", json(report));
  console.log(json(report));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message.split("\n")[0] : "Faucet read failed");
  process.exitCode = 1;
});
