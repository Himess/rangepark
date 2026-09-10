import { env } from 'cloudflare:workers';
import { HostedReturnMonitorStore } from '@/lib/rangepark/state/hosted-return-monitor';
import type { ParkedLot } from '@/lib/rangepark/testnet/return-policy';
import allocation from '@/lib/hosted-monitor-allocation.json';

export const monitoredLot: ParkedLot = {
  ...allocation.lot,
  chainId: 84532,
  status: 'PARKED',
  tokenId: BigInt(allocation.lot.tokenId),
  principal: BigInt(allocation.lot.principal),
} as ParkedLot;
export const excludedHashes = new Set(
  allocation.excludedHashes.map((hash) => hash.toLowerCase()),
);
export function hostedMonitorStore() {
  if (!env.DB) throw Error('Monitor storage unavailable');
  return new HostedReturnMonitorStore(env.DB, monitoredLot.cycleId);
}
export function monitorEnabled() {
  return env.RETURN_MONITOR_ENABLED === 'true';
}
export function monitorToken() {
  return env.RETURN_MONITOR_TOKEN;
}
