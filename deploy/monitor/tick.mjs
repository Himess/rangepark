import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const endpoint = 'https://rangepark.semihcvlk53.chatgpt.site/api/return-monitor';
const cycle = '0x37a8140b1cc6f69816fbb81bfea0803f41e141aaeca67cb8684f410a77725381';

export async function tick(credentials, fetcher = fetch, clock = () => Math.floor(Date.now() / 1000)) {
  if (!credentials || !/^[a-f0-9]{64}$/.test(credentials.monitorToken) ||
      typeof credentials.dispatchToken !== 'string' || credentials.dispatchToken.length < 20 ||
      credentials.dispatchToken.length > 8192 || /[\r\n]/.test(credentials.dispatchToken))
    return { ok: false, reason: 'INVALID_CREDENTIALS', broadcasts: 0 };
  try {
    const response = await fetcher(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${credentials.monitorToken}`, 'OAI-Sites-Authorization': `Bearer ${credentials.dispatchToken}` },
    });
    if (response.status !== 200) return { ok: false, reason: `HTTP_${response.status}`, broadcasts: 0 };
    let body;
    try { body = await response.json(); }
    catch { return { ok: false, reason: 'INVALID_RESPONSE_BODY', broadcasts: 0 }; }
    if (body?.broadcasts !== 0) return { ok: false, reason: 'INVALID_RESPONSE', broadcasts: 0 };
    if (body.status === 'SKIPPED' && body.reason === 'ALREADY_CLAIMED_MINUTE')
      return { ok: true, status: 'SKIPPED', broadcasts: 0 };
    const decision = body.decision, now = clock();
    if (body.status !== 'OBSERVED' || !['HOLD', 'RETURN'].includes(decision?.action) ||
        decision?.chainId !== 84532 || decision?.cycleId !== cycle || decision?.tokenId !== '82083' ||
        !Number.isSafeInteger(body.completedAt) || now < body.completedAt || now - body.completedAt >= 60 ||
        !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= now)
      return { ok: false, reason: 'INVALID_OR_EXPIRED_RESPONSE', broadcasts: 0 };
    return { ok: true, status: 'OBSERVED', at: body.completedAt, action: decision.action,
      block: decision.observedBlock?.number, decisionHash: decision.decisionHash, broadcasts: 0 };
  } catch (error) {
    const knownCodes = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'];
    const reason = error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT'
      : knownCodes.includes(error?.cause?.code) ? error.cause.code : 'REQUEST_FAILED';
    return { ok: false, reason, broadcasts: 0 };
  }
}

async function main() {
  let result;
  try {
    if (!process.env.CREDENTIALS_DIRECTORY) throw Error('Missing credentials');
    const credentials = JSON.parse(await readFile(join(process.env.CREDENTIALS_DIRECTORY, 'request.json'), 'utf8'));
    result = await tick(credentials);
  } catch { result = { ok: false, reason: 'CREDENTIAL_LOAD_FAILED', broadcasts: 0 }; }
  // Never log headers, credentials, raw responses or network exception text.
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
