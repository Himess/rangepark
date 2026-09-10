# Controlled Base Sepolia price scenario

On 10 September 2026, four KeeperHub transactions moved the test pool from tick **-196257** to **-196198**, inside NFT 82083's original range. This is a deliberate **test market intervention**, not organic volume or strategy profit. It prepares public RETURN validation while leaving the Aave principal untouched.

| Step | KeeperHub execution | Receipt |
| --- | --- | --- |
| Mint 100 Aave test USDC | `ax8pn33fm9yf19b0rkcwv` | [46631129](https://sepolia.basescan.org/tx/0x55d11d766d6c29fb9e05192e1a2e31bcea97a8676db2fbe7199fa2db0e0cd48a) |
| Approve 100 test USDC | `fuqf4nm9fd0qg45ks8anc` | [46631135](https://sepolia.basescan.org/tx/0x56557bc85c2af7e06459bf3ca3e2d3e98d6667919f2eea3b9ee011aa00e69470) |
| Swap to the target tick | `e0squgq7po1101lsup7e0` | [46631142](https://sepolia.basescan.org/tx/0x550e4a5c1e4f8c1940bc6f3efc17cfa860fdb3a667441aa8db5017100a7207f4) |
| Revoke residual approval | `kne0n1dpdppxge73a8sdn` | [46631150](https://sepolia.basescan.org/tx/0x8f9d5716bd22e85a48505354728462227269ded0bb170f957f8855d335f5ee36) |

There are now **17 public KeeperHub receipts**: 13 earlier lifecycle/setup transactions and these four fixture transactions. [Complete public proof](evidence/testnet-price-fixture.json) includes frozen calldata, sponsor verification, events, canonical receipt blocks and token/share deltas.

## Isolation and limits

- Faucet tokens: Aave test USDC, not Circle USDC. The verified token owner is the configured faucet. Its permission, cooldown and maximum mint amount are read before execution.
- The swap used **12.099203 test USDC** out of the 100-token cap. A square-root price limit stopped it at the target tick; a quoted nonzero output minimum and a 120-second multicall deadline bounded execution.
- The swap received **0.004019302920150745 test WETH**. These are fixture proceeds in the wallet, not Aave interest or RETURN principal. Existing RETURN accounting attributes only the later verified Aave withdrawal delta.
- Aave scaled shares stayed exactly **680750395413806** throughout all four steps. NFT 82083 stayed empty and owned; the range and strategy allowances were preserved. Final test-USDC router allowance was **zero**.
- The new fixture has permanent, cycle-bound step intents. Lost responses cannot cause a new mint or swap. Each dependency requires a confirmed receipt. RETURN startup sees an incomplete fixture as RECOVERY; the fixture CLI refuses an existing RETURN run. Operators must serialize these test commands; this is not a production cross-process transaction scheduler.

## Commands and validation

```sh
npm run testnet:price-fixture
node --import tsx scripts/testnet-price-fixture.ts run --execute --manual-fixture
node --import tsx scripts/testnet-price-fixture.ts reconcile
node --import tsx scripts/sample-testnet-return.ts 10
```

The status and bounded sampling commands never broadcast. Sampling takes real observations at least 60 seconds apart, persists them in the existing SQLite journal, and stops after its sample budget or after only the economics gate remains. It does not advance chain time or schedule future background work.

Before public execution, the four calls passed against real contracts on an Anvil fork at block **46615724**, using local owner impersonation and ETH funding. [Local proof](evidence/testnet-price-fixture-fork.json) has no public explorer links. The test transport emulates KeeperHub responses; the separate public proof uses actual sponsored execution.

Nineteen fixture tests cover mint bounds, original position identity, principal preservation, exact approval, cleanup, changed simulation state and lost responses. A separate reader change handles a sequencer tip ahead of the host clock by selecting an actual block two blocks earlier. It never rewrites a timestamp or relaxes freshness; explicit receipt-block reads remain exact.

Automatic public RETURN still requires genuine time-in-range observations and current, attributable fee/cost inputs. Test-generated activity must remain labelled when evaluating economics.

## Recorded public observation result

[Eight real-time samples](evidence/testnet-return-sampling.json) cover blocks 46631200–46631417. At the last sample, both spot and 300-second TWAP were -196198. Six consecutive eligible samples spanned **308 seconds** from block timestamp 1789030814 to 1789031122. Oracle capacity, price band, cooldown and persistence checks passed; the sole remaining reason was **RETURN_ECONOMICS_MISSING**. No withdrawal, fabricated timestamp or policy override was used. This is historical observation evidence; a future execution needs fresh observations and economics again.

Validation after the reader change: root typecheck and **295 tests passed**, with three optional live tests skipped. The web source also passed typecheck, lint and deployment build.
