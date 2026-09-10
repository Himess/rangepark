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

## PARK completed — 9 September 2026

The controlled rehearsal created project-owned Uniswap V3 NFT **82083** in WETH/Aave test USDC, fee 500, original range **[-196230,-196170)**. The observed tick was -196257. This is deliberately staged test data; no autonomous profitability or 30-minute persistence decision is claimed (`policyDecision:false`).

| Step | Verified Base Sepolia transaction |
| --- | --- |
| Exact WETH approval to NFT manager | [7490fb0c…](https://sepolia.basescan.org/tx/0x7490fb0c3a95a7d93395bf9ddc085ad8a8e3b9bf138a3c0a9f5a30d1a1dc5f34) |
| Mint NFT 82083 | [a26a6863…](https://sepolia.basescan.org/tx/0xa26a6863cc240742a710bafc2b0bf425c18d71a77a2ca2b6053c5fe2ebce0d86) |
| Atomic decrease + collect | [b038fc5a…](https://sepolia.basescan.org/tx/0xb038fc5a00e2a20a3f1f86af9655f71e88ae10c3c489e2d9af9a88602982281e) |
| Exact WETH approval to Aave | [0c254dca…](https://sepolia.basescan.org/tx/0x0c254dcabf9f59b006b7cd6e07258690962382bd76dbea74e7a43b4e96eae52a) |
| Supply same WETH to Aave | [06cd1be6…](https://sepolia.basescan.org/tx/0x06cd1be60f0cfe23b869f36bd045460262b33644fd495daca765f9dbbaf9e8b8) |

Mint used `999999999999985` wei WETH; collect returned `999999999999984`; that exact amount was supplied to Aave. The aToken mint delta was `999999999999983` wei (one wei share-rounding difference). The wallet retained 15 wei WETH. The same NFT remains owned with zero liquidity and unchanged ticks. Gas was sponsored by KeeperHub.

Full source-block, request, execution-ID, transaction, metadata and balance evidence is in [testnet-park.json](evidence/testnet-park.json). Each step is preceded by authenticated simulation and a durable unique request record, then checked against the onchain inner call, block hash, KeeperHub verified receipt and appropriate state delta. Re-running the command reads existing completed steps; it cannot create another allocation. An ambiguous submission stops dependent steps and requires reconciliation.

At block `46566779`, current tick remained -196257 and the original range had not returned. A KeeperHub simulation successfully withdrew the supplied principal, but that simulation did not broadcast. This historical [return check](evidence/testnet-return-check.json) reports `automaticReturnReady:false`. Manual restoration was subsequently executed as described below; return persistence/TWAP, fresh economics and automatic ratio swapping remain required. Aave balance growth is denominated in test tokens, not realized monetary profit.

## Manual principal restoration completed — 9 September 2026

The three following transactions withdrew only the supplied principal (`999999999999984` wei WETH) and restored liquidity to the same NFT **82083**, without moving the original range **[-196230,-196170)**. Tick remained **-196257**, below that range. This WETH-only operation is an explicitly selected contract rehearsal, not a range-triggered strategy RETURN; no ratio swap was needed or executed.

| Step | Verified Base Sepolia transaction |
| --- | --- |
| Withdraw supplied principal from Aave | [fb7a7fc2…](https://sepolia.basescan.org/tx/0xfb7a7fc24ddae4e6689a31407e88781cb2336842e8bf8955bce91a49f06bcf49) |
| Exact WETH approval to NFT manager | [615c423d…](https://sepolia.basescan.org/tx/0x615c423d6527e960333db81c5c2b6b6f5fcf92acd379a7f41cf297f28f24165e) |
| Increase original NFT liquidity | [309437e3…](https://sepolia.basescan.org/tx/0x309437e32585b8901531db3736c15f6d708175fa716f873ec6a1dae0b3d4ccc2) |

At block `46574572`, liquidity was `18309835226606` (one liquidity unit below its original mint), the wallet retained 68 wei WETH, and `79016983023` wei of WETH-denominated aToken claim remained in Aave. Interest was left in Aave; this is a historical test-token observation, not monetary profit. All nine lifecycle transactions used KeeperHub-sponsored gas. [Restoration evidence](evidence/testnet-restore.json) records exact calls, execution IDs, receipt checks and pinned before/after states with `policyDecision:false` and `rangeTriggeredReturn:false`.

The restoration executor validates the original NFT, owner, token pair, fee, range and principal against the confirmed PARK journal; checks fixed-chain simulation and receipt proofs; and permanently records each submission before sending it. Dependent steps stop on ambiguous results. A changed price that no longer supports WETH-only restoration causes refusal. Restoring out-of-range liquidity proves contract interoperability; it does not demonstrate resumed LP fee earning.

## Oracle preparation completed — 10 September 2026 (Türkiye)

KeeperHub executed [the observation-capacity increase](https://sepolia.basescan.org/tx/0xc2373badd18485bd1de0850cce205b14e40bd0d31bfdadfc8801699f9786fd05), execution `r0ijw93lzzs6yfyk5w5v7`, on the original fee-500 pool at block 46610756. Gas was sponsored. Reserved capacity changed from 1 to 16, while active capacity stayed 1; sufficient history was not yet ready. NFT liquidity, original range, wallet WETH/USDC and allowances remained unchanged. This is the tenth public receipt and a preparation step, separate from the nine lifecycle receipts. See [scope and evidence](oracle-setup.md).

## Commands

```sh
npm run testnet:check
npm run testnet:preflight
npm run testnet:park -- reconcile
npm run testnet:restore -- reconcile
npm run testnet:return-check
npm run testnet:return-observe
```

These commands load the ignored local `.env`. They need the verified organization sender; authenticated reads and simulations additionally need the appropriate local API key. Use read scope for simulations. Outputs are ignored local artifacts. The preflight is a fixed 0.001 ETH deposit simulation, not an arbitrary contract executor. After restoration, `testnet:return-check` detects existing NFT liquidity and skips withdrawal simulation.

The one-time restoration was executed with `node --import tsx scripts/testnet-restore.ts execute --manual-rehearsal`. The explicit flag is required; invoke Node directly because npm on this Windows host dropped the forwarded flag. Restoration is already complete: use the reconcile command above to inspect it. Do not clear the journal to repeat it. `node scripts/sync-testnet-evidence.mjs` copies verified public reports into the web console without copying credentials.

The new [RETURN policy observer](return-policy.md) checks durable persistence, buffered spot/TWAP agreement, the original cycle, cooldown, Aave debt/liquidity and fresh economics. It creates a fixed withdrawal draft only for a passing decision. Its optional `preflight` subcommand remains simulation-only; the restored NFT correctly holds. The separate [six-stage runner](return-runner.md) now implements withdrawal/swap/reentry and has passed local Base Sepolia contract tests. Controlled pause recovery is now locally verified; public automatic execution remains pending. `npm run testnet:return-run` reads its status without broadcasting.

The separate `npm run testnet:deposit -- submit` command can broadcast the fixed deposit using `KEEPERHUB_TESTNET_WRITE_KEY`. It writes the exact request, baseline and stable idempotency key to SQLite before the HTTP request. A unique permanent wallet intent blocks a second principal allocation even after the server's 24-hour replay window. Following any interrupted or completed submission, use `npm run testnet:deposit -- reconcile`; it only reads the recorded execution and chain proof. Do not delete the execution database to retry. The initial deposit is already complete and must not be submitted again.

The testnet client rejects any RPC chain other than 84532 before contacting KeeperHub. The existing Base mainnet reader and plan types retain their separate chain 8453 guards. No global network toggle weakens those guards.

## Token distinction

The Aave Base Sepolia USDC reserve is `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`. Circle test USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e` is a different asset and was absent from Aave's reserve list. A Circle faucet balance must not be treated as an Aave supply balance.

## Next execution sequence

1. Completed: the user approved and created a separate Read + Write credential. The existing read-only key remains separate. Organization write access is not restricted to a single chain by KeeperHub; this executor only constructs chain-84532 requests.
2. Completed: the fixed 0.001 test ETH wrap was freshly simulated, submitted once and reconciled against both the chain and KeeperHub. No additional initial funding is needed.
3. Completed: project-owned NFT 82083 was created with exact approvals and a short deadline; its ID and original range are recorded.
4. Decrease/collect, Aave supply and manual principal restoration to the same NFT are complete. The automatic in-range RETURN path with ratio swapping and fresh policy guards is implemented and locally tested; public KeeperHub validation remains. Do not present manually staged testnet conditions as a profitable live strategy decision.
5. Label all public testnet receipts separately from the existing local Anvil evidence. Testnet completion does not by itself establish hackathon eligibility or authorize mainnet deployment.

The initial principal budget is 0.001 test ETH; network fees also use test ETH. Broad recurring execution, transfers to third-party wallets and mainnet transactions are outside this rehearsal.

## Deployment and API references

- [KeeperHub direct execution and simulation scopes](https://docs.keeperhub.com/api/direct-execution)
- [KeeperHub chain inventory](https://docs.keeperhub.com/api/chains)
- [Official Uniswap V3 Base deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
- [Aave Base Sepolia address book](https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol)

Deployment constants live in `src/testnet/config.ts`; readiness reads confirm actual code, market flags and pool state rather than assuming the references guarantee availability.
