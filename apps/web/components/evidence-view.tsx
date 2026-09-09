import { CircleCheck, Download, ShieldCheck } from 'lucide-react';
import evidence from '@/lib/fork-evidence.json';
import { TestnetEvidence } from '@/components/testnet-evidence';
const labels: Record<string, string> = {
  release: 'Exit original LP',
  approve: 'Approve parked amount',
  supply: 'Supply WETH to Aave',
  withdraw: 'Withdraw from Aave',
  'approve-swap': 'Approve ratio swap',
  swap: 'Swap into range ratio',
  'approve-lp0': 'Approve WETH for LP',
  'approve-lp1': 'Approve USDC for LP',
  increase: 'Restore original NFT',
  recovery: 'Recover the original receipt',
};
export function EvidenceView() {
  return (
    <>
      <TestnetEvidence />
      <section className="panel evidence-panel" style={{ marginTop: 24 }}>
        <p className="eyebrow">SHOW THE WORK</p>
        <h2>Local fork: in-range return and recovery.</h2>
        <p className="muted">
          Verified against real Uniswap and Aave contracts on a local copy of
          Base.
        </p>
        <div className="fork-summary">
          <div>
            <span>Original NFT restored</span>
            <strong>#{evidence.tokenId}</strong>
          </div>
          <div>
            <span>Same tick range</span>
            <strong>{evidence.originalRange.join(' → ')}</strong>
          </div>
          <div>
            <span>Transaction receipts</span>
            <strong>
              {evidence.events.filter((e) => 'transactionHash' in e).length}{' '}
              confirmed
            </strong>
          </div>
          <span className="pill good">LOCAL FORK · PASSED</span>
        </div>
        <div className="fork-timeline">
          {evidence.events.map((event, i) => (
            <div key={`${event.step}-${i}`}>
              <span className="timeline-dot">
                <CircleCheck size={17} />
              </span>
              <div>
                <strong>{labels[event.step] ?? event.step}</strong>
                {'transactionHash' in event ? (
                  <p>
                    <code>{event.transactionHash}</code>
                    <span>
                      Gas used: {Number(event.gasUsed).toLocaleString('en-US')}
                    </span>
                  </p>
                ) : (
                  <p>
                    Injected response timeout. Original receipt recovered;
                    duplicate submission refused.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="evidence-download">
          <a href="/evidence/fork-lifecycle.json" download>
            <Download size={16} /> Download complete local evidence
          </a>
          <span>
            {new Date(evidence.completedAt).toISOString().slice(0, 10)} · Forked
            at Base block {evidence.sourceBlock}
          </span>
        </div>
        <div className="policy-note">
          Test accounts were funded locally and time was advanced. These hashes
          belong to the local fork. They are not public Base transactions or
          KeeperHub execution proof.
        </div>
      </section>
      <section className="panel evidence-panel" style={{ marginTop: 24 }}>
        <h2>What each check proves.</h2>
        <div className="evidence-grid">
          <article>
            <CircleCheck />
            <h3>Mainnet reads</h3>
            <p>
              Uniswap principal, current tick and TWAP; Aave WETH and USDC
              reserves at the same Base block.
            </p>
            <a
              href="https://basescan.org/block/50998408"
              target="_blank"
              rel="noreferrer"
            >
              View recorded source block ↗
            </a>
          </article>
          <article>
            <ShieldCheck />
            <h3>Recovery journal</h3>
            <p>
              Separate withdrawal and reentry approvals. Ordered steps, position
              locking and reconciliation. A paused run stays paused after a
              receipt arrives.
            </p>
            <span className="pill good">Tested locally</span>
          </article>
          <article>
            <ShieldCheck />
            <h3>KeeperHub execution</h3>
            <p>
              Nine public Base Sepolia receipts verify funding, Uniswap exit,
              Aave supply and manual principal restoration to the same NFT.
              Automated range-triggered RETURN is still pending.
            </p>
            <span className="pill good">Testnet rehearsal verified</span>
          </article>
        </div>
      </section>
    </>
  );
}
