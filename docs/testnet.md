# Base Sepolia rehearsal

The next onchain milestone uses **Base Sepolia, chain 84532**, following the user's testnet-first instruction. No mainnet funding or execution is authorized by this milestone. The existing KeeperHub organization signer is reused; no seed phrase or private-key export is needed.

## Verified 8 September 2026

- KeeperHub's authenticated chain inventory lists Base Sepolia as enabled and a testnet.
- At block `46552145`, the organization signer held `1.998994441477637815` test ETH, zero WETH, zero Aave test USDC and no Uniswap V3 position NFTs. This is a snapshot, not a balance guarantee.
- All nine configured deployment addresses had bytecode. Aave WETH and USDC reserves were active, unfrozen and unpaused.
- Existing WETH/Aave-USDC pools at fees 500 and 3000 had liquidity. No new pool is required for initial testing.
- KeeperHub successfully simulated a zero-value WETH approval on chain 84532.
- KeeperHub successfully simulated `WETH.deposit()` with **0.001 test ETH**, the verified organization sender and `wouldRevert:false`. Estimated gas was 45,246. The API request uses ETH units; its simulation response reports the value as `1000000000000000` wei.
- The readiness and preflight commands remain non-broadcasting. A separate, explicitly invoked deposit executor subsequently completed the first real testnet transaction, documented below.

## First verified KeeperHub transaction

After the user approved Read + Write access and completed KeeperHub's two-factor verification, the dedicated local execution credential was used once for a **0.001 test ETH** WETH deposit.

- Chain: Base Sepolia `84532`.
- KeeperHub execution: `chodgtho78elwzx45xc28`.
- [Verified transaction](https://sepolia.basescan.org/tx/0x9bcc5690cf3c0261c6d1733d07efd7f32cc4731b999dfc81e80b0696c762e4ae).
- Block `46565630`, hash `0x38fc3c2c8e2a3c9d707743d0d6fd8fa4ee770cfa9cd7b7890de9e6bfc4156a1a`.
- WETH balance: zero → `1000000000000000` wei, exactly 0.001 WETH.
- Receipt: success; gas used 100,777, sponsored by KeeperHub.
- Evidence: `docs/evidence/testnet-deposit.json` and the ignored local SQLite execution record.

KeeperHub used its EIP-7702 gas-sponsorship route. The initial direct-EOA verifier stopped on the different outer sender. Reconciliation was extended to decode the verified gas-station contract's inner call; **the transaction was not resent**. Verification requires the expected owner, WETH target, exact value and deposit calldata, the known delegate code at the receipt block, a matching Deposit event and balance delta, and KeeperHub's chain-verified receipt. This is the initial funding step, not a completed Uniswap → Aave → Uniswap lifecycle.

The relay ABI and packed signature/nonce/deadline layout were checked against Sourcify exact-match source for the Base Sepolia [gas station](https://sourcify.dev/server/v2/contract/84532/0x5af5194b4b0909eb978e3cf1e25333852277f07d?fields=sources) and [delegate](https://sourcify.dev/server/v2/contract/84532/0x955d84139e7621bc571b117d8eb5d28a4a222c6f?fields=sources).

## Run

```sh
npm run testnet:check
npm run testnet:preflight
```

Both commands load the ignored local `.env`. They need the verified organization sender; the preflight additionally needs `KEEPERHUB_API_KEY`. Use read scope for simulations. Outputs are ignored local artifacts: `testnet-readiness.json` and `testnet-deposit-preflight.json`. The preflight is a fixed 0.001 ETH deposit simulation, not an arbitrary contract executor.

The separate `npm run testnet:deposit -- submit` command can broadcast the fixed deposit using `KEEPERHUB_TESTNET_WRITE_KEY`. It writes the exact request, baseline and stable idempotency key to SQLite before the HTTP request. A unique permanent wallet intent blocks a second principal allocation even after the server's 24-hour replay window. Following any interrupted or completed submission, use `npm run testnet:deposit -- reconcile`; it only reads the recorded execution and chain proof. Do not delete the execution database to retry. The initial deposit is already complete and must not be submitted again.

The testnet client rejects any RPC chain other than 84532 before contacting KeeperHub. The existing Base mainnet reader and plan types retain their separate chain 8453 guards. No global network toggle weakens those guards.

## Token distinction

The Aave Base Sepolia USDC reserve is `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`. Circle test USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e` is a different asset and was absent from Aave's reserve list. A Circle faucet balance must not be treated as an Aave supply balance.

## Next execution sequence

1. Completed: the user approved and created a separate Read + Write credential. The existing read-only key remains separate. Organization write access is not restricted to a single chain by KeeperHub; this executor only constructs chain-84532 requests.
2. Completed: the fixed 0.001 test ETH wrap was freshly simulated, submitted once and reconciled against both the chain and KeeperHub. No additional initial funding is needed.
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
