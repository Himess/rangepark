import { CircleCheck, Download, ExternalLink } from 'lucide-react';
import proof from '@/lib/price-fixture-evidence.json';
const labels: Record<string, string> = {
  'mint-test-usdc': 'Mint test USDC from the faucet',
  'approve-test-usdc': 'Approve the bounded test budget',
  'move-test-price': 'Move the test pool into range',
  'revoke-test-usdc': 'Revoke the remaining test allowance',
};
export function PriceFixtureEvidence() {
  return (
    <section className="panel evidence-panel" style={{ marginTop: 24 }}>
      <div className="proof-heading">
        <p className="eyebrow">CONTROLLED TESTNET SCENARIO</p>
        <span className="pill">4 PUBLIC FIXTURE RECEIPTS</span>
      </div>
      <h2>Test price in range. Parked principal intact.</h2>
      <p className="muted">
        A deliberate test swap moved the pool to tick {proof.targetTick}. These
        four KeeperHub transactions prepare the RETURN scenario using faucet
        tokens. They are a test intervention, not organic market activity or
        strategy profit.
      </p>
      <div className="fork-summary">
        <div>
          <span>Test USDC used</span>
          <strong>12.099203 / 100</strong>
        </div>
        <div>
          <span>Target tick</span>
          <strong>{proof.targetTick}</strong>
        </div>
        <div>
          <span>Aave scaled shares</span>
          <strong>Unchanged</strong>
        </div>
        <div>
          <span>Remaining USDC allowance</span>
          <strong>{proof.remainingAllowance}</strong>
        </div>
      </div>
      <div className="policy-note">
        The 0.004019302920150745 test WETH received from this swap is separate
        from the parked principal. Automatic RETURN must still pass its time,
        price-history and economics checks before any withdrawal.
      </div>
      <div className="fork-timeline">
        {proof.transactions.map((tx, i) => (
          <div key={tx.hash}>
            <span className="timeline-dot">
              <CircleCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>
                {i + 14} · {labels[tx.id]}
              </strong>
              <p>
                <a
                  href={tx.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`View ${labels[tx.id]} transaction on Base Sepolia`}
                >
                  {tx.hash.slice(0, 12)}…{tx.hash.slice(-8)}{' '}
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
                <span>
                  Block {tx.block} · KeeperHub execution {tx.executionId}
                </span>
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="evidence-download">
        <a href="/evidence/testnet-price-fixture.json" download>
          <Download size={16} aria-hidden="true" /> Download test scenario proof
        </a>
        <span>{proof.completedAt.slice(0, 10)} · Testnet receipts</span>
      </div>
    </section>
  );
}
