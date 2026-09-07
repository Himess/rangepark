import { cp, mkdir } from "node:fs/promises";
// Generated copies let the Sites project build independently from the parent checkout.
for (const part of ["chain", "config", "core", "keeperhub", "demo"]) {
  await mkdir(`apps/web/lib/rangepark/${part}`, { recursive: true });
  await cp(`src/${part}`, `apps/web/lib/rangepark/${part}`, {
    recursive: true,
  });
}
console.log("Web core synchronized from src/.");
