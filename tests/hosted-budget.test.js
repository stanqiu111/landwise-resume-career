import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedBudget } from '../server/hosted-budget.js';

const id = '11111111-1111-4111-8111-111111111111';
const config = { url: 'https://example.supabase.co', serviceRoleKey: 'sb_secret_private_test' };
const guest = 'a'.repeat(64);
const ip = 'b'.repeat(64);
const input = 'c'.repeat(64);
const receipt = { jobId: id, status: 'reserved', admitted: true, reservedCostMicrousd: 60000 };
const request = { requestId: id, guestHash: guest, ipHash: ip, inputHash: input, maxCostMicrousd: 60000 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('server-only adapter uses exact RPCs and preserves actor-bound idempotency/cost arguments', async () => {
  const calls = [];
  const replies = [{ guestEligible: true, remaining: 1, available: true }, receipt,
    { ...receipt, status: 'completed', admitted: false }, { ...receipt, status: 'failed', admitted: false }, true];
  const budget = createHostedBudget({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return response(replies[calls.length - 1]);
  } });
  await budget.status({ guestHash: guest });
  assert.equal((await budget.reserve(request)).admitted, true);
  await budget.complete({ jobId: id, actualCostMicrousd: 12000, result: { output: 'draft' } });
  await budget.fail({ jobId: id });
  assert.equal(await budget.acquireUpload({ guestHash: guest, ipHash: ip }), true);
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['landwise_ai_status', 'landwise_ai_reserve', 'landwise_ai_complete', 'landwise_ai_fail', 'landwise_upload_acquire']);
  assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: null, p_guest_hash: guest, p_request_id: id, p_ip_hash: ip,
    p_input_hash: input, p_max_cost_microusd: 60000, p_operation: 'transform' });
  assert.equal(JSON.parse(calls[2].body).p_actual_cost_microusd, 12000);
  assert.equal(JSON.parse(calls[3].body).p_actual_cost_microusd, null);
  for (const call of calls) {
    assert.equal(call.headers.apikey, config.serviceRoleKey);
    assert.equal(call.headers.Authorization, `Bearer ${config.serviceRoleKey}`);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test('unsafe keys, malformed identity/hash/cost requests never reach the network', async () => {
  for (const serviceRoleKey of [undefined, 'sb_publishable_public', 'opaque', '']) assert.throws(() => createHostedBudget({ ...config, serviceRoleKey }));
  for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com/path']) assert.throws(() => createHostedBudget({ ...config, url }));
  let calls = 0;
  const budget = createHostedBudget({ ...config, fetchImpl: async () => { calls++; return response(receipt); } });
  for (const bad of [{}, { ...request, userId: id }, { ...request, ipHash: 'raw IP' }, { ...request, inputHash: 'resume text' },
    { ...request, maxCostMicrousd: -1 }, { ...request, maxCostMicrousd: 4000001 }]) await assert.rejects(budget.reserve(bad), error => error.code === 'invalid_hosted_request');
  await assert.rejects(budget.complete({ jobId: id, actualCostMicrousd: -1 }), error => error.code === 'invalid_hosted_request');
  await assert.rejects(budget.status({}), error => error.code === 'invalid_hosted_request');
  await assert.rejects(budget.acquireUpload({ guestHash: guest, ipHash: 'plaintext' }), error => error.code === 'invalid_hosted_request');
  assert.equal(calls, 0);
});

test('oversized recovery result still settles success with bounded payload and no caller abort signal', async () => {
  let sent;
  const budget = createHostedBudget({ ...config, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body); return response({ ...receipt, status: 'completed', admitted: false, resultUnavailable: true });
  } });
  const result = await budget.complete({ jobId: id, result: { text: 'é'.repeat(120000) } });
  assert.equal(sent.p_result, null);
  assert.equal(sent.p_actual_cost_microusd, null);
  assert.equal(result.status, 'completed');
});

test('only whitelisted budget failures are exposed; provider details and service credentials stay private', async () => {
  const cases = [
    ['landwise_ai_busy', 409, 'hosted_ai_busy'], ['landwise_ai_budget_limit', 429, 'hosted_ai_budget_limit'],
    ['landwise_ai_allowance_used', 429, 'hosted_ai_allowance_used'], ['landwise_ai_daily_limit', 429, 'hosted_ai_daily_limit'],
    ['landwise_ai_monthly_limit', 429, 'hosted_ai_monthly_limit'], ['landwise_ai_ip_limit', 429, 'hosted_ai_ip_limit'],
    ['landwise_ai_idempotency_conflict', 409, 'hosted_ai_idempotency_conflict'], ['landwise_ai_sign_in_required', 401, 'cloud_sign_in_required'],
    ['landwise_upload_limit', 429, 'upload_limit'], ['private SQL detail', 503, 'hosted_budget_unavailable'],
  ];
  for (const [details, status, code] of cases) {
    let calls = 0;
    const budget = createHostedBudget({ ...config, fetchImpl: async () => {
      calls++; return response({ code: 'P0001', details, message: `PRIVATE ${config.serviceRoleKey}` }, 400);
    } });
    await assert.rejects(budget.reserve(request), error => error.status === status && error.code === code
      && !error.message.includes(config.serviceRoleKey) && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('unconfirmed network/JSON/admission responses fail closed without automatic retries', async () => {
  for (const behavior of [async () => { throw new Error('secret'); }, async () => new Response('<html>private</html>'), async () => response({ admitted: true })]) {
    let calls = 0;
    const budget = createHostedBudget({ ...config, fetchImpl: async () => { calls++; return behavior(); } });
    await assert.rejects(budget.reserve(request), error => error.status === 503 && error.code === 'hosted_budget_unavailable');
    assert.equal(calls, 1);
  }
});
