import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSupabaseApplicationStore } from '../server/supabase-applications.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = 1800000000000;
function jwt(claims = {}, header = { alg: 'RS256' }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode({ sub: USER_A, role: 'authenticated', exp: NOW / 1000 + 60, ...claims })}.signature`;
}
const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test_key', accessToken: jwt(), now: () => NOW };
const inputs = {
  resume: 'Original resume', jobDescription: 'Northstar seeks a frontend engineer.', maxPages: 1,
  result: { transformedResume: 'Revised resume', matchScore: 62, job: { company: 'Northstar', roleTitle: 'Frontend engineer' },
    report: { items: [{ id: 'r1', requirement: 'Cloud', status: 'learn', nextStep: 'Build a deployment demo.' }] } },
};
const summary = { id: APP_ID, company: 'Northstar', roleTitle: 'Frontend engineer', stage: 'resume', versionCount: 1, score: 62, practiceDone: 0, practiceTotal: 1 };
const document = { ...summary, versions: [{ id: VERSION_ID, ...inputs }], practice: [{ id: 'task', title: 'Cloud: Build a deployment demo.', done: false }], notes: '', history: [] };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const storeWith = (fetchImpl, extra = {}) => createSupabaseApplicationStore({ ...config, fetchImpl, ...extra });

test('CRUD uses fixed owner-scoped RPCs and preserves application and version data', async () => {
  const calls = [];
  const replies = [
    { applications: [summary] }, document, { ...summary, versionId: VERSION_ID },
    { ...document, company: 'Northstar Canada', stage: 'interview' }, { removed: true },
  ];
  const store = storeWith(async (url, options) => {
    calls.push({ url, ...options, args: JSON.parse(options.body) });
    return response(replies[calls.length - 1]);
  });
  assert.deepEqual(await store.list(), { applications: [summary], storage: 'supabase', folder: null });
  assert.deepEqual(await store.get(APP_ID), { ...document, storage: 'supabase', folder: null });
  assert.deepEqual(await store.save(inputs), { ...summary, versionId: VERSION_ID, storage: 'supabase', folder: null });
  const updated = await store.update(APP_ID, { company: '  Northstar Canada  ', stage: 'interview' });
  assert.equal(updated.stage, 'interview');
  assert.deepEqual(updated.versions, document.versions);
  assert.deepEqual(await store.remove(APP_ID), { removed: true });
  assert.deepEqual(calls.map(call => call.url), ['list', 'get', 'save', 'update', 'remove'].map(name => `${config.url}/rest/v1/rpc/landwise_application_${name}`));
  assert.deepEqual(calls.map(call => call.args), [
    {}, { p_id: APP_ID }, { p_inputs: inputs }, { p_id: APP_ID, p_patch: { company: 'Northstar Canada', stage: 'interview' } }, { p_id: APP_ID },
  ]);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.apikey, config.publishableKey);
    assert.equal(call.headers.Authorization, `Bearer ${config.accessToken}`);
    assert.equal(call.redirect, 'error');
    assert.equal(call.cache, 'no-store');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(Object.hasOwn(call.args, 'user_id'), false);
  }
});

test('only public project keys and authenticated end-user JWTs are accepted', () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ applications: [] }); };
  for (const accessToken of [undefined, '', 'opaque-token', `Bearer ${jwt()}`, jwt({ role: 'anon' }), jwt({ role: 'service_role' }),
    jwt({ sub: '' }), jwt({ sub: 'not-a-user-id' }), jwt({ exp: undefined }), jwt({ exp: NOW / 1000 }), jwt({}, { alg: 'none' }), jwt({}, { alg: '' })]) {
    assert.throws(() => storeWith(fetchImpl, { accessToken }), error => error.status === 401 && error.code === 'cloud_sign_in_required');
  }
  for (const publishableKey of [undefined, '', 'sb_secret_do_not_send', jwt({ role: 'service_role' }), jwt()]) {
    assert.throws(() => storeWith(fetchImpl, { publishableKey }), error => error.status === 503);
  }
  for (const url of [undefined, 'not-a-url', 'http://example.supabase.co', 'https://secret@example.supabase.co', 'https://example.supabase.co/rest/v1', 'https://example.supabase.co?secret=token']) {
    assert.throws(() => storeWith(fetchImpl, { url }), error => error.status === 503 && !error.message.includes('token'));
  }
  assert.equal(calls, 0);
});

test('legacy anon project keys and loopback Supabase development URLs remain supported', async () => {
  const publishableKey = jwt({ role: 'anon', sub: undefined });
  const store = storeWith(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:54321/rest/v1/rpc/landwise_application_list');
    assert.equal(options.headers.apikey, publishableKey);
    assert.equal(options.headers.Authorization, `Bearer ${config.accessToken}`);
    return response({ applications: [] });
  }, { url: 'http://127.0.0.1:54321/', publishableKey });
  assert.deepEqual((await store.list()).applications, []);
});

test('overlapping users and saves retain their own JWT and payload with one atomic RPC each', async () => {
  const pending = [];
  const fetchImpl = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const tokenB = jwt({ sub: USER_B });
  const storeA = storeWith(fetchImpl);
  const storeB = storeWith(fetchImpl, { accessToken: tokenB });
  const changed = { ...inputs, result: { ...inputs.result, transformedResume: 'A second revision' } };
  const saving = [storeA.save(inputs), storeB.save(inputs), storeA.save(changed)];
  assert.equal(pending.length, 3, 'the adapter must not read snapshots or use a process-local write queue');
  assert.deepEqual(pending.map(call => call.options.headers.Authorization), [`Bearer ${config.accessToken}`, `Bearer ${tokenB}`, `Bearer ${config.accessToken}`]);
  assert.deepEqual(pending.map(call => JSON.parse(call.options.body)), [{ p_inputs: inputs }, { p_inputs: inputs }, { p_inputs: changed }]);
  pending[2].resolve(response({ ...summary, versionId: VERSION_ID, versionCount: 2 }));
  pending[1].resolve(response({ ...summary, id: USER_B, versionId: VERSION_ID }));
  pending[0].resolve(response({ ...summary, versionId: VERSION_ID }));
  const [first, other, last] = await Promise.all(saving);
  assert.equal(first.id, APP_ID);
  assert.equal(other.id, USER_B);
  assert.equal(last.versionCount, 2);
});

test('invalid IDs, ownership injection, patches and oversized snapshots never reach the network', async () => {
  let calls = 0;
  const store = storeWith(async () => { calls++; return response({}); });
  for (const id of ['../outside', `${APP_ID}/extra`, undefined]) {
    await assert.rejects(store.get(id), error => error.status === 400);
    await assert.rejects(store.update(id, {}), error => error.status === 400);
    await assert.rejects(store.remove(id), error => error.status === 400);
  }
  for (const patch of [{ user_id: USER_B }, { versions: [] }, { stage: 'unknown' }, { notes: 'x'.repeat(12001) }, { practice: [{ id: '1', title: 'Learn', done: 'yes' }] }]) {
    await assert.rejects(store.update(APP_ID, patch), error => error.status === 400);
  }
  for (const value of [{ ...inputs, user_id: USER_B }, { ...inputs, resume: ' \n' }, { ...inputs, maxPages: 0 }, { ...inputs, maxPages: 1.5 },
    { ...inputs, maxPages: 21 }, { ...inputs, maxPages: undefined }, { ...inputs, result: { transformedResume: '' } },
    { ...inputs, result: { ...inputs.result, extra: 'x'.repeat(220000) } }]) {
    await assert.rejects(store.save(value), error => error.status === 400);
  }
  const circular = { ...inputs.result };
  circular.self = circular;
  await assert.rejects(store.save({ ...inputs, result: circular }), error => error.status === 400);
  assert.equal(calls, 0);
});

test('owner-scoped misses and remote errors are mapped without leaking provider details or retrying', async t => {
  const cases = [
    [401, 'invalid_token', 401, 'cloud_sign_in_required'], [400, 'PGRST301', 401, 'cloud_sign_in_required'],
    [404, 'P0002', 404, 'application_error'], [403, '42501', 403, 'application_error'], [400, '22023', 400, 'application_error'],
    [409, 'conflict', 409, 'application_error'], [500, '40001', 409, 'application_error'],
    [429, 'rate_limited', 429, 'application_storage_busy'], [404, 'PGRST202', 502, 'cloud_application_error'],
    [500, 'XX000', 502, 'cloud_application_error'],
  ];
  for (const [status, code, expectedStatus, expectedCode] of cases) await t.test(`${status} ${code}`, async () => {
    let calls = 0;
    const store = storeWith(async () => {
      calls++;
      return response({ code, message: `PRIVATE-SQL ${config.accessToken}`, details: config.url }, status);
    });
    await assert.rejects(store.get(APP_ID), error => error.status === expectedStatus && error.code === expectedCode
      && !error.message.includes('PRIVATE-SQL') && !error.message.includes(config.accessToken) && !error.message.includes(config.url));
    assert.equal(calls, 1);
  });
});

test('network failures, invalid JSON and malformed success responses are sanitized', async () => {
  const variants = [
    async () => { throw new Error(`PRIVATE-NETWORK ${config.accessToken}`); },
    async () => new Response('<html>PRIVATE-PROXY</html>', { status: 502 }),
    async () => new Response('not json', { status: 200 }),
    async () => response([{ applications: [] }]),
    async () => response({ applications: [{ id: 'invalid' }] }),
  ];
  for (const fetchImpl of variants) {
    await assert.rejects(storeWith(fetchImpl).list(), error => error.status === 502 && error.code === 'cloud_application_error' && !error.message.includes('PRIVATE'));
  }
  await assert.rejects(storeWith(async () => response(summary)).get(APP_ID), error => error.status === 502);
  await assert.rejects(storeWith(async () => response(summary)).save(inputs), error => error.status === 502);
  await assert.rejects(storeWith(async () => response({ removed: false })).remove(APP_ID), error => error.status === 502);
});

test('only recognized database quota tags become fixed storage-limit messages', async () => {
  const limits = [
    ['landwise_application_limit', /50-application/],
    ['landwise_version_limit', /10-version/],
    ['landwise_user_storage_limit', /5 MiB/],
    ['landwise_global_storage_limit', /Cloud storage is currently full/],
    ['landwise_history_limit', /100-event/],
  ];
  for (const [details, wording] of limits) {
    let calls = 0;
    const store = storeWith(async () => {
      calls++;
      return response({ code: 'P0001', details, message: `PRIVATE-SQL ${config.accessToken}` }, 400);
    });
    await assert.rejects(store.save(inputs), error => error.status === 409 && error.code === 'storage_limit'
      && wording.test(error.message) && !error.message.includes('PRIVATE-SQL') && !error.message.includes(config.accessToken));
    assert.equal(calls, 1);
  }
  for (const details of ['not-a-quota', 'constructor', '__proto__', 'landwise_user_storage_limit PRIVATE-SQL', { tag: 'landwise_user_storage_limit' }]) {
    const store = storeWith(async () => response({ code: 'P0001', details, message: 'PRIVATE-SQL' }, 400));
    await assert.rejects(store.save(inputs), error => error.status === 502 && error.code === 'cloud_application_error' && !error.message.includes('PRIVATE-SQL'));
  }
  const wrongCode = storeWith(async () => response({ code: '22023', details: 'landwise_user_storage_limit' }, 400));
  await assert.rejects(wrongCode.save(inputs), error => error.status === 400 && error.code === 'application_error');
});

test('a token that expires after store creation is rejected before any later RPC', async () => {
  let currentTime = NOW;
  let calls = 0;
  const store = storeWith(async () => { calls++; return response({ applications: [] }); }, { now: () => currentTime });
  await store.list();
  currentTime += 60000;
  await assert.rejects(store.list(), error => error.status === 401 && error.code === 'cloud_sign_in_required');
  assert.equal(calls, 1);
});

test('caller aborts stop requests and never become a successful save or a generic storage error', async () => {
  const before = new AbortController();
  const cancelled = new Error('User cancelled');
  before.abort(cancelled);
  let calls = 0;
  const noRequest = storeWith(async () => { calls++; return response({ applications: [] }); }, { signal: before.signal });
  await assert.rejects(noRequest.list(), error => error === cancelled);
  assert.equal(calls, 0);

  const during = new AbortController();
  const store = storeWith(async (_url, options) => {
    during.abort(cancelled);
    assert.equal(options.signal.aborted, true);
    throw new Error('fetch aborted');
  }, { signal: during.signal });
  await assert.rejects(store.save(inputs), error => error === cancelled);

  const reading = new AbortController();
  const readingStore = storeWith(async () => ({ ok: true, status: 200, json: async () => {
    reading.abort(cancelled);
    return { ...summary, versionId: VERSION_ID };
  } }), { signal: reading.signal });
  await assert.rejects(readingStore.save(inputs), error => error === cancelled);
});

test('the storage deadline aborts an unresponsive RPC with a sanitized retryable error', async () => {
  let requestSignal;
  let calls = 0;
  const store = storeWith(async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    await delay(1000, null, { signal: options.signal });
    return response({ applications: [] });
  }, { timeoutMs: 10 });
  await assert.rejects(store.list(), error => error.status === 503 && error.code === 'cloud_application_error' && /took too long/.test(error.message));
  assert.equal(requestSignal.aborted, true);
  assert.equal(calls, 1);
});
