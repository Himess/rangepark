# Guarded testnet RETURN runner

Implemented and tested on 9 September 2026, with controlled recovery verified on 10 September (Türkiye time). The six-stage runner uses actual Uniswap V3 and Aave V3 contracts on a **local Base Sepolia fork**. Public KeeperHub execution of this automatic path is still pending. The nine existing public receipts prove the separate manual rehearsal.

## Execution boundaries

Only Base Sepolia (84532), the recorded owner and NFT, WETH/Aave test USDC, fee 500 and up to 0.001 test WETH principal are accepted. A confirmed PARK allocation and a passing [RETURN policy](return-policy.md) are required. The latest public allocation is the [new re-PARK cycle](repark.md); it remains on HOLD until oracle history, prices, persistence, cooldown and economics pass.

The ordered steps are withdrawal, exact swap approval, ratio swap, exact WETH approval, exact USDC approval and increase of the original NFT. Every stage uses a fresh pinned snapshot. Simulation runs before submission, followed by another freshness check. Known ABIs, recipient, target, chain and attributable principal are reconstructed and validated independently of the plan hash.

The swap amount is solved using up to 14 same-block Quoter calls and the quoted post-swap price. This accounts for the swap's price impact on the required position ratio. A nonzero minimum output, an inner-range square-root price limit and a short deadline bound the swap. Reentry has nonzero minimum amounts for both tokens and preserves the NFT ID and original range. Price movement may still leave a remainder; the journal tracks it explicitly.

Only confirmed withdrawal and swap balance deltas become spendable strategy capital. Existing wallet balances are not silently allocated. Receipt checks cover actual call data, sender, target, chain, events, pinned before/after balances, the unchanged NFT and two confirmations. The verifier supports KeeperHub's previously observed sponsored EIP-7702 envelope, but this new runner's local test exercises direct transactions through an emulated transport.

SQLite freezes each phase and claims every step before the write request. A timeout cannot trigger a new submission. Reconciliation reads the existing execution and receipt; it never resends a call. Pauses remain active after reconciliation.

## Commands

```sh
npm run testnet:return-run
npm run testnet:return-run -- reconcile
npm run testnet:return-run -- pause
```

The default status command reads chain state and updates local observation history without broadcasting. Reconcile requires an existing run and only reads already submitted steps. Pause changes the local journal. All use the ignored local environment and journals under `artifacts/`.

The broadcasting command is `node --import tsx scripts/testnet-return-run.ts run --execute`; use Node directly to preserve the explicit flag on this Windows host. It requires the local testnet write credential and every policy gate. It has **not** been invoked on the public network for this milestone. Never delete journals or bypass a RESTORED/PAUSED state to replay a cycle.

## Reproducible local contract proof

Start Anvil on port 8546 with chain ID 84532, forking Base Sepolia at block 46566708, then run `npm run test:fork-return`. The harness rejects non-loopback endpoints and non-Anvil clients, takes a snapshot and reverts it on completion.

The fixture locally impersonates accounts, clears the owner's delegation code for direct transactions, supplies test funding, expands oracle history, moves price and advances time. Fee/cost inputs are synthetic. Its KeeperHub-shaped transport sends transactions only to localhost; it does not contact KeeperHub or create public execution IDs.

[Committed proof](evidence/testnet-return-fork.json) records six successful local contract transactions, five minutes of eligible observations and final state:

| Result | Verified value |
| --- | --- |
| Original NFT | 82083 |
| Original range | [-196230, -196170) |
| Final tick | -196205 |
| Final liquidity | 18317553864450 |
| Unallocated WETH | 30 wei |
| Unallocated Aave test USDC | 153 atomic units (0.000153 test USDC) |

The harness also requires the residual's WETH equivalent to be below 1% of the supplied principal in this controlled scenario. This is capital allocation evidence, not a yield or profitability claim. Local transaction hashes have no public explorer links.

The first contract run exposed a one-observation oracle: a swap overwrote the history required for the next TWAP check. The policy now requires both current and next oracle capacity to be at least two before withdrawal. The local fixture uses 16. Actual five-minute history must still be readable; capacity alone is insufficient.

## Controlled recovery

`node --import tsx scripts/testnet-return-run.ts resume --execute` explicitly resumes a PAUSED run and executes its remaining steps. First use `reconcile` if any submitted step is unresolved. Resume itself rechecks every confirmed receipt against KeeperHub and the chain, validates current NFT identity, price/TWAP, debt, capital and exact confirmed allowances, then atomically records its evidence and replacement phase. The normal executor still simulates and guards each remaining call.

Confirmed calls and original decision evidence are preserved. The swap retains an already approved input amount and obtains a fresh quote; it holds if that fixed amount no longer fits the price ratio or limits. LP reentry uses the exact attributed balances and refreshed nonzero minima/deadline. An unsent withdrawal requires fresh full eligibility and economics. Concurrent journal changes invalidate recovery. No confirmed step or unknown submission is reset to READY.

Pending KeeperHub receipts are checked up to five times without another write. RETURN and re-PARK share the same status parser. Polls honor `X-Poll-Interval-Hint` in seconds, including a zero terminal hint and previously unknown status names. Positive hints keep an execution pending even if its status label says completed. Missing/malformed hints leave unknown states pending; completed results still require verified Base Sepolia receipts. These semantics follow the [KeeperHub Direct Execution API](https://docs.keeperhub.com/api/direct-execution).

The local wait budget is 60 seconds in total, in addition to bounded network reads. If the next recommended delay exceeds the remaining budget, the client stops instead of polling early. Verification mismatches and contradictory terminal receipts fail immediately. An unresolved RETURN run pauses. A write response lost without an execution ID cannot yet be recovered automatically. Do not delete its journal or resubmit it.

Run `node --import tsx scripts/fork-testnet-return.ts --recovery` on the same local fork configuration to reproduce [the recovery proof](evidence/testnet-return-recovery-fork.json). Two 90-second time advances deliberately expire the phase after swap approval and after both LP approvals. Both resumes reverify receipts; the entire lifecycle still contains exactly six strategy transactions. SQLite reopen tests separately verify durable recovery across process restarts.

## Remaining limitations

- No continuous scheduler or live LP-fee/execution-cost estimator. Initial economics must be current before withdrawal; subsequent steps enforce price/account/capital guards rather than forecasting profitability again.
- The explicit resume path remains conservative: insufficient balance, changed allowances, a reorg, unavailable receipts or an approved swap amount that no longer fits the ratio keeps it paused. Unknown submissions without an execution ID need further investigation. Capital may remain in the wallet after a partial return; no emergency withdrawal or automatic allowance repair is implemented.
- One original-NFT re-PARK cycle is implemented, with isolated deposited principal. Arbitrary repeated cycles and a full strategy share ledger across unrelated Aave deposits remain unfinished.
- Public automatic KeeperHub swap/reentry, oracle readiness and event eligibility remain to be verified. No mainnet execution is authorized or claimed.
