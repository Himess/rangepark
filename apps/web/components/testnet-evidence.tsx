import { CircleCheck, Download, ExternalLink } from 'lucide-react';
import proof from '@/lib/testnet-evidence.json';

const labels: Record<string, string> = {
  wrap: 'Wrap test ETH',
  'approve-position': 'Approve the LP principal',
  mint: 'Create NFT #82083',
  release: 'Exit liquidity and collect WETH',
  'approve-aave': 'Approve the parked principal',
  supply: 'Supply WETH to Aave',
  'withdraw-principal': 'Withdraw the supplied principal',
  'approve-restore': 'Approve the original NFT',
  'restore-original-nft': 'Restore liquidity to NFT #82083',
};

export function TestnetEvidence() {
  return (
    <section className="panel evidence-panel testnet-proof">
      <div className="proof-heading">
        <p className="eyebrow">KEEPERHUB · BASE SEPOLIA</p>
        <span className="pill good">9 PUBLIC RECEIPTS VERIFIED</span>
      </div>
      <h2>Capital returned. Same NFT. Same range.</h2>
      <p className="muted">
        A recorded testnet rehearsal: Uniswap liquidity was parked on Aave, then
        the supplied principal was restored to its original position.
      </p>
      <div className="fork-summary">
        <div>
          <span>Original NFT</span>
          <strong>#{proof.tokenId}</strong>
        </div>
        <div>
          <span>Range preserved</span>
          <strong>
            {proof.range.lower} → {proof.range.upper}
          </strong>
        </div>
        <div>
          <span>Starting capital</span>
          <strong>0.001 test WETH</strong>
        </div>
        <div>
          <span>Gas sponsor</span>
          <strong>KeeperHub</strong>
        </div>
      </div>
      <div className="policy-note">
        <strong>Manual rehearsal, not an automated RETURN.</strong> Price
        remained below the original range. Principal restoration was explicitly
        staged to verify the contract path. The guarded RETURN runner is now
        tested locally; its public testnet execution is still pending.
      </div>
      <div className="proof-outcome">
        <span>Position liquidity restored</span>
        <strong>{proof.liquidityAfter}</strong>
        <span>Accrued Aave claim retained</span>
        <strong>0.000000079 test WETH</strong>
      </div>
      <p className="proof-recorded">
        Recorded {new Date(proof.completedAt).toISOString().slice(0, 10)} ·
        Historical receipt balances, not a live portfolio valuation.
      </p>
      <div className="fork-timeline">
        {proof.transactions.map((tx, i) => (
          <div key={tx.hash}>
            <span className="timeline-dot">
              <CircleCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>
                {String(i + 1).padStart(2, '0')} · {labels[tx.id] ?? tx.id}
              </strong>
              <p>
                <a
                  href={tx.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`View ${labels[tx.id] ?? tx.id} transaction on Base Sepolia`}
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
        <a href="/evidence/testnet-lifecycle.json" download>
          <Download size={16} />
          Download all testnet evidence
        </a>
        <span>Includes calldata, balance checks and original range</span>
      </div>
    </section>
  );
}
