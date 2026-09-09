import { CircleCheck, Download } from 'lucide-react';
import { formatUnits } from 'viem';
import proof from '@/lib/return-runner-evidence.json';

const residualWeth = formatUnits(BigInt(proof.residual.amount0), 18);
const residualUsdc = formatUnits(BigInt(proof.residual.amount1), 6);

const labels: Record<string, string> = {
  withdraw: 'Withdraw the parked principal',
  'approve-swap': 'Approve the exact swap amount',
  swap: 'Swap using the quoted final price',
  'approve-lp0': 'Approve the remaining WETH',
  'approve-lp1': 'Approve the received USDC',
  increase: 'Refill the original NFT',
};

export function ReturnRunnerEvidence() {
  return (
    <section className="panel evidence-panel" style={{ marginTop: 24 }}>
      <div className="proof-heading">
        <p className="eyebrow">RETURN RUNNER · LOCAL CONTRACT TEST</p>
        <span className="pill good">6 STEPS VERIFIED LOCALLY</span>
      </div>
      <h2>The guarded RETURN path works end to end.</h2>
      <p className="muted">
        After five minutes of eligible spot and TWAP observations, the runner
        withdrew WETH, swapped with a price limit and restored the original NFT.
        Each step used the previous transaction’s verified result.
      </p>
      <div className="fork-summary">
        <div>
          <span>Original NFT restored</span>
          <strong>#{proof.tokenId}</strong>
        </div>
        <div>
          <span>Range preserved</span>
          <strong>{proof.range.join(' → ')}</strong>
        </div>
        <div>
          <span>Final tick, inside range</span>
          <strong>{proof.tick}</strong>
        </div>
        <div>
          <span>Oracle history capacity</span>
          <strong>{proof.policy.oracleCapacity} observations</strong>
        </div>
      </div>
      <div className="policy-note">
        <strong>Local Base Sepolia fork with synthetic economics.</strong> Real
        protocol contracts were exercised through a simulated KeeperHub
        transport. Accounts, price movement and time were controlled locally.
        Public testnet execution of this automatic RETURN runner remains to be
        verified.
      </div>
      <details>
        <summary>Inspect the six local transaction receipts</summary>
        <div className="fork-timeline">
          {proof.steps.map((step) => (
            <div key={step.hash}>
              <span className="timeline-dot">
                <CircleCheck size={18} aria-hidden="true" />
              </span>
              <div>
                <strong>{labels[step.id] ?? step.id}</strong>
                <p>
                  <code>{step.hash}</code>
                  <span>Local block {step.block}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </details>
      <p className="proof-recorded">
        Unallocated strategy remainder: {residualWeth} test WETH
        {' · '}
        {residualUsdc} Aave test USDC. These balances remain in the wallet and
        are included in the evidence.
      </p>
      <div className="evidence-download">
        <a href="/evidence/testnet-return-fork.json" download>
          <Download size={16} aria-hidden="true" /> Download guarded RETURN test
        </a>
        <span>Local fork of Base Sepolia block {proof.sourceBlock}</span>
      </div>
      <div className="policy-note">
        <strong>
          Recovery tested: two pauses, still only six transactions.
        </strong>{' '}
        A separate local run deliberately expired the swap and reentry phases
        after their approvals. The runner rechecked confirmed receipts and
        refreshed the remaining calls, preserving the same NFT and range.{' '}
        <a href="/evidence/testnet-return-recovery-fork.json" download>
          Download the local recovery proof
        </a>
        .
      </div>
    </section>
  );
}
