# Guarded Base Sepolia RETURN decision

Implemented 9 September 2026. This module produces **HOLD or a review-only RETURN decision**, an exact principal withdrawal draft and an optional read-only KeeperHub simulation. It has no broadcast method. A successful decision is not a wallet signature, an execution authorization or evidence that the post-withdrawal swap has been tested publicly.

## Eligibility

The confirmed PARK supply transaction identifies the cycle. The journal fixes owner, NFT, original pool/pair/fee/range, WETH principal and PARK timestamp. A completed manual restoration marks that cycle RESTORED; any partially started restoration marks it RECOVERY. Both states hold. The original NFT must still be owned and empty, and its identity must match the recorded cycle.

The initial scope remains Base Sepolia, fee-500 WETH/Aave test USDC and at most 0.001 test WETH of principal. Mainnet inputs and Circle test USDC fail the gate. New cycles require a separate confirmed allocation record; this command cannot re-park the restored NFT or create one.

Default conditions:

| Gate | Requirement |
| --- | --- |
| Price | Spot and five-minute TWAP both in `[original lower + 10, original upper - 10)` |
| Persistence | Five minutes of eligible sampled blocks, with no gap over 120 seconds |
| Freshness | Snapshot less than 60 seconds old; future timestamps hold |
| Price disagreement | Spot/TWAP difference at most 100 ticks, in addition to the buffered range |
| Cooldown | At least one hour after the recorded PARK |
| Withdrawal | Active, unpaused Aave reserve, enough underlying liquidity and principal claim |
| Account | No Aave debt; collateral-dependent withdrawals are outside this scope |
| Economics | Current, correctly scoped estimate with positive conservative benefit |

All reads use one block. The reader verifies its hash again after reads. Before extending the observation streak, the command checks the previous sampled block against RPC. Reorgs, changed cycle/policy/identity, stale observations, missing or disagreeing TWAP and monitoring gaps reset the streak. Duplicate reads of one block add no time. SQLite survives process restarts and rejects an update if another writer changed the previously checked sample.

This is sampled persistence, not proof that no crossing occurred between samples. A RPC error aborts the observation; no missing observation is fabricated.

Aave's freeze flag blocks new supply but is not a withdrawal prohibition; the RETURN gate does not confuse freeze or supply-cap exhaustion with paused withdrawals. It still checks active/paused state, liquidity, balances and debt. The protocol distinction follows Aave's [withdrawal validation](https://github.com/aave/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/ValidationLogic.sol). TWAP mean-tick rounding follows Uniswap's [OracleLibrary](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/OracleLibrary.sol).

## Economics

No estimate is supplied automatically. Set `RANGEPARK_RETURN_ECONOMICS_FILE` to a local JSON file with:

- `chainId`: 84532.
- `cycleId`: the confirmed Aave supply transaction hash identifying this allocation.
- `asset`: the configured test WETH address.
- `horizonSeconds`: 3600 for the default policy.
- `quotedAt`, `expiresAt`: Unix seconds, valid now, lifetime at most 120 seconds.
- `expectedLpFees`, `executionCost`: nonnegative **decimal strings in atomic test WETH units**.
- `source`: the estimate's source and assumptions.

Execution cost must include withdrawal, approvals, swap fees/slippage, LP increase and any service/gas fees. Sponsorship of past transactions is not a forecast that future total costs are zero. The LP-fee input is an estimate, not a guaranteed yield. No currency conversion is silently applied.

```text
conservativeFees = floor(expectedLpFees × 0.8)
foregoneAaveYield = ceil(principal × current supplyAPR × horizon / year)
requiredBenefit = executionCost × 3 + foregoneAaveYield
RETURN requires conservativeFees > requiredBenefit
```

Missing, expired, future-dated, wrong-cycle, wrong-asset and wrong-horizon quotes all hold. The decision records input/policy hashes, the block, reasoning and an expiry bounded by both snapshot freshness and quote expiry.

## Commands and evidence

```sh
npm run testnet:return-observe
npm run testnet:return-observe -- preflight
```

The first command needs only RPC and the verified owner in the local environment. The second uses the read-only KeeperHub key only after every gate passes. The request fixes chain, contract, recipient and principal with `simulate:true`. The response must match sender, target, returned amount and non-reverting simulation status. A simulation that finishes after decision expiry is discarded. A new chain snapshot and actual receipt verification will still be required before any future execution stage.

There is no background scheduler. Repeated explicit calls accumulate observations in `artifacts/testnet-return-observations.sqlite`; a long pause correctly resets them. Detailed results go to `artifacts/testnet-return-observation.json`.

At block `46590109`, NFT 82083 was already restored, spot/TWAP were both -196257 and no economics file was provided. The command returned HOLD with no draft, no preflight call and no transaction. See [recorded live policy evidence](evidence/testnet-return-policy.json). Positive RETURN cases are tested with explicitly synthetic inputs; they are not public testnet execution evidence.

## Remaining work

Implement the staged broadcast runner with fresh guards at each step, confirmed withdrawal balance attribution, a fresh ratio quote, separate frozen swap/increase calls, onchain minimums/deadlines and receipt reconciliation. The existing Base mainnet draft/fork path and manual testnet restoration do not substitute for that runner. Live fee/cost estimation, recurring monitoring and execution authorization also remain outside this read-only gate.
