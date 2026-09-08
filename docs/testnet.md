# Base Sepolia rehearsal

The next onchain milestone uses **Base Sepolia, chain 84532**, following the user's testnet-first instruction. No mainnet funding or execution is authorized by this milestone. The existing KeeperHub organization signer is reused; no seed phrase or private-key export is needed.

## Verified 8 September 2026

- KeeperHub's authenticated chain inventory lists Base Sepolia as enabled and a testnet.
- At block `46552145`, the organization signer held `1.998994441477637815` test ETH, zero WETH, zero Aave test USDC and no Uniswap V3 position NFTs. This is a snapshot, not a balance guarantee.
- All nine configured deployment addresses had bytecode. Aave WETH and USDC reserves were active, unfrozen and unpaused.
- Existing WETH/Aave-USDC pools at fees 500 and 3000 had liquidity. No new pool is required for initial testing.
- KeeperHub successfully simulated a zero-value WETH approval on chain 84532.
- KeeperHub successfully simulated `WETH.deposit()` with **0.001 test ETH**, the verified organization sender and `wouldRevert:false`. Estimated gas was 45,246. The API request uses ETH units; its simulation response reports the value as `1000000000000000` wei.
- These are simulations and public reads. **No testnet transaction has been broadcast by these commands.**

## Run

```sh
npm run testnet:check
npm run testnet:preflight
```

Both commands load the ignored local `.env`. They need the verified organization sender; the preflight additionally needs `KEEPERHUB_API_KEY`. Use read scope for simulations. Outputs are ignored local artifacts: `testnet-readiness.json` and `testnet-deposit-preflight.json`. The preflight is a fixed 0.001 ETH deposit simulation, not an arbitrary contract executor.

The testnet client rejects any RPC chain other than 84532 before contacting KeeperHub. The existing Base mainnet reader and plan types retain their separate chain 8453 guards. No global network toggle weakens those guards.

## Token distinction

The Aave Base Sepolia USDC reserve is `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`. Circle test USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e` is a different asset and was absent from Aave's reserve list. A Circle faucet balance must not be treated as an Aave supply balance.

## Next execution sequence

1. Obtain the minimum required KeeperHub write authorization. The current key has `mcp:read` and cannot broadcast; it has not been escalated. An organization write key must not be described as testnet-restricted unless KeeperHub actually enforces that restriction.
2. Re-simulate the fixed 0.001 test ETH wrap immediately before submission. Persist the exact request and idempotency key before sending once; retain the execution ID, verify the receipt on chain 84532, and reconcile the WETH balance delta.
3. Create a small WETH-funded out-of-range Uniswap NFT using current ticks, exact approvals and a deadline. Read and retain its actual token ID and original range.
4. Observe the position and demonstrate decrease/collect, Aave supply, withdrawal, then restoration of the same NFT. Do not present manually staged testnet conditions as a profitable live strategy decision.
5. Label all public testnet receipts separately from the existing local Anvil evidence. Testnet completion does not by itself establish hackathon eligibility or authorize mainnet deployment.

The initial principal budget is 0.001 test ETH; network fees also use test ETH. Broad recurring execution, transfers to third-party wallets and mainnet transactions are outside this rehearsal.

## Deployment and API references

- [KeeperHub direct execution and simulation scopes](https://docs.keeperhub.com/api/direct-execution)
- [KeeperHub chain inventory](https://docs.keeperhub.com/api/chains)
- [Official Uniswap V3 Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
- [Aave Base Sepolia address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol)

Deployment constants live in `src/testnet/config.ts`; readiness reads confirm actual code, market flags and pool state rather than assuming the references guarantee availability.
