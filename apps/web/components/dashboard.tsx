'use client';
import Link from 'next/link';
import { ArrowDownRight, ArrowRight, Layers } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PositionView } from '@/components/position-view';
import { DecisionLab } from '@/components/decision-lab';
import { EvidenceView } from '@/components/evidence-view';
import { HostedMonitorView } from '@/components/hosted-monitor-view';

export default function Dashboard() {
  return (
    <main className="workspace">
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="RangePark home">
          <span className="mark">
            <ArrowDownRight size={24} />
          </span>
          rangepark<span className="edition">/ capital console</span>
        </Link>
        <div className="header-right">
          <span className="network">
            <i /> Base / Base Sepolia
          </span>
          <span className="mode">READ & REVIEW</span>
        </div>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            UNISWAP V3 <ArrowRight size={12} /> AAVE V3
          </p>
          <h1>
            Position workspace<span>.</span>
          </h1>
          <p className="subtitle">
            A clear job for your liquidity. A record of every decision.
          </p>
        </div>
        <span className="build-badge">
          <Layers size={16} /> KeeperHub integration
        </span>
      </div>
      <Tabs defaultValue="evidence" className="main-tabs">
        <TabsList variant="line" aria-label="Workspace views">
          <TabsTrigger value="position">Position</TabsTrigger>
          <TabsTrigger value="lab">Decision lab</TabsTrigger>
          <TabsTrigger value="evidence">Execution evidence</TabsTrigger>
          <TabsTrigger value="monitor">Server monitor</TabsTrigger>
        </TabsList>
        <TabsContent value="position">
          <PositionView />
        </TabsContent>
        <TabsContent value="lab">
          <DecisionLab />
        </TabsContent>
        <TabsContent value="evidence">
          <EvidenceView />
        </TabsContent>
        <TabsContent value="monitor">
          <HostedMonitorView />
        </TabsContent>
      </Tabs>
      <footer>
        <span>RangePark · Same asset. A different job.</span>
        <span>
          Mainnet reads · Verified testnet evidence · No funds moved by this
          site
        </span>
      </footer>
    </main>
  );
}
