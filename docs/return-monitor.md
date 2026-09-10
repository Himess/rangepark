# Continuous local RETURN observation

The foreground monitor combines a new block snapshot, historical fee projection, current OP execution budget and durable price persistence every 60 seconds. It is read-only: no KeeperHub key, simulation, approval, withdrawal or execution method is called. A passing RETURN decision is a review artifact only.

```sh
npm run testnet:return-monitor
npm run testnet:return-monitor -- once
npm run testnet:return-monitor -- status
node --import tsx scripts/testnet-return-monitor.ts watch --samples 7
```

The default command runs until stopped. `once` takes one sample; `status` reads the local durable record without RPC. Use the direct Node form for a bounded run so Windows/npm argument forwarding does not consume `--samples`. Ctrl+C/SIGTERM stops the wait and prevents an in-flight sample from being committed; already running RPC calls may finish before shutdown. The process must remain running on an awake computer. This is not a hosted service or an OS auto-start installation.

## Decisions and failures

Each iteration obtains fresh economics from the same snapshot. It never falls back to a previous successful quote or to the optional external economics file. Monitor quotes are stored inside evidence and do not overwrite the separate runner's default quote file. The execution runner therefore still requires its own fresh inputs and all existing guards.

After RPC reads, the monitor verifies that the recorded allocation has not changed, checks the snapshot's block hash again, checks the previous observation's canonical block, and enforces freshness before recording history. Economics failure produces `DEGRADED`, null economics and a HOLD for missing economics, while a valid price observation may still be recorded. Snapshot/RPC/revalidation failure produces `DEGRADED` with no current decision. It never presents an old RETURN as the current result. Error codes identify the failed stage without persisting raw RPC headers, endpoint credentials or exception text.

Observations share the existing SQLite price-history journal. Repeated blocks do not extend time, and gaps over 120 seconds reset persistence. Reorg and concurrent-observation handling remains in the existing observation reducer. A process restart can reuse canonical recent history; a long interruption cannot bypass the five-minute rule. Economics remains subject to its own quote lifetime and policy validation.

Iterations run sequentially, targeting 60-second start spacing. Slow work is never overlapped or followed by a burst of catch-up samples; a minimum one-second wait applies after an overrun. Public RPC throttling or slow history reads can cause failed samples and a persistence reset. This is visible in the journal rather than hidden by relaxing the policy.

## Process ownership and evidence

`artifacts/testnet-return-monitor.sqlite` contains a renewable 120-second lease, refreshed every 30 seconds. A second monitor is rejected. A crashed process can be replaced after lease expiry; an expired/changed owner cannot renew or publish another sample. Lease validation occurs inside the transaction that writes monitor status. The lease coordinates monitor processes only; other operator/execution commands still have their own checks and journals.

The latest 120 detailed samples are retained. Status records include a write timestamp; consumers must treat them as historical and inspect age. Normal shutdown writes `STOPPED` with no actionable decision and exports `artifacts/testnet-return-monitor.json`. A crash may skip the export, but committed SQLite observations remain. The observation journal and monitor journal are separate databases: a failure between writes can preserve price history without a corresponding monitor sample, but cannot create an execution authorization.

No background process is promised by these files. The recorded live validation run is bounded and stops after collecting its evidence. Hosted supervision, ongoing alert delivery, automatic execution and public proof of a condition-triggered RETURN remain separate work.

## Recorded validation

The [public RPC validation evidence](evidence/testnet-return-monitor.json) contains seven successful samples spanning 350 seconds of actual block time. Each sample generated a new, still-current economics quote from its source snapshot. At the end, the persistence gate passed and only `RETURN_NOT_ECONOMIC` remained; projected LP fees were zero. No transactions were submitted.

A later restart followed a real 16,362-second observation gap and correctly reset persistence. Two subsequent process runs eight block-seconds apart preserved the recent observation streak. An overlapping second process was rejected while the original seven-sample run held its lease. All validation processes finished and recorded `STOPPED`; the final short streak had not yet accumulated another five minutes.

Validation: 328 unit/integration tests passed, three optional live tests skipped. Monitor-specific tests cover fresh quote replacement, RPC failure, stale reads, allocation changes, reorg rejection, lease fencing, durable reopen, bounded retention and abortable sequential scheduling. The live evidence above is a separate read-only check against Base Sepolia.
