# Re-PARK of the original testnet NFT

On 10 September 2026, KeeperHub executed a new three-transaction allocation on Base Sepolia using the capital already restored to NFT **82083**. No additional wrap, NFT mint or mainnet transaction was needed. The unchanged range is `[-196230,-196170)`.

The latest recorded allocation is **PARKED** on Aave: `999999999999930` wei WETH. The original NFT is empty and still owned by the same KeeperHub account. This is an explicitly staged testnet rehearsal (`policyDecision:false`), not evidence that the automatic PARK or RETURN policy passed.

| Step | KeeperHub execution | Public receipt |
| --- | --- | --- |
| Atomic release and collect | `456y4hyrwzq9u30pe30nd` | [Block 46615709](https://sepolia.basescan.org/tx/0x85ba09cf19c341390de7cc0bc25be347e23af9baeb7ad2f1117bf50db0e5e2c6) |
| Exact Aave approval | `jfqgsuyns7xoi6m36boqw` | [Block 46615716](https://sepolia.basescan.org/tx/0x8c88ef692df014d46c0feea75657124cd848b7b398cc70d42ee9ba23b0782de5) |
| Supply collected WETH | `cwqodz1mvv9syi6710ohx` | [Block 46615724](https://sepolia.basescan.org/tx/0x37a8140b1cc6f69816fbb81bfea0803f41e141aaeca67cb8684f410a77725381) |

[Full public evidence](evidence/testnet-repark.json) contains frozen calldata, canonical blocks, original restoration anchor, sponsored transaction verification, events and balances. Together with the first nine lifecycle receipts and oracle preparation, there are **13 public KeeperHub receipts**.

## Capital accounting

Only the verified WETH balance increase from the NFT collection is the new principal. The wallet's pre-existing **68 wei WETH** remained after supply. The original Aave position's **53810434268 scaled shares** were not counted as new capital; final total scaled balance was **680750395413806**. The new share delta is checked against the deposited amount divided by the Aave Mint event's liquidity index, with only integer conversion rounding allowed. Accrued interest included in that event is subtracted before comparing principal.

This is a bounded testnet accounting check for one existing allocation, not a complete production share ledger across arbitrary deposits, withdrawals and users.

## Durable cycle boundary

Each intent binds the original owner, NFT, original restoration transaction and step. It has no time bucket. A committed SQLite claim precedes the HTTP write. Losing a response cannot trigger a second write; unknown submissions remain blocked for reconciliation.

All three receipts must be confirmed before the new allocation becomes `PARKED`. A partial sequence is `RECOVERY`. The new supply transaction becomes the RETURN cycle ID, and its actual block timestamp starts a new cooldown. Old PARK, restoration and RETURN records remain intact. This one-time re-PARK is anchored to the first restoration; it does not enable arbitrary future cycles.

```sh
npm run testnet:repark
npm run testnet:repark -- run --execute --manual-rehearsal
npm run testnet:repark -- reconcile
npm run testnet:return-run
```

`status` reads readiness; only `run` with both flags can submit an unstarted step. Once all three steps are confirmed, repeating `run` reads their existing proofs. Pending receipts must use their existing execution IDs; unknown submissions must never be reset or resent.

## Validation and remaining gates

- Root typecheck and **245 tests passed**; three optional live tests were skipped. The 28 re-PARK tests cover scope, capital isolation, scaled-share rounding, partial cycles, simulation changes and lost-response duplicate prevention.
- A local Base Sepolia fork at block `46610756` executed all three real contract calls with the owner's delegation retained. [Local proof](evidence/testnet-repark-fork.json) uses emulated KeeperHub envelopes, local impersonation and local ETH funding. Its hashes are not public links.
- Public RETURN status selects the new cycle and holds: oracle history, spot/TWAP inside the band, persistence, cooldown and economics are still required. The existing latest-block status reader can also report `STALE_DATA` when the sequencer timestamp is ahead of the host clock; freshness has not been relaxed. Re-PARK preflight uses a pinned block two blocks behind the head to avoid that clock edge.
- No public automatic RETURN, faucet mint, synthetic public price movement or profitability result is claimed. The hosted console displays receipt snapshots and has no execution key.
