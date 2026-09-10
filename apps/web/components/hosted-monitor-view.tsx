'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

type Status = {
  health: string;
  ageSeconds: number | null;
  now: number;
  tokenId: string;
  report: null | {
    completedAt: number;
    status: string;
    decision: null | { action: string; reasons: string[] };
    observation?: { samples: number; since: number | null };
    economics?: { expectedLpFees: string } | null;
    errors: string[];
  };
};
const labels: Record<string, string> = {
  DISABLED: 'Paused',
  AWAITING_FIRST_SAMPLE: 'Awaiting first check',
  STALE: 'Check overdue',
  FRESH: 'Recent check received',
  DEGRADED: 'Check needs attention',
};
export function HostedMonitorView() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState(false),
    [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      setLoading(true);
      try {
        const result = await fetch('/api/return-monitor', {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
          cache: 'no-store',
        });
        if (!result.ok) throw Error('Unavailable');
        const value = (await result.json()) as Status;
        if (!controller.signal.aborted) {
          setData(value);
          setReceivedAt(Date.now());
          setClock(Date.now());
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          setData(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(read, 30000);
        }
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const report = data?.report;
  const age =
    data?.ageSeconds == null
      ? null
      : data.ageSeconds + Math.floor(Math.max(0, clock - receivedAt) / 1000);
  const health =
    data?.health === 'FRESH' && age != null && age >= 90
      ? 'STALE'
      : data?.health;
  return (
    <section className="panel evidence-panel">
      <div className="proof-heading">
        <p className="eyebrow">SERVER MONITOR · BASE SEPOLIA</p>
        <output className="pill">
          {error
            ? 'Status unavailable'
            : data
              ? (labels[health ?? ''] ?? 'Unknown status')
              : 'Loading status'}
        </output>
      </div>
      <h2>Every check leaves a record.</h2>
      <p className="muted">
        The server checks the recorded NFT and saves its price history and
        economics together. This monitor cannot move funds. An external
        scheduler is required for unattended checks.
      </p>
      <div className="fork-summary">
        <div>
          <span>Recorded NFT</span>
          <strong>#{data?.tokenId ?? '82083'}</strong>
        </div>
        <div>
          <span>Last check</span>
          <strong>
            {age != null ? `${Math.max(0, age)} seconds ago` : 'No record yet'}
          </strong>
        </div>
        <div>
          <span>Recorded decision</span>
          <strong>{report?.decision?.action ?? 'No decision'}</strong>
        </div>
        <div>
          <span>Price observations</span>
          <strong>{report?.observation?.samples ?? 0}</strong>
        </div>
      </div>
      {report?.decision && (
        <p className="policy-note">
          {report.decision.reasons
            .map(
              (reason) =>
                ({
                  RETURN_NOT_ECONOMIC:
                    'Projected fees do not justify the return budget.',
                  RETURN_PERSISTENCE_NOT_MET:
                    'Five minutes of eligible price observations are still required.',
                  RETURN_ECONOMICS_MISSING:
                    'A fresh economics estimate is unavailable.',
                })[reason] ?? reason.replaceAll('_', ' ').toLowerCase(),
            )
            .join(' ')}
        </p>
      )}
      {(health === 'STALE' || health === 'DISABLED') && (
        <p className="policy-note">
          The saved decision is historical. It does not establish current
          eligibility or confirm that a scheduler is running.
        </p>
      )}
      <div className="evidence-download">
        <Button
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh status
        </Button>
        <span>Refreshing reads saved records; it does not start a check.</span>
      </div>
    </section>
  );
}
