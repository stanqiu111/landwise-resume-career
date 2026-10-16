import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCloudStorage, cloudStorageFromEnvironment } from '../server/cloud-storage.js';
import { createLandwiseApp } from '../server.js';

const url = 'https://example.supabase.co';
const publishableKey = 'sb_publishable_test';
const userId = '11111111-1111-4111-8111-111111111111';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${encode({ alg: 'RS256' })}.${encode({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.testsignature`;
const user = { id: userId, is_anonymous: false, confirmed_at: '2026-10-01T00:00:00Z' };
const request = authorization => ({ headers: { authorization }, body: { user_id: 'attacker-chosen-owner' }, aiSignal: new AbortController().signal });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('storage defaults to local and cloud configuration fails closed on missing or privileged keys', () => {
  assert.equal(cloudStorageFromEnvironment({}), null);
  assert.throws(() => cloudStorageFromEnvironment({ LANDWISE_APPLICATION_STORAGE: 'oops' }));
  assert.throws(() => cloudStorageFromEnvironment({ LANDWISE_APPLICATION_STORAGE: 'supabase' }));
  for (const key of ['sb_secret_private', `${encode({ alg: 'HS256' })}.${encode({ role: 'service_role' })}.signature`, '', undefined]) {
    assert.throws(() => createCloudStorage({ url, publishableKey: key }));
  }
  assert.throws(() => createCloudStorage({ url: 'http://example.supabase.co', publishableKey }));
  const storage = createCloudStorage({ url, publishableKey });
  assert.deepEqual(storage.publicConfig, { storage: 'supabase', url, publishableKey });
});

test('server verifies the bearer token with Supabase and forwards only that token to owner-scoped RPCs', async () => {
  const seen = [];
  const storage = createCloudStorage({ url, publishableKey, fetchImpl: async (address, options) => {
    seen.push({ address, options });
    return json(address.endsWith('/auth/v1/user') ? user : { applications: [] });
  } });
  const req = request(`Bearer ${token}`);
  const [store, same] = await Promise.all([storage.forRequest(req), storage.forRequest(req)]);
  assert.equal(store, same);
  await store.list();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].address, `${url}/auth/v1/user`);
  assert.equal(seen[1].address, `${url}/rest/v1/rpc/landwise_application_list`);
  for (const call of seen) {
    assert.equal(new Headers(call.options.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(new Headers(call.options.headers).get('apikey'), publishableKey);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.ok(!seen[1].options.body.includes('attacker-chosen-owner'));
});

test('missing, rejected, anonymous, unconfirmed or mismatched identities cannot access storage', async () => {
  let calls = 0;
  const storage = createCloudStorage({ url, publishableKey, fetchImpl: async () => { calls++; return json(user); } });
  for (const header of [undefined, 'Bearer arbitrary', `Basic ${token}`]) {
    await assert.rejects(storage.forRequest(request(header)), error => error.code === 'cloud_sign_in_required');
  }
  assert.equal(calls, 0);
  for (const response of [json({}, 401), json({}, 403), json({ ...user, is_anonymous: true }), json({ ...user, confirmed_at: null }), json({ ...user, id: '22222222-2222-4222-8222-222222222222' })]) {
    const denied = createCloudStorage({ url, publishableKey, fetchImpl: async () => response });
    await assert.rejects(denied.forRequest(request(`Bearer ${token}`)), error => error.status === 401);
  }
});

test('auth outages fail before storage access without leaking upstream data', async () => {
  for (const fetchImpl of [async () => json({ message: 'private upstream detail' }, 500), async () => { throw new Error('private upstream detail'); }]) {
    const storage = createCloudStorage({ url, publishableKey, fetchImpl });
    await assert.rejects(storage.forRequest(request(`Bearer ${token}`)), error => error.status === 503 && !error.message.includes('private'));
  }
});

test('cloud API requires verified Landwise identity before AI, PDF or library work and never falls back locally', async t => {
  let aiCalls = 0, localCalls = 0;
  const ownedId = '33333333-3333-4333-8333-333333333333';
  const cloudStorage = createCloudStorage({ url, publishableKey, fetchImpl: async address => json(address.endsWith('/auth/v1/user') ? user : { applications: [{ id: ownedId }] }) });
  const app = createLandwiseApp({
    auth: { router: express.Router(), requireSession: req => {
      if (req.headers['x-csrf-token'] !== 'test-csrf') throw Object.assign(new Error('Reload Landwise.'), { status: 403, code: 'invalid_csrf' });
      return {};
    }, getStatus: () => ({ account: { id: 'selected' } }) },
    inference: { getClient: () => { aiCalls++; throw new Error('unexpected'); } }, cloudStorage,
    applications: { list: () => { localCalls++; return { applications: [{ id: 'local-private' }] }; } }, log: () => {},
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(`${base}/api/storage/config`);
  assert.deepEqual(await config.json(), cloudStorage.publicConfig);
  for (const path of ['/api/applications/list', '/api/applications/save', '/api/transform', '/api/revise', '/api/analyze-resume', '/api/parse-pdf']) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5174', 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }, body: '{}' });
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).code, 'cloud_sign_in_required');
  }
  const authenticated = { Origin: 'http://127.0.0.1:5174', Authorization: `Bearer ${token}` };
  const rejectedUpload = await fetch(`${base}/api/parse-pdf`, { method: 'POST', headers: authenticated, body: new FormData() });
  assert.equal(rejectedUpload.status, 403);
  assert.equal((await rejectedUpload.json()).code, 'invalid_csrf');
  const allowedUpload = await fetch(`${base}/api/parse-pdf`, { method: 'POST', headers: { ...authenticated, 'X-CSRF-Token': 'test-csrf' }, body: new FormData() });
  assert.equal(allowedUpload.status, 400);
  assert.equal((await allowedUpload.json()).error, 'No PDF file uploaded.'); // Reaches the parser only with both identities.
  const ownLibrary = await fetch(`${base}/api/applications/list`, { method: 'POST', headers: { ...authenticated, 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }, body: '{"user_id":"someone-else"}' });
  assert.equal(ownLibrary.status, 200);
  assert.deepEqual((await ownLibrary.json()).applications, [{ id: ownedId }]);
  assert.equal(aiCalls, 0);
  assert.equal(localCalls, 0);
});
