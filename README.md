# RangePark

**Earn fees in range. Earn yield while waiting.**

RangePark is a KeeperHub hackathon project for parking fee-idle Uniswap V3 capital in the same underlying asset on Aave V3, then returning it to its original range.

## Current milestone: unattended read-only RETURN monitoring

Implemented:

- Base Uniswap V3 NFT discovery and position reads, including owner, pool, ticks, principal and 5-minute TWAP.
- Aave V3 WETH/USDC reserve reads: supply APR, pause/freeze, available liquidity and supply-cap headroom.
- Reads pinned to one block, with a final block-hash check.
- Deterministic PARK/HOLD evaluation with persistence, freshness, TWAP, cooldown, asset/venue allowlist and economic checks.
- Exact integer token arithmetic; economics include a yield haircut, round-trip costs and foregone LP fees.
- Review-only PARK plans with hashes and encoded calldata: atomic decrease + collect, exact approval, fixed-amount supply.
- KeeperHub **single-call simulation** client, with strict sender/target verification and structured failure handling.
- Offline demo, unit tests, optional live read/eth_call tests, and CI configuration.
- SQLite observation and execution journal: frozen approvals, position locking, ordered steps, ambiguous-submission reconciliation, and persistent pause.
- Aave withdrawal followed by a separately approved ratio swap and increase of the **original NFT**, with deadlines and nonzero minimum amounts.
- Full lifecycle verified with nine transaction receipts on an Anvil fork of Base. Evidence is bundled in the console and explicitly labelled local.
- Web console in `apps/web`: public NFT reads, D1 observation history, synthetic decision lab, and downloadable execution evidence.
- Real KeeperHub Base Sepolia PARK rehearsal: mint owned NFT `82083`, atomically release its liquidity, and supply the same WETH to Aave. Five additional transactions have verified receipts and balance deltas; the original NFT and range are preserved.
- Manual principal restoration: withdraw the supplied WETH from Aave, approve the exact amount and restore liquidity to NFT `82083` in its original range. Nine public testnet receipts cover funding, PARK and restoration; the console includes a separate timeline and downloadable proof.
- Base Sepolia RETURN decision gate: durable five-minute observations, buffered spot/TWAP agreement, cooldown, current cost estimates, reserve liquidity and debt checks. Only a passing decision can generate an exact withdrawal draft or read-only KeeperHub simulation. Completed and unresolved cycles cannot be treated as parked capital.

- Six-stage guarded testnet RETURN runner: confirmed withdrawal, price-impact-aware ratio swap and increase of the original NFT. Actual contracts passed on a local Base Sepolia fork; six local receipts and explicit residual accounting are included in the console. See [runner, proof and recovery limits](docs/return-runner.md).

- Read-only RETURN economics generator: one hour of reconciled pool fee growth, project-activity exclusions, OP Stack gas/data/operator fee inputs and a conservative swap-loss budget. The local runner consumes the expiring quote. [Method, live HOLD evidence and local contract proof](docs/return-economics.md).

- Continuous local read-only RETURN monitor: fresh chain/economics inputs every minute, durable observation history, renewable process lease, explicit degraded status and bounded evidence retention. [Commands and operational limits](docs/return-monitor.md).

- Hosted RETURN service with authenticated checks, atomic D1 history, per-minute deduplication and a server-status view. An isolated timer on an existing VPS triggers checks every minute, independently of the development PC. KeeperHub Pro is not needed for this read-only scheduling path. [Deployment and limits](docs/hosted-return-monitor.md), [timer operation](docs/vps-monitor.md).

**Not implemented yet:** public validation of the automatic RETURN runner, a production strategy executor, calibrated execution budgets, strategy-owned aToken share accounting across existing deposits, ongoing alert delivery, Compound/Morpho and submission video. Stored approval actors are local records, not wallet signatures. Strategy RETURN plans are review drafts; they require fresh chain checks before execution.

