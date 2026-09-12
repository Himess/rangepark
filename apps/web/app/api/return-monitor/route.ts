import { response } from '@/lib/api';
import {
  excludedHashes,
  hostedMonitorStore,
  monitoredLot,
  monitorEnabled,
  monitorToken,
} from '@/lib/hosted-monitor';
import {
  authorizedMonitorRequest,
  hostedReturnTick,
} from '@/lib/rangepark/testnet/hosted-return-monitor';
import { defaultReturnPolicy } from '@/lib/rangepark/testnet/return-policy';
import {
  readReturnSnapshot,
  testnetReturnClient,
} from '@/lib/rangepark/testnet/return-reader';
import { readEconomicsEvidence } from '@/lib/rangepark/testnet/return-economics';

export async function GET() {
  try {
    const row = await hostedMonitorStore().get();
    const now = Math.floor(Date.now() / 1000),
      age = row?.updated_at ? now - row.updated_at : null;
    const report = row?.report ? JSON.parse(row.report) : null;
    const health = !monitorEnabled()
      ? 'DISABLED'
      : age === null
        ? 'AWAITING_FIRST_SAMPLE'
        : age < 0 || age >= 90
          ? 'STALE'
          : report?.status === 'OBSERVED'
            ? 'FRESH'
            : 'DEGRADED';
    return response({
      mode: 'HOSTED_READ_ONLY_RETURN_MONITOR',
      health,
      ageSeconds: age,
      now,
      tokenId: monitoredLot.tokenId.toString(),
      report,
      recent: row ? JSON.parse(row.recent) : [],
      broadcasts: 0,
    });
  } catch {
    return response({ error: 'Monitor status unavailable' }, 503);
  }
}

export async function POST(request: Request) {
  if (
    !(await authorizedMonitorRequest(
      request.headers.get('authorization'),
      monitorToken(),
    ))
  )
    return response({ error: 'Unauthorized' }, 401);
  if (!monitorEnabled()) return response({ error: 'Monitor disabled' }, 503);
  try {
    const client = testnetReturnClient(true, 'https://base-sepolia-rpc.publicnode.com');
    const report = await hostedReturnTick({
      store: hostedMonitorStore(),
      lot: monitoredLot,
      snapshot: () =>
        readReturnSnapshot(client, monitoredLot, defaultReturnPolicy),
      economics: (snapshot) =>
        readEconomicsEvidence(
          client,
          snapshot,
          defaultReturnPolicy,
          excludedHashes,
        ),
      blockHash: async (number) =>
        (await client.getBlock({ blockNumber: number })).hash,
      clock: () => Math.floor(Date.now() / 1000),
    });
    return response(report, report.status === 'DEGRADED' ? 503 : 200);
  } catch {
    return response(
      {
        error: 'Monitor sample not committed; retry on the next minute',
        broadcasts: 0,
      },
      503,
    );
  }
}
