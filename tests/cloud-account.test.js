import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountWorkspaceKey, cloudAuthorizationHeaders, validateStorageConfig } from '../src/cloudAccount.js';
import { applicationRequest } from '../src/applicationApi.js';

const config = { storage: 'supabase', url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' };

test('storage configuration fails closed instead of treating broken cloud settings as local', () => {
  assert.deepEqual(validateStorageConfig({ storage: 'local', ignored: true }), { storage: 'local' });
  assert.deepEqual(validateStorageConfig(config), config);
  assert.deepEqual(validateStorageConfig({ storage: 'unavailable', mode: 'hosted' }), { storage: 'unavailable', mode: 'hosted' });
  for (const value of [null, {}, { storage: 'supabase' }, { ...config, url: 'http://remote.example' }, { ...config, url: 'https://user:secret@example.com' }, { ...config, url: 'https://project.supabase.co/nested' }, { ...config, publishableKey: '' }]) {
    assert.throws(() => validateStorageConfig(value));
  }
});

test('workspace identity resets across users and sign-out but stays stable on token refresh', () => {
  assert.equal(accountWorkspaceKey({ storage: 'local' }, null), 'local');
  assert.equal(accountWorkspaceKey(config, { id: 'user-a', access_token: 'first' }), accountWorkspaceKey(config, { id: 'user-a', access_token: 'refreshed' }));
  assert.notEqual(accountWorkspaceKey(config, { id: 'user-a' }), accountWorkspaceKey(config, { id: 'user-b' }));
  assert.notEqual(accountWorkspaceKey(config, { id: 'user-a' }), accountWorkspaceKey(config, null));
});

test('cloud authorization gets the latest access token and prevents a stale view using another account', async () => {
  let session = { user: { id: 'user-a' }, access_token: 'first-token' };
  const client = { auth: { getSession: async () => ({ data: { session }, error: null }) } };
  assert.deepEqual(await cloudAuthorizationHeaders(null, null), {});
  assert.deepEqual(await cloudAuthorizationHeaders(client, 'user-a'), { Authorization: 'Bearer first-token' });
  session = { ...session, access_token: 'refreshed-token' };
  assert.deepEqual(await cloudAuthorizationHeaders(client, 'user-a'), { Authorization: 'Bearer refreshed-token' });
  session = { user: { id: 'user-b' }, access_token: 'another-users-token' };
  await assert.rejects(cloudAuthorizationHeaders(client, 'user-a'), /changed or signed out/);
  session = null;
  await assert.rejects(cloudAuthorizationHeaders(client, 'user-a'), /changed or signed out/);
  await assert.rejects(cloudAuthorizationHeaders(client, null), /Sign in/);
});

test('anonymous and failed SDK sessions cannot authorize a cloud request', async () => {
  const anonymous = { auth: { getSession: async () => ({ data: { session: { user: { id: 'anonymous', is_anonymous: true }, access_token: 'anon-token' } } }) } };
  await assert.rejects(cloudAuthorizationHeaders(anonymous, 'anonymous'), /changed or signed out/);
  const failed = { auth: { getSession: async () => ({ data: { session: null }, error: { message: 'refresh failed' } }) } };
  await assert.rejects(cloudAuthorizationHeaders(failed, 'user-a'), /could not be refreshed/);
});

test('application API sends cloud authorization and CSRF together without mutating request bodies', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ applications: [], folder: null, storage: 'supabase' }); });
  const controller = new AbortController();
  await applicationRequest('get', { id: 'application-id' }, 'csrf', { authorizeHeaders: async () => ({ Authorization: 'Bearer scoped-token' }), signal: controller.signal });
  assert.equal(calls[0].url, '/api/applications/get');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer scoped-token');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'application-id' });
  assert.equal(calls[0].options.signal, controller.signal);
  await applicationRequest('list', {}, 'csrf');
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

test('an account switch during authorization aborts before an application request is sent', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not make a network request'); });
  const controller = new AbortController();
  await assert.rejects(applicationRequest('save', {}, 'csrf', {
    signal: controller.signal,
    authorizeHeaders: async () => { controller.abort(); return { Authorization: 'Bearer stale-token' }; },
  }), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});
