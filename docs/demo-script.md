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

## 1:20–2:10 — The round trip and recovery

Show Execution evidence. Walk through release → exact approval → Aave supply → withdrawal → ratio swap → increase of the original NFT. Show the unchanged tick range and the local receipt list.

Show the injected response timeout and the recovered original receipt.

“A missing response does not mean an operation failed. We reconcile the existing transaction instead of sending the funds again.”

In the current build explicitly say: “This complete lifecycle was verified on a local Base fork using the real protocol contracts.” Do not suggest KeeperHub executed these local transactions.

## 2:10–2:35 — KeeperHub proof, required before submission

Replace this placeholder only after a real, authorized KeeperHub value-movement execution exists. Show its execution ID, transaction link, relevant token delta and final state. Identify the actual demonstration amount; do not use synthetic capital figures here.

If the execution is still missing, this section is a blocker for a qualifying final recording. API schema tests and local fork receipts do not substitute for the requested KeeperHub proof.

## 2:35–2:45 — Close

“RangePark: earn fees in range, put waiting capital to work, and keep every decision accountable.”

## Recording checklist

- Use the final working deployment and the matching source commit.
- Keep secret keys, authentication screens and unrelated browser tabs out of the recording.
- Clearly label synthetic assumptions, local fork evidence and actual KeeperHub transactions.
- Make the submission repository and demo accessible to judges only when the user approves the required public audience.
- Keep emergency recovery and known limitations in the README; avoid promising risk-free yield or guaranteed profitability.
