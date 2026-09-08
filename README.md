# RangePark

**Earn fees in range. Earn yield while waiting.**

RangePark is a KeeperHub hackathon project for parking fee-idle Uniswap V3 capital in the same underlying asset on Aave V3, then returning it to its original range.

## Current milestone: complete local PARK → RETURN and live console

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

**Not implemented yet:** a complete KeeperHub Uniswap/Aave lifecycle, a production strategy executor, automatic gas/opportunity-cost quotes, strategy-owned aToken share accounting across existing deposits, continuous hosted monitoring, Compound/Morpho and submission video. Stored approval actors are local records, not wallet signatures. RETURN plans are review drafts; they require fresh chain checks before execution.

The first real KeeperHub testnet transaction is verified: **0.001 test ETH → 0.001 WETH on Base Sepolia**, with gas sponsored by KeeperHub. [Transaction proof](https://sepolia.basescan.org/tx/0x9bcc5690cf3c0261c6d1733d07efd7f32cc4731b999dfc81e80b0696c762e4ae) and [execution boundaries](docs/testnet.md) distinguish this initial funding step from the pending public Uniswap/Aave lifecycle. The generated decision demo remains synthetic and is not submission evidence.

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

`observe` preserves samples in `artifacts/rangepark.sqlite` across processes. Repeated calls at one-minute intervals accumulate history; gaps over 120 seconds reset it. The web observation switch runs only while its Position view is open. Neither path schedules autonomous transactions.

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