KeeperHub has now executed **0.001 test ETH → Uniswap NFT → Aave → the same NFT** on Base Sepolia. [Original-NFT restoration proof](https://sepolia.basescan.org/tx/0x309437e32585b8901531db3736c15f6d708175fa716f873ec6a1dae0b3d4ccc2) and [execution boundaries](docs/testnet.md) document the manual contract rehearsal. Price remained below the original range; this is not an automatic range-triggered RETURN or a profitable strategy claim. Interest remains in Aave as test tokens. The generated decision demo remains synthetic. Automatic RETURN and hackathon eligibility checks are pending.

KeeperHub also completed a separate public oracle preparation transaction on 10 September (Türkiye time): reserved pool observation capacity increased from 1 to 16, with the NFT and token balances unchanged. Ten public receipts now cover the nine manual lifecycle steps plus this preparation. Active capacity remained 1 at its receipt block; price history still needs to populate. [Oracle evidence and remaining gates](docs/oracle-setup.md).

The same NFT was released again and its **999999999999930 wei WETH** supplied to Aave in three further verified KeeperHub transactions. There are now **13 public receipts**. The new cycle is PARKED; old Aave shares and the separate wallet balance were preserved. RETURN recognizes this cycle but remains on HOLD until its conditions pass. [Re-PARK receipts, accounting and limitations](docs/repark.md).

Four further KeeperHub transactions prepared a **controlled test-price scenario**, bringing the pool inside the original range without changing Aave principal shares. Total public receipts: **17**, including four explicitly labelled fixture transactions. The test swap's wallet proceeds remain separate from strategy principal. [Scenario proof and remaining RETURN gates](docs/price-fixture.md).

## Run locally

Requires Node.js 22.13+ and npm.

```sh
npm ci
npm run check
npm run demo
npm run discover -- 4
npm run inspect -- 5950133
npm run observe -- 5950133
```

`5950133` is a public sample NFT successfully read during development. It is not our wallet or demo capital, and it may change or be burned. Use `discover` or your own Base WETH/USDC NFT ID when refreshing.

Commands save reports under `artifacts/`, which is excluded from Git:

- `demo.json`: labelled synthetic inputs, PARK/HOLD decisions, and a review-only plan.
- `position-<id>.json`: actual onchain position and both Aave reserves, with source block/hash.
- `preflight-<id>.json`: optional authenticated KeeperHub simulation result.

`inspect` never claims that a single snapshot proves 30 minutes out of range. It reports `NOT_EVALUATED` for the live policy decision until monitoring history and cost assumptions are supplied.

`observe` preserves samples in `artifacts/rangepark.sqlite` across processes. Repeated calls at one-minute intervals accumulate history; gaps over 120 seconds reset it. The web observation switch runs only while its Position view is open. Neither path schedules autonomous transactions. The separate `testnet:return-monitor` command now combines fresh economics and observations in a continuous foreground loop, also without broadcasting.

The optional local `RANGEPARK_ECONOMICS_FILE` supplies chainId, asset address, atomic-unit roundTripCost and foregoneLpFees, source, quotedAt, expiresAt, and nullable lastActionAt. Quotes must be current, belong to the relevant asset and have a lifetime no longer than 120 seconds. A valid quote enables live policy evaluation and a review-only draft; absent costs never silently become zero.

### Web console

```sh
npm run sync:web
cd apps/web
npm ci
npx wrangler d1 execute site-creator-d1 --local --config wrangler.local.json --file drizzle/0000_gigantic_vampiro.sql
npm run dev
```

Apply the local initial migration once per new database. Use `npx tsc --noEmit`, `npm run lint` and `npm run build` in `apps/web` for validation. Lint excludes untouched generated shadcn primitives and its generated mobile hook; authored application code remains checked. `node scripts/check-web.mjs` from the root exercises HTTP decision branches and an existing saved sample on localhost:3000.

The root repository includes the web sources; Sites additionally maintains a source repository rooted at `apps/web`. `sync:web` copies the common core for an independent web build. The core libraries are server-side; no signing key belongs in the client.

### Local fork proof

The harness only writes to `http://127.0.0.1:8545` after checking that it is Anvil and chain 8453. It snapshots and restores the fork. Start Anvil with a Base archive RPC at block 50998408, then run `npm run test:fork`.

It mints a locally funded out-of-range position, observes persistence, releases and supplies WETH, injects an ambiguous response, advances local time, moves pool price with a real swap, withdraws, swaps into the range ratio and restores the same NFT. Local account funding, impersonation and time advancement are fixture operations, not a mainnet strategy. The result is saved to `artifacts/fork-lifecycle.json`. Windows receives an optional native Anvil package; other operating systems can use their own Anvil installation.

### Testnet first

The next onchain rehearsal is restricted to **Base Sepolia (84532)**. Run `npm run testnet:check` for wallet/contracts/markets and `npm run testnet:preflight` for a fixed **0.001 test ETH** wrap simulation through KeeperHub. Both commands are non-broadcasting. The existing organization wallet already has test ETH; no private-key export is needed. See [testnet evidence and execution boundaries](docs/testnet.md), including the difference between Aave test USDC and Circle test USDC.

The one-time funding, PARK and manual restoration steps are complete. `npm run testnet:park -- reconcile` and `npm run testnet:restore -- reconcile` read their recorded executions without sending them again. `npm run testnet:return-check` reads the original NFT/range; after restoration it reports existing liquidity and skips withdrawal simulation. It never broadcasts or claims that the complete RETURN policy is ready. See the [testnet command boundaries](docs/testnet.md) before invoking any execution command.

`npm run testnet:return-observe` evaluates the new RETURN policy and persists its own observation history across invocations. `npm run testnet:return-observe -- preflight` additionally simulates the fixed withdrawal **only if every policy gate passes**. Both are non-broadcasting. The latest parked allocation still produces HOLD until all gates pass, with no withdrawal or simulation. See [RETURN policy and quote inputs](docs/return-policy.md). The guarded post-withdrawal runner is now implemented and locally tested. `npm run testnet:return-run` reports its status without broadcasting. Controlled recovery now refreshes only unsent calls after rechecking confirmed receipts. Public execution and scheduling remain separate gates; see [runner commands and limitations](docs/return-runner.md).

### Base mainnet read-only preflight

`npm run connection` reads the verified execution EOA's Base ETH/WETH/USDC balances and its Uniswap NFTs. Configure `KEEPERHUB_EXPECTED_SENDER` from the organization's Wallets page. Without an API key, it explicitly reports `NOT_AUTHENTICATED`; with one, it simulates a USDC balance read and a zero-amount WETH approval. Neither probe broadcasts or grants an allowance. The report is saved locally as `artifacts/keeperhub-connection.json`.

Use a key scoped to **`mcp:read` only** for these checks. KeeperHub's [current direct-execution reference](https://docs.keeperhub.com/api/direct-execution) permits `simulate: true` with read scope and requires write scope for broadcasting. No write/admin credential is needed for the connection probe.

Copy `.env.example` to `.env` and set the organization API key locally. Never commit it or put it in a frontend bundle. The CLI loads `.env` automatically; existing environment variables take precedence.

```sh
npm run preflight -- <out-of-range-token-id>
```

The organization must use the EOA that owns the NFT. This command simulates only the atomic decrease/collect step, using KeeperHub's `POST /api/execute/contract-call` with the boolean `simulate: true`. It cannot broadcast. It does not approve the strategy or certify the full workflow. An in-range or empty position is rejected.

Safe routing is not supported in this milestone: KeeperHub's documented preflight sender is the organization EOA, which can differ from the Safe used for execution.

### Optional live verification (PowerShell)

```powershell
$env:LIVE_POSITION_ID = '5950133'
npm test -- tests/live-read.test.ts
```

The live suite reads both lending reserves and compares SDK principal amounts with the actual return value of a simulated Uniswap `decreaseLiquidity` call at the same block. It does not sign or broadcast. `LIVE_POSITION_ID` is unset in CI, so external-network tests are skipped there.

## Layout

```text
src/
  chain/       Base RPC, Uniswap and Aave reads, minimal ABIs
  config/      Explicit Base deployment allowlist
  core/        Types, observation reducer, economics and decision receipts
  keeperhub/   Calldata plans and simulation-only REST client
  state/       Durable SQLite observations and execution journal
  demo/        Clearly labelled synthetic scenario
  cli.ts       Runnable entry point
tests/         Policy, calldata, transport and opt-in chain tests
scripts/       Local fork lifecycle, web API checks and core synchronization
apps/web/      Position console, D1 history and evidence viewer
docs/          Technical decisions, evidence and remaining milestones
```

The original `RangePark-Komple-Urun-Mimarisi.md` is preserved as the product vision. [Technical decisions](docs/technical-decisions.md) record changes to its assumptions. [Build status](docs/build-status.md) distinguishes implemented behavior from planned behavior.
