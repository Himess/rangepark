import { CircleCheck, Download, ExternalLink } from 'lucide-react';
import proof from '@/lib/testnet-evidence.json';
import oracle from '@/lib/oracle-evidence.json';
import repark from '@/lib/repark-evidence.json';

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
        <span className="pill good">13 PUBLIC RECEIPTS VERIFIED</span>
      </div>
      <h2>Same capital, parked again.</h2>
      <p className="muted">
        After completing the first round trip, KeeperHub released NFT #
        {repark.tokenId}
        again and supplied its WETH to Aave. The original NFT and range remain
        unchanged.
      </p>
      <div className="proof-outcome">
        <span>Latest recorded allocation</span>
        <strong>Aave · {repark.principal} wei WETH</strong>
        <span>Original NFT liquidity</span>
        <strong>0 · awaiting RETURN conditions</strong>
      </div>
      <p className="proof-recorded">
        Recorded {repark.completedAt.replace('T', ' ').replace('.000Z', ' UTC')}{' '}
        · Block {repark.block}. Receipt snapshot, not a live portfolio
        valuation.
      </p>
      <div className="policy-note">
        Only the WETH collected from the NFT belongs to this new allocation.
        Previous Aave interest and the wallet’s separate balance were preserved.
        Automatic RETURN still requires price history, time in range, cooldown
        and current economics.
      </div>
      <div className="fork-timeline">
        {repark.transactions.map((tx, i) => (
          <div key={tx.hash}>
            <span className="timeline-dot">
              <CircleCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>
                {i + 11} · {labels[tx.id] ?? tx.id}
              </strong>
              <p>
                <a
                  href={tx.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`View new cycle ${labels[tx.id]} transaction on Base Sepolia`}
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
        <a href="/evidence/testnet-repark.json" download>
          <Download size={16} aria-hidden="true" /> Download new cycle proof
        </a>
        <span>Three verified receipts · manual testnet rehearsal</span>
      </div>
      <h3>Earlier round trip · receipts 1–9</h3>
      <p className="muted">
        The first rehearsal parked the principal and restored it to the original
        position.
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
        <span>Liquidity after the earlier restoration</span>
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
          Download nine lifecycle receipts
        </a>
        <span>Includes calldata, balance checks and original range</span>
      </div>
      <div className="policy-note">
        <strong>10 · Price-history preparation confirmed.</strong> KeeperHub
        reserved {oracle.capacityReserved} observation slots on the original
        pool. NFT liquidity, balances and allowances stayed unchanged. Active
        capacity was still {oracle.activeCapacity} at the receipt block;
        sufficient history must develop before automatic RETURN.{' '}
        <a href={oracle.url} target="_blank" rel="noreferrer">
          View the preparation transaction ↗
        </a>
      </div>
      <div className="evidence-download">
        <a href="/evidence/testnet-oracle-setup.json" download>
          <Download size={16} aria-hidden="true" /> Download oracle preparation
          proof
        </a>
        <span>
          Block {oracle.block} · KeeperHub execution {oracle.executionId}
        </span>
      </div>
    </section>
  );
}
