# Hosted RETURN monitor

The Sites service now exposes a read-only Base Sepolia monitor, backed by D1. `GET /api/return-monitor` reads persisted status; `POST /api/return-monitor` performs one authenticated observation with fresh economics. The browser's **Server monitor** tab polls saved status only and cannot initiate a sample or move funds.

The deployment preserves owner-only site access. Machine calls need both the Sites dispatch credential (`OAI-Sites-Authorization`) and an independent application bearer token (`Authorization: Bearer …`). The latter is stored as the secret `RETURN_MONITOR_TOKEN`; it is not a KeeperHub API key or wallet key. Requests fail closed when the secret is absent or incorrect. `RETURN_MONITOR_ENABLED=false` disables sample execution. Runtime changes require deployment to take effect.

## Scheduling boundary

An isolated systemd timer on the existing VPS now calls the POST endpoint once per minute. There is no always-running loop in the Worker, and refreshing the page does not schedule work. The timer survives PC shutdown and is enabled across server restarts. See [installation and operation](vps-monitor.md).

KeeperHub's Free plan previously blocked a native HTTP schedule because its authenticated action registry marked `HTTP Request` and `webhook/send-webhook` as Pro features. No KeeperHub workflow or paid upgrade was created. The existing-server trigger provides unattended read-only checks without that upgrade. The [workflow API](https://docs.keeperhub.com/api/workflows) remains the reference for any future native schedule. A failure or schedule gap never relaxes the RETURN policy.

## Ownership, freshness and allocation

Each UTC minute may claim the allocation only once. A 55-second lease prevents overlap across minute boundaries. One conditional SQL update commits the observation, detailed report and last 120 compact decision records together. The lease token fences late writers; elapsed leases cannot publish. An unsuccessful request is not retried in the same claimed minute. A following minute may retry after the lease expires.

The record fixes the previously confirmed cycle, NFT, owner, principal and project-activity exclusions. It is not a general user-editable strategy registry. Onchain checks verify current ownership, NFT liquidity, balances and reserve conditions. Operators must replace the allocation record for a new cycle; the hosted service does not import the local execution journal or learn new allocations automatically. Hosted and local observation histories remain independent.

Fresh successful checks are labeled recent; records 90 seconds old are overdue. The decision itself retains its stricter expiry and is always historical evidence, not execution authorization. The view advances record age between polls and clears failed status reads. Economics failures store a degraded HOLD with null economics; snapshot or revalidation failures store no current decision. A process that times out before committing leaves the prior record to age visibly.

The read budget remains bounded by the economics model's log limits, RPC timeout, snapshot freshness and lease. The VPS client times out after 45 seconds; its service is limited to 50 seconds. An HTTP timeout does not authorize a duplicate run or a transaction.

During installation, the default Base public RPC returned error `-32016`, `over rate limit`, from the hosted runtime. The monitor now uses the verified Base Sepolia endpoint `https://base-sepolia-rpc.publicnode.com` from [PublicNode](https://base.publicnode.com/). Chain identity is still checked on every snapshot. Local CLI clients keep their original default endpoint. Canonicality reads are batched together; throttled reads produce an explicit failure without stale economics reuse or relaxed gates. Public RPC availability remains an operational dependency.

## Verification

The hosted SQL tests execute the actual generated migration and queries against SQLite, including minute deduplication, lease fencing and atomic persistence. The same read-only decision module is copied into the Site by `npm run sync:web`; local filesystem journals and broadcasting code are excluded from that monitor dependency chain. The repository passes 343 core tests plus ten timer-client tests, with three optional live tests skipped.

[Direct production API verification](evidence/hosted-return-monitor-check.json) passed: an unauthenticated application request returned 401; one of two simultaneous authenticated calls produced OBSERVED with fresh economics, the other returned SKIPPED; GET returned FRESH and the same persisted decision hash. The snapshot was Base Sepolia block 46644808. This manually triggered sample proves the hosted read/store path, not autonomous scheduling or automatic RETURN. Batched JSON-RPC reads are enabled for the Worker to reduce outbound request count; local CLI clients retain their existing default.

[Scheduler availability](evidence/hosted-scheduler-availability.json) preserves the earlier Free/Pro feature check. The current external schedule is documented in [VPS monitor operation](vps-monitor.md); it does not enable automatic RETURN execution.
