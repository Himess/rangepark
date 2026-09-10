import { cp, mkdir } from "node:fs/promises";
// Generated copies let the Sites project build independently from the parent checkout.
for (const part of ["chain", "config", "core", "keeperhub", "demo"]) {
  await mkdir(`apps/web/lib/rangepark/${part}`, { recursive: true });
  await cp(`src/${part}`, `apps/web/lib/rangepark/${part}`, {
    recursive: true,
  });
}
console.log("Web core synchronized from src/.");
// Only read-only testnet modules belong in the hosted monitor; never copy local
// execution journals, filesystem readers, signers, or broadcast runners.
for (const file of [
  "testnet/config.ts", "testnet/return-policy.ts", "testnet/return-reader.ts",
  "testnet/return-economics.ts", "testnet/hosted-return-monitor.ts",
  "state/hosted-return-monitor.ts",
]) {
  await mkdir(`apps/web/lib/rangepark/${file.split('/')[0]}`, { recursive: true });
  await cp(`src/${file}`, `apps/web/lib/rangepark/${file}`);
}
