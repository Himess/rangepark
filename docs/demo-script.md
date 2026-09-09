# Demo narrative — working draft

Target duration: 2 minutes 45 seconds. Use the English console. Keep the core claim narrow: **same asset while parked, same NFT when returning, explicit reasons for every move.**

## 0:00–0:20 — The problem

“Concentrated liquidity only earns swap fees inside its range. When the price leaves, the position waits in one underlying asset. RangePark gives that waiting capital a temporary job, then brings it back.”

Show the position range and the source block. Do not claim that every out-of-range position is profitable to park.

## 0:20–0:45 — Restraint is part of the product

Refresh the public sample NFT. If it is in range, explain HOLD. If it is outside, explain why one snapshot is not enough. Show the observation duration and five-minute TWAP. Name the sample as public read evidence, not our position.

“RangePark checks persistence, price agreement, lending availability and the economics. It refuses to move just because a price crossed a line.”

## 0:45–1:20 — A decision that can be inspected

Open Decision lab. Use the labelled synthetic example: 10,000 USDC, 5% supply APR, seven-day assumed horizon, two USDC round-trip cost, one USDC foregone LP fees. Evaluate and explain the 20% yield haircut and three-times cost requirement.

Raise the cost or choose Paused lending reserve. Evaluate again and show HOLD. Restore the normal scenario and open the exact draft plan.

“The parameters are frozen. The plan cannot quietly change between review and execution.”

## 1:20–2:10 — Real KeeperHub round trip

Show the Base Sepolia section of Execution evidence. Walk through the nine linked transactions: 0.001 test ETH wrap, owned NFT creation, atomic release, Aave supply, principal withdrawal and increase of the original NFT. Show NFT 82083 and the unchanged range [-196230,-196170).

“KeeperHub executed these transactions on Base Sepolia and sponsored the gas. The principal came back to the same NFT. Accrued test-token interest remained in Aave.”

Explicitly state: “This was a manual contract rehearsal while price stayed below range. It proves the integrations; it is not an automatic profitable RETURN.” Do not claim LP fee earning resumed or that a ratio swap occurred on this public testnet run.

Open a supply or restoration transaction and show its execution ID, receipt and balance evidence. These are the actual 0.001 test ETH-scale amounts; do not substitute the synthetic Decision lab capital.

## 2:10–2:35 — In-range logic and recovery

Show the guarded RETURN local-contract card: five minutes of eligible observations, six confirmed withdrawal/swap/reentry steps and the unchanged NFT/range. Explain that the ratio uses the quoted final price and that tiny wallet remainders are tracked. Explicitly identify controlled price/time, synthetic economics and simulated KeeperHub transport on a local Base Sepolia fork. The older Base-fork proof separately demonstrates an injected response timeout reconciled to its original receipt.

“A missing response does not mean the transaction failed. RangePark reconciles the existing transaction rather than submitting another one. The RETURN runner requires sustained spot/TWAP agreement and current cost inputs, then checks each stage against fresh chain state. Public automatic execution and controlled recovery after a pause are the next gates.”

If showing `testnet:return-observe`, show its actual HOLD result for the already restored NFT. Do not present the command as a continuously running scheduler. Confirm the event's accepted network and final requirements before recording the submission; testnet evidence alone does not establish eligibility.

## 2:35–2:45 — Close

“RangePark: earn fees in range, put waiting capital to work, and keep every decision accountable.”

## Recording checklist

- Use the final working deployment and the matching source commit.
- Keep secret keys, authentication screens and unrelated browser tabs out of the recording.
- Clearly label synthetic assumptions, local fork evidence and actual KeeperHub transactions.
- Make the submission repository and demo accessible to judges only when the user approves the required public audience.
- Keep emergency recovery and known limitations in the README; avoid promising risk-free yield or guaranteed profitability.
