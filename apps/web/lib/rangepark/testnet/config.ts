import { getAddress } from "viem";

// Testnet deployment addresses are independent of Base mainnet.
// Sources: docs/testnet.md. No private key is needed for the KeeperHub signer.
export const BASE_SEPOLIA = {
  chainId: 84532 as const,
  rpc: "https://sepolia.base.org",
  factory: getAddress("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"),
  positionManager: getAddress("0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2"),
  swapRouter: getAddress("0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4"),
  quoter: getAddress("0xC5290058841028F1614F3A6F0F5816cAd0df5E27"),
  aavePool: getAddress("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"),
  aaveDataProvider: getAddress("0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b"),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  aaveUsdc: getAddress("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
  circleUsdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
};

export function requireTestnetChain(chainId: number) {
  if (chainId !== BASE_SEPOLIA.chainId)
    throw new Error("Testnet runner only accepts Base Sepolia (84532)");
}
