# Public testnet oracle preparation

KeeperHub completed one new Base Sepolia transaction on 10 September 2026 (Türkiye time): [increase the original pool's observation capacity](https://sepolia.basescan.org/tx/0xc2373badd18485bd1de0850cce205b14e40bd0d31bfdadfc8801699f9786fd05).

- Execution ID: `r0ijw93lzzs6yfyk5w5v7`; gas sponsored through the verified EIP-7702 route.
- Block: 46610756, hash `0x3496b48d5db4842927019e5a0407923d5b2cdfe10ab18b1c29ff8f78d198c51b`.
- Original WETH/Aave test USDC pool: `0x9d9203f8a29c600D567b240692DB569B77D1F4A9`, fee 500.
- Reserved observation capacity: 1 → 16. Active capacity: still 1.
- Original NFT 82083, range [-196230,-196170), liquidity 18309835226606, wallet balances and token allowances unchanged.

[Full receipt evidence](evidence/testnet-oracle-setup.json) includes the actual call, verified sender/target, capacity event and pinned before/after states. This is **preparation**, not automatic RETURN. The existing nine public lifecycle receipts remain a separate manual rehearsal.

## Why it is needed

The local contract tests exposed a one-entry oracle overwriting its history after a swap. The RETURN gate requires readable five-minute history and at least two active observations. Reserving 16 slots creates room for subsequent pool activity to populate history; this transaction alone does not satisfy that gate. The call and observation behavior follow the [Uniswap pool implementation](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol).

## Boundaries and commands

`npm run testnet:oracle` reads readiness. `npm run testnet:oracle -- reconcile` reads the recorded execution without sending again. The completed one-time write was `node --import tsx scripts/testnet-oracle-setup.ts submit --execute`. Do not rerun the write or delete its SQLite journal.

The executor only constructs chain 84532, zero-value `increaseObservationCardinalityNext(16)` on the pool matching the recorded owned NFT. It checks identity/freshness, simulates through KeeperHub, refreshes chain state, then commits its unique intent before the write. Unknown responses never trigger another submission. Receipt verification checks the sponsored call envelope and delegate, two confirmations, the exact event, canonical blocks and unchanged strategy capital.

The public sequencer tip was briefly ahead of the local clock. The first attempt stopped before journal claim or broadcast. Setup now pins reads two blocks behind the tip while retaining the strict 60-second age limit; it does not alter timestamps or loosen freshness.

## Next public rehearsal gates

The current NFT is RESTORED and remains below its original range. A new allocation record must identify a separately confirmed PARK of that same capital; the old supply/restoration cannot be replayed as a new cycle. No extra initial ETH wrap was performed. The wallet had zero Aave test USDC in the readiness read, so any controlled price-movement fixture needs an explicit test-token source and distinct accounting. Actual price/TWAP persistence, populated history and clearly sourced economics remain necessary before the RETURN runner can execute. Test fixtures must not be presented as market-derived profitability.

KeeperHub's [direct-execution reference](https://docs.keeperhub.com/api/direct-execution) documents simulation, stable idempotency keys and chain-verified receipt status. The existing local credentials remain excluded from source and the hosted runtime.

## Verified test-token source

`npm run testnet:faucet-check` now checks the Aave test USDC token owner, faucet permissions/limits/cooldown and a pinned read-only mint simulation. The token owner is Faucet `0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`. It was permissionless, limited to 1,000,000 whole tokens per mint and a 3,600-second recipient cooldown. A 100 test USDC mint simulation to the existing organization wallet succeeded; **no mint was submitted**. [Recorded read-only proof](evidence/testnet-faucet-preflight.json).

The token and faucet sources were retrieved from Sourcify for the exact deployed addresses. The Faucet writes its cooldown as `_userLastUpdated[token][to]`; the getter labels its arguments differently, so the reader follows the actual storage order and verifies the intended mint by simulation. Sources: [test token](https://sourcify.dev/server/v2/contract/84532/0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f?fields=abi,sources), [faucet](https://sourcify.dev/server/v2/contract/84532/0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc?fields=abi,sources).
