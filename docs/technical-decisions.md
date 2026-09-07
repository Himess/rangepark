# Technical decisions — 7 September 2026

## 1. First implementation is a small TypeScript core

One package currently contains chain readers, deterministic policy logic and a CLI. This avoids creating a monorepo, worker and database before the execution path is verified. The modules can later be used from a web/API application.

The main integration targets are Uniswap V3 and Aave V3 on Base. Compound comes after PARK/RETURN and recovery work. Morpho, BOOST/TRIM, Safe and additional chains remain outside the first slice.

## 2. Workflow testing and transaction simulation are different

KeeperHub's current [workflow test page](https://docs.keeperhub.com/agent/mcp-test-workflow) documents `prepare_test_pin_data`, which returns test input schemas. It lists workflow dry-run execution as roadmap work.

The [direct execution API](https://docs.keeperhub.com/api/direct-execution) supports actual single-call EVM preflight with `simulate: true`. The implementation sends `chainId`, `functionName`, JSON-string `functionArgs`, JSON-string `abi` and `value: "0"`. It validates `status: simulated`, `wouldRevert: false`, sender and target. HTTP errors retain structured failure details.

Independent calls against the same original chain state cannot simulate a dependency chain such as approve followed by supply. We will simulate the next step only after the previous transaction is confirmed, and use a local fork for full lifecycle testing. A successful simulation never proves future inclusion or successful execution.

The simulation client intentionally has no broadcast method. Authentication has not been exercised against a user's KeeperHub organization.

## 3. PARK freezes a conservative principal amount

The principal estimate excludes fees. The amount to park is `floor(principal × (10000 - slippageBps) / 10000)`. That exact amount is used for the nonzero decrease minimum, ERC-20 approval and Aave supply.

The NFPM `multicall` groups decrease and collect into one atomic transaction. If either subcall fails, both revert. This prevents the specific intermediate state where decrease succeeded but collect did not. A later supply failure can still leave funds in the owner wallet.

Both collected fee tokens and any excess principal remain in the wallet. They must be included in future residual-balance reporting. The executor must verify the **received balance delta**, not just an existing wallet balance, before using it for the supply.

An out-of-range position legitimately has a zero minimum for its absent principal token. A blanket ban on all zero minimums would reject valid one-sided exits. A swap minimum of zero is a different case and will remain disallowed.

## 4. Onchain guards are still required

The current frozen plan is a review artifact, not an enforced executor. Its hash detects changes; it is not a user signature or proof of approval. Precondition descriptions are not onchain guards.

Before adding broadcast, bind persisted user approval to the plan hash, lock the position, re-read owner/liquidity/price/reserve state, verify expiry, and simulate the next call. Address the race between offchain checks and inclusion; multicall contains no oracle or out-of-range assertion. Bound the economic exposure with contract-enforced output minimums and short deadlines, and consider a dedicated guard only if the remaining risk requires it.

Idempotency needs a durable journal in RangePark. KeeperHub's documented direct-execution response replay window is 24 hours; it cannot replace durable duplicate prevention. Ambiguous timeouts and any existing transaction hash require reconciliation before resubmitting.

## 5. Economics use explicit assumptions

APR is read in Aave RAY units and used as a simple annual rate; it is not labelled APY. Arithmetic uses bigint atomic units of the same token. No USD oracle or future fee forecast is fabricated.

For the chosen horizon:

```text
expectedYield = fixedSupply × supplyAPR × horizon/year × (1 - yieldHaircut)
requiredBenefit = roundTripCost × safetyMultiplier + foregoneLpFees
PARK is economic only when expectedYield > requiredBenefit
```

Both costs are supplied by the caller with a source description. Live gas, service fees, price conversion and LP opportunity-cost estimates still need implementation. The horizon is a scenario assumption, not a forecast of how long price stays out of range.

## 6. Observation semantics

Uniswap tick ranges are lower-inclusive and upper-exclusive. An out-of-range NFT can still have nonzero `liquidity`. The reader obtains current principal with the official SDK and labels `tokensOwed` as checkpoint values rather than claiming they are all current uncollected fees.

Persistence is based on successive observed chain blocks with a maximum monitoring gap. It resets after a gap, side change, ownership/liquidity change or detected reorg. Repeated reads of one block add no time. This is sampled observation history, not proof that no crossing happened between samples. Five-minute TWAP is an additional gate; unavailable TWAP fails closed.

## 7. RETURN will use a new approval stage

Do not reuse a pre-withdraw approval for different swap calldata. After withdraw confirms, read the actual balances, calculate the ratio, obtain a fresh swap quote and create a new exact swap/increase plan. The original NFT remains unburned for same-range return.

## 8. Sources and deployment verification

Addresses are explicit in `src/config/base.ts` and were checked against:

- [Uniswap Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
- [Aave Base address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol)
- [Aave pool data provider interface](https://github.com/aave/aave-v3-origin/blob/main/src/contracts/interfaces/IPoolDataProvider.sol)
- [KeeperHub Uniswap implementation, staging](https://github.com/keeperhub/keeperhub/blob/staging/protocols/uniswap-v3.ts)
- [KeeperHub direct execution reference, staging](https://github.com/keeperhub/keeperhub/blob/staging/docs/api/direct-execution.md)

KeeperHub's default repository branch was `staging` at inspection. That source includes swap/quote support beyond the short Uniswap plugin documentation, but not the position-management actions needed here. Before a bounty contribution, pin a commit and check for intervening changes. No PR has been opened.
