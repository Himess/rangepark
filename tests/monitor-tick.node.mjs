import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, tick } from '../deploy/monitor/tick.mjs';

const credentials = { monitorToken: 'a'.repeat(64), dispatchToken: 'b'.repeat(40) };
const body = () => ({ status: 'OBSERVED', broadcasts: 0, completedAt: 1000, decision: {
  action: 'HOLD', chainId: 84532, cycleId: '0x37a8140b1cc6f69816fbb81bfea0803f41e141aaeca67cb8684f410a77725381',
  tokenId: '82083', expiresAt: 1050, observedBlock: { number: '123' }, decisionHash: '0x123',
} });
const reply = (value, status = 200) => async () => new Response(JSON.stringify(value), { status });
test('uses only the fixed private endpoint and cannot follow credential redirects', async () => {
  const result = await tick(credentials, async (url, request) => {
    assert.equal(url, endpoint); assert.equal(request.redirect, 'error'); assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer ' + credentials.monitorToken);
    return new Response(JSON.stringify(body()));
  }, () => 1001);
  assert.equal(result.ok, true); assert.equal(result.action, 'HOLD');
  assert.ok(!JSON.stringify(result).includes(credentials.monitorToken));
});
test('recognizes deduplication without a second request', async () => {
  let count = 0;
  const result = await tick(credentials, async () => { count++; return new Response(JSON.stringify({ status: 'SKIPPED', reason: 'ALREADY_CLAIMED_MINUTE', broadcasts: 0 })); });
  assert.equal(result.ok, true); assert.equal(count, 1);
});
test('rejects malformed credentials before connecting', async () => {
  let count = 0;
  assert.equal((await tick({ ...credentials, monitorToken: 'bad' }, async () => { count++; })).ok, false);
  assert.equal(count, 0);
});
test('does not echo exception credentials or retry a failed connection', async () => {
  const result = await tick(credentials, async () => { throw Error(credentials.dispatchToken); });
  assert.deepEqual(result, { ok: false, reason: 'REQUEST_FAILED', broadcasts: 0 });
});
test('rejects an HTTP error even when its body resembles success', async () => {
  assert.equal((await tick(credentials, reply(body(), 503), () => 1001)).ok, false);
});
test('preserves HTTP status for an HTML gateway failure', async () => {
  const result = await tick(credentials, async () => new Response('<html>Unavailable</html>', { status: 502 }));
  assert.equal(result.reason, 'HTTP_502');
});
test('classifies malformed success bodies and network timeouts without raw errors', async () => {
  assert.equal((await tick(credentials, async () => new Response('invalid'))).reason, 'INVALID_RESPONSE_BODY');
  const error = Object.assign(new Error(credentials.dispatchToken), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  assert.equal((await tick(credentials, async () => { throw error; })).reason, 'UND_ERR_CONNECT_TIMEOUT');
});
test('rejects stale, future and expired observations', async () => {
  for (const now of [999, 1050, 1061]) assert.equal((await tick(credentials, reply(body()), () => now)).ok, false);
});
test('rejects wrong-chain and wrong-cycle responses', async () => {
  for (const change of [{ chainId: 8453 }, { cycleId: 'another' }, { tokenId: '999' }]) {
    const value = body(); Object.assign(value.decision, change);
    assert.equal((await tick(credentials, reply(value), () => 1001)).ok, false);
  }
});
test('a passing RETURN is logged as a review decision without any follow-up request', async () => {
  const value = body(); value.decision.action = 'RETURN'; let requests = 0;
  const result = await tick(credentials, async () => { requests++; return new Response(JSON.stringify(value)); }, () => 1001);
  assert.equal(result.action, 'RETURN'); assert.equal(requests, 1); assert.equal(result.broadcasts, 0);
});
