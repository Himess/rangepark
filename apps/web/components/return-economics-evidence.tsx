import { Download } from 'lucide-react';
import { formatUnits } from 'viem';
import proof from '@/lib/return-economics-evidence.json';

const amount = (value: string) => formatUnits(BigInt(value), 18);

export function ReturnEconomicsEvidence() {
  return (
    <section className="panel evidence-panel" style={{ marginTop: 24 }}>
      <div className="proof-heading">
        <p className="eyebrow">OBSERVED RETURN ECONOMICS</p>
        <span className="pill">RECORDED HOLD · NO TRANSACTION</span>
      </div>
      <h2>In range does not always mean worth returning.</h2>
      <p className="muted">
        This one-hour Base Sepolia observation found no fee-generating pool
        activity. With no projected LP income to justify the return budget, the
        policy kept the allocated principal parked on Aave. The observation
        streak also needed to rebuild after a monitoring gap.
      </p>
      <div className="fork-summary">
        <div>
          <span>Projected LP fees / hour</span>
          <strong>{amount(proof.expectedFees)} test WETH</strong>
        </div>
        <div>
          <span>Conservative return budget</span>
          <strong>
            ≈ {Number(amount(proof.executionBudget)).toFixed(7)} test WETH
          </strong>
        </div>
        <div>
          <span>Observed pool events</span>
          <strong>{proof.activityCount}</strong>
        </div>
        <div>
          <span>Recorded decision</span>
          <strong>{proof.decision} · stay parked</strong>
        </div>
      </div>
      <div className="policy-note">
        <strong>A budget, not an actual charge.</strong> The estimate includes
        network execution, L1 data, operator fees and a swap-loss allowance.
        Past sponsorship is not treated as zero future cost. Historical fees are
        a conditional projection, not promised earnings.
      </div>
      <details style={{ marginTop: 16 }}>
        <summary>How the decision is supported</summary>
        <p className="muted">
          The model reconciles pool events against onchain fee-growth counters
          across blocks {proof.startBlock}–{proof.endBlock}. Known project
          transactions and owner activity are excluded. Blocks with range
          crossings, liquidity changes or a material hypothetical allocation are
          also excluded. Unidentified test actors may still exist.
        </p>
        <p className="muted">
          RETURN requires projected income after a 20% haircut to exceed three
          times the execution budget plus foregone Aave yield. Here that
          threshold was ≈ {Number(amount(proof.requiredBenefit)).toFixed(7)}{' '}
          test WETH. The full evidence includes resource assumptions and all
          exact integer inputs.
        </p>
        <p className="muted">
          A separate local contract test verified positive fee attribution for a
          smaller hypothetical allocation, then zero attribution when its
          synthetic swap was excluded. The recorded allocation was too large
          relative to that test pool for this approximation.
        </p>
        <a href="/evidence/testnet-return-economics-fork.json" download>
          Download local economics test
        </a>
      </details>
      <p className="proof-recorded">
        Recorded {proof.recordedAt.replace('T', ' ').replace('.000Z', ' UTC')}.
        This is historical evidence. Execution requires a fresh quote and fresh
        policy checks; this page does not refresh or submit transactions.
      </p>
      <div className="evidence-download">
        <a href="/evidence/testnet-return-economics.json" download>
          <Download size={16} aria-hidden="true" /> Download economics and
          decision
        </a>
        <span>Read-only Base Sepolia observation</span>
      </div>
    </section>
  );
}
