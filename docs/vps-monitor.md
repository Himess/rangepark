# External minute trigger

RangePark can use an existing Linux server to trigger its hosted read-only RETURN monitor. A new VPS or KeeperHub Pro subscription is not required for this path. The hosted service performs chain reads, economics and D1 persistence; the server makes one authenticated HTTPS request per minute. It does not hold a wallet key or KeeperHub execution credential.

## Installed components

- `deploy/monitor/tick.mjs`: dependency-free Node.js 22 client, fixed Site URL, cycle, NFT and chain; redirects rejected; request timeout 45 seconds; no same-run retries.
- `deploy/monitor/rangepark-monitor.service`: isolated dynamic user, read-only filesystem, private temporary directory, 128 MB memory ceiling, 10% CPU quota and 50-second service timeout.
- `deploy/monitor/rangepark-monitor.timer`: starts at second 5 of each UTC minute and is enabled across server restarts. Missed time produces one catch-up activation, not synthetic price samples.

Files reside in `/opt/rangepark-monitor` and `/etc/systemd/system`. The root-owned `/etc/rangepark-monitor/request.json` contains only `monitorToken` and `dispatchToken`, matching the application bearer secret and current Sites dispatch credential. The directory is mode 0700 and file mode 0600. systemd passes a private runtime copy through `LoadCredential`. Never put the values in this repository, command arguments, logs or unit files.

The client accepts a fresh OBSERVED result only for Base Sepolia 84532, NFT 82083 and the configured parked cycle. A passing RETURN is still a review result and causes no follow-up transaction. A failed request exits nonzero; the next scheduled minute can try again. An already claimed minute is recorded as SKIPPED. Logs contain compact status, block and decision hash only.

## Operation

After copying the three versioned files to their paths and securely provisioning the credential file, validate the units and run one manual check before enabling the timer:

```sh
systemd-analyze verify /etc/systemd/system/rangepark-monitor.service /etc/systemd/system/rangepark-monitor.timer
systemctl daemon-reload
systemctl start rangepark-monitor.service
systemctl enable --now rangepark-monitor.timer
```

Inspect without triggering another observation:

```sh
systemctl status rangepark-monitor.timer
systemctl show rangepark-monitor.service -p Result -p ExecMainStatus
journalctl -u rangepark-monitor.service --since '15 minutes ago' --no-pager
```

To stop further checks, use `systemctl disable --now rangepark-monitor.timer`; if a check is already running, stop `rangepark-monitor.service` too. This affects only RangePark. To resume, enable the timer again. On failure, check the hosted Server monitor view as well as the service result. No separate email or message alert delivery is configured.

Rotate credentials through their owning services, then replace the root-only JSON securely; the next service activation loads the new values. Changing the parked allocation requires updating both the hosted allocation record and this client's fixed cycle check, followed by validation and deployment. Never silently accept a different NFT or cycle to make a failed check pass.

## Continuity limits

This removes dependence on an awake development PC. It still depends on the existing server, network, Sites service and public RPC availability. Successful observations are retained in hosted D1 even after the short-lived client exits. Gaps over 120 seconds reset price persistence, and records older than 90 seconds appear overdue. No restart or catch-up bypasses the five-minute policy.

This installation does not change the existing application services, start an inbound port, deploy an execution runner or enable fund movement. Their process IDs remained unchanged across installation and the later continuity check.

## Recorded live validation

The [12 September evidence](evidence/vps-monitor.json) records 2,192 timer runs across approximately 36.5 hours: 2,187 OBSERVED results and five transient failures (one connection/response failure and four HTTP 503 responses). Failed checks were not hidden or replayed in a burst. The timer remained active and enabled, and its latest run succeeded.

The latest seven successful hosted records match the server's decision hashes and span at least five minutes of actual block time. Price persistence passed; the remaining reason was `RETURN_NOT_ECONOMIC`, with projected LP fees zero. Every recorded result reports zero broadcasts. The last client run used approximately 16 MB peak memory and 0.16 CPU-seconds; it exits between checks.

This is a dated runtime capture, not a promise of future uptime. Validation includes 343 core tests and ten client tests, plus the live journal/API comparison and byte hashes confirming that the installed service files match the versioned sources.
