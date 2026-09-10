# Observed RETURN economics

The read-only generator now replaces missing economics with a time-limited estimate. It does not manufacture a passing decision: the recorded public one-hour window contained no fee-generating activity, so expected LP income was zero and the runner returned `RETURN_NOT_ECONOMIC`. A monitoring gap also left `RETURN_PERSISTENCE_NOT_MET`. No withdrawal, simulation or public transaction occurred.

Run `npm run testnet:return-economics`, then `npm run testnet:return-run` for a non-broadcasting decision. The default quote is `artifacts/testnet-return-economics.json`; an explicit `RANGEPARK_RETURN_ECONOMICS_FILE` takes precedence. Quotes last at most 120 seconds, must match the allocation and asset, and never substitute for fresh chain and persistence checks. This is an explicit local command, not a continuous hosted feed.

## Historical fee model

The estimator locates an actual one-hour block window by timestamp search. It reads pool logs and fee-growth counters at the window edges and before/after every Swap/Flash block. All block deltas must reconcile to the global counter change, including excluded blocks. Missing history, inconsistent block identities, reorgs, unavailable oracle calls or expired snapshots fail the read; they do not create a zero-cost quote. Limits are 20,000 blocks and 24 fee-bearing blocks per read; excess activity fails the entire quote.

It sizes hypothetical original-range liquidity from 99% of the recorded WETH principal at current spot price, then attributes the observed Q128 fee growth to that liquidity with dilution. Every contributing block must remain inside the original range at both edges and each recorded swap. Blocks containing Mint/Burn, known project transaction hashes, or Swap/Flash sender/recipient equal to the owner are excluded in full. A hypothetical allocation above 1% of the minimum observed active liquidity is also excluded. This last rule currently applies to the full recorded allocation in the small test pool; it prevents extrapolating an immaterial-trader approximation to a material position.

Token-1 fees are valued in WETH using the less favorable of spot and TWAP. Integer rounding is downward. The historical rate is projected over the policy horizon; this is our conditional counterfactual model, not an onchain entitlement or guaranteed future income. Unidentified project/test actors are not proven organic, and excluding mixed blocks can understate fees. These limits should be kept visible in any demonstration.

Uniswap's global growth counters and Swap/Flash fee updates are defined by [UniswapV3Pool.sol](https://raw.githubusercontent.com/Uniswap/v3-core/main/contracts/UniswapV3Pool.sol). The attribution, exclusions and dilution above are RangePark's conservative modeling choices.

## Execution planning budget

The current budget deliberately uses coarse resource allowances, not measured per-stage transaction gas:

```text
L2 execution = 6 calls × 4,000,000 gas × (current eth_gasPrice × 2)
L1 data = 6 × GasPriceOracle.getL1FeeUpperBound(8,192 unsigned bytes)
operator = 6 × GasPriceOracle.getOperatorFee(4,000,000 gas)
swap allowance = ceil(principal × 1%)
executionCost = L2 execution + L1 data + operator + swap allowance
```

The OP fee oracle is `0x420000000000000000000000000000000000000F`; its reads are pinned to the source block. `eth_gasPrice` is a current RPC estimate obtained during the read. The larger buffer does not guarantee a cap on future prices, sponsored-wrapper costs or additional service charges. These allowances need calibration against actual complete execution before production use; no independent KeeperHub service tariff is quoted. Sponsorship is not assumed free. See [OP transaction fee components](https://docs.optimism.io/op-stack/transactions/fees) and the [GasPriceOracle methods](https://raw.githubusercontent.com/ethereum-optimism/optimism/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol).

The existing policy applies a further 20% income haircut and requires benefit greater than three times this budget plus foregone Aave yield. A zero-income window cannot pass, regardless of sponsorship.

## Reproducible evidence

- [Public read and HOLD decision](evidence/testnet-return-economics.json): real Base Sepolia inputs, exact integer costs, block hashes, allocation, source snapshot, and decision. Historical evidence only; the quote is not reusable after expiry.
- [Local contract test](evidence/testnet-return-economics-fork.json): fork block 46631150; impersonated local trader wraps ETH and swaps through the real pool. The actual allocation is excluded as material. A clearly labeled hypothetical 0.000001 WETH allocation produces positive fee attribution; excluding the synthetic swap returns that projection to zero. This does not claim public RETURN or strategy profit.

For the local test, start Anvil on `127.0.0.1:8546` with Base Sepolia chain ID 84532 and fork block 46631150, then run `npm run test:fork-return-economics`. The script checks the loopback client and fork, snapshots it, and reverts all local state afterward. Its files never replace the public runner's quote.

Remaining work includes calibrated budgets, stronger attribution of project actors, robust fee forecasting beyond this bounded conservative model, continuous fresh observations and public validation of automatic RETURN. The current public capital remains parked until all existing gates pass.
