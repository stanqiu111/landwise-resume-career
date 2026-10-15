import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIAdmission, rateLimitError, retryDelaySeconds } from '../server/ai-rate-limit.js';

test('retry delays honor seconds, dates and milliseconds without shortening provider guidance', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(retryDelaySeconds(new Headers({ 'Retry-After': '90.1' }), now), 91);
  assert.equal(retryDelaySeconds(new Headers({ 'Retry-After': 'Thu, 15 Oct 2026 12:03:00 GMT' }), now), 180);
  assert.equal(retryDelaySeconds({ 'retry-after-ms': '1501' }, now), 2);
  for (const value of ['bad', '-50', 'Infinity']) assert.equal(retryDelaySeconds({ 'retry-after': value }, now), 60);
  assert.equal(retryDelaySeconds(), 60);
});

test('overlap protection and cooldown are shared across tabs but isolated by authenticated account', () => {
  let now = 100000;
  const guard = createAIAdmission({ requireSession: () => {}, getStatus: req => ({ account: { id: req.testIdentity } }) }, () => now);
  const first = { testIdentity: 'one' };
  const second = { testIdentity: 'one' };
  const other = { testIdentity: 'two' };
  const release = guard.acquire(first);
  assert.throws(() => guard.acquire(second), { status: 409, code: 'ai_request_in_progress' });
  guard.acquire(other)();
  guard.record(first, rateLimitError(90));
  release();
  assert.throws(() => guard.acquire(second), { retryAfterSeconds: 90 });
  guard.acquire(other)();
  now += 89900;
  assert.throws(() => guard.acquire(second), { retryAfterSeconds: 1 });
  guard.record(second, rateLimitError(1));
  now += 100;
  guard.acquire({ testIdentity: 'one' })();
});

test('plan allowance failures do not become a misleading temporary cooldown', () => {
  const guard = createAIAdmission({ getStatus: () => ({ account: { id: 'one' } }) });
  const req = {};
  guard.acquire(req)();
  guard.record(req, { status: 429, code: 'subscription_sharing_usage_limit_exceeded' });
  guard.acquire({})();
});
