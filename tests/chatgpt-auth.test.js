import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createChatGPTAuth } from '../server/chatgpt-auth.js';

const ISSUER = 'https://auth.openai.com';
const FULL_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
const jwks = createLocalJWKSet({ keys: [publicJwk] });

async function fixture(t, settings = {}) {
  const storageDir = settings.storageDir || await mkdtemp(path.join(tmpdir(), 'landwise-auth-test-'));
  let time = Date.now();
  const app = express();
  app.use(express.json());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const providerCalls = [];
  const options = { nonce: null, subject: 'person-one', scope: FULL_SCOPE, expiresIn: 3600, identity: {}, ...settings.provider };
  let refreshCount = 0;
  let revokeCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const parameters = init.body ? Object.fromEntries(init.body) : {};
    providerCalls.push({ url, parameters });
    if (String(url).endsWith('openid-configuration')) {
      return Response.json({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/oauth/revoke` });
    }
    if (String(url).endsWith('/oauth/revoke')) {
      revokeCount += 1;
      if (options.revocationError) return new Response('', { status: options.revocationError });
      return new Response('', { status: 200 });
    }
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`);
    if (options.networkError) throw new Error('Private provider connection details');
    if (parameters.grant_type === 'refresh_token') {
      refreshCount += 1;
      if (options.refreshGate) await options.refreshGate;
      if (options.refreshError) return Response.json({ error: options.refreshError }, { status: options.refreshStatus || 400, headers: options.refreshHeaders });
      return Response.json({ access_token: `access-rotated-${refreshCount}`, refresh_token: `refresh-rotated-${refreshCount}`,
        token_type: 'Bearer', expires_in: 3600, ...(options.refreshScope === undefined ? {} : { scope: options.refreshScope }) });
    }
    if (options.exchangeError) return Response.json({ error: options.exchangeError }, { status: 400 });
    const nonce = options.nonce;
    if (options.exchangeStarted) options.exchangeStarted();
    if (options.exchangeGate) await options.exchangeGate;
    const claims = { sub: options.subject, iss: ISSUER, aud: parameters.client_id, nonce,
      iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600,
      email: 'student@example.test', name: 'Student', ...options.identity };
    let idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
    if (options.invalidSignature) idToken = `${idToken.slice(0, idToken.lastIndexOf('.') + 1)}${'A'.repeat(342)}`;
    return Response.json({ id_token: idToken, access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer',
      expires_in: options.expiresIn, scope: options.scope });
  };
  const auth = await createChatGPTAuth({ appOrigin: origin, port, storageDir, fetchImpl, jwks, now: () => time, sleep: async () => {} });
  app.use(auth.router);
  const credentialFile = path.join(storageDir, 'chatgpt.json');
  let finished = false;
  const stop = async () => {
    if (finished) return;
    finished = true;
    await new Promise((resolve) => server.close(resolve));
    await auth.close();
  };
  t.after(async () => { await stop(); if (!settings.storageDir) await rm(storageDir, { recursive: true, force: true }); });

  async function browser() {
    const sessionResponse = await fetch(`${origin}/api/auth/session`);
    const initial = await sessionResponse.json();
    const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
    const csrf = initial.csrfToken;
    const request = (pathname, { method = 'GET', body, headers = {}, omitCookie = false } = {}) => fetch(`${origin}${pathname}`, {
      method, redirect: 'manual', headers: { ...(omitCookie ? {} : { cookie }),
        ...(method !== 'GET' ? { origin, 'x-csrf-token': csrf, 'content-type': 'application/json' } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const status = async () => (await request('/api/auth/session')).json();
    const start = async (profileId) => {
      const response = await request('/api/auth/chatgpt/start', { method: 'POST', body: profileId ? { profileId } : {} });
      assert.equal(response.status, 200);
      const { authorizationUrl } = await response.json();
      const localUrl = new URL(authorizationUrl);
      assert.equal(localUrl.origin, origin);
      assert.equal(localUrl.searchParams.has('id_token_hint'), false);
      const redirect = await request(`${localUrl.pathname}${localUrl.search}`);
      assert.equal(redirect.status, 303);
      const authorization = new URL(redirect.headers.get('location'));
      options.nonce = authorization.searchParams.get('nonce');
      return authorization;
    };
    const callback = (authorization, parameters = {}) => request(`/auth/callback?${new URLSearchParams({
      code: 'test-code', state: authorization.searchParams.get('state'), client_id: 'oaiapp_one', ...parameters,
    })}`);
    const req = () => ({ headers: { cookie, origin, 'x-csrf-token': csrf } });
    return { initial, cookie, csrf, request, status, start, callback, req };
  }
  return { auth, origin, port, storageDir, credentialFile, options, providerCalls, browser, stop,
    advance: (milliseconds) => { time += milliseconds; },
    refreshCount: () => refreshCount, revokeCount: () => revokeCount };
}

async function connect(h, clientId = 'oaiapp_one', browser) {
  const b = browser || await h.browser();
  const authorization = await b.start();
  const callback = await b.callback(authorization, { client_id: clientId });
  assert.equal(callback.status, 200, await callback.text());
  return b;
}

test('local OAuth requires an explicit 127.0.0.1 HTTP origin', async () => {
  for (const appOrigin of ['https://landwise.example', 'http://localhost:5174', 'http://127.0.0.1:5174/path', 'https://127.0.0.1:5174']) {
    await assert.rejects(createChatGPTAuth({ appOrigin }), /127\.0\.0\.1/);
  }
});

test('starts without credentials, uses protected persistent host storage, and locks one process', async (t) => {
  const h = await fixture(t);
  const b = await h.browser();
  assert.equal(b.initial.connected, false);
  assert.deepEqual(b.initial.accounts, []);
  assert.ok(b.csrf);
  assert.equal((await stat(h.storageDir)).mode & 0o777, 0o700);
  assert.equal((await stat(h.credentialFile)).mode & 0o777, 0o600);
  const before = JSON.parse(await readFile(h.credentialFile, 'utf8'));
  await assert.rejects(createChatGPTAuth({ appOrigin: h.origin, port: h.port, storageDir: h.storageDir }), /another process/);
  await h.stop();
  const again = await createChatGPTAuth({ appOrigin: h.origin, port: h.port, storageDir: h.storageDir, jwks });
  assert.equal(JSON.parse(await readFile(h.credentialFile, 'utf8')).hostId, before.hostId);
  await again.close();
});

test('new sign-in uses dynamic registration, PKCE, state, nonce, and one-use callbacks', async (t) => {
  const h = await fixture(t);
  const b = await h.browser();
  const a = await b.start();
  assert.equal(a.origin, ISSUER);
  assert.equal(a.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(a.searchParams.get('agent_name_hint'), 'Landwise');
  assert.equal(a.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(a.searchParams.get('scope'), FULL_SCOPE);
  assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(a.searchParams.get('redirect_uri'), `${h.origin}/auth/callback`);
  assert.notEqual(a.searchParams.get('state'), a.searchParams.get('nonce'));
  const response = await b.callback(a);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Connected to ChatGPT/);
  assert.doesNotMatch(html, /access-secret|refresh-secret|test-code|id_token/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const exchange = h.providerCalls.find((entry) => entry.parameters.grant_type === 'authorization_code').parameters;
  assert.equal(exchange.client_id, 'oaiapp_one');
  assert.equal(exchange.redirect_uri, a.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), a.searchParams.get('code_challenge'));
  assert.equal(exchange.client_secret, undefined);
  assert.equal((await b.callback(a)).status, 400);
  const status = await b.status();
  assert.equal(status.connected, true);
  assert.equal(status.sharing, true);
  assert.equal(status.account.email, 'student@example.test');
  assert.equal(status.accounts.length, 1);
  assert.equal(status.connectionRevision, 1);
  assert.doesNotMatch(JSON.stringify(status), /access-secret|refresh-secret|id_token|client_id/);
  assert.equal(await h.auth.getAccessToken(b.req()), 'access-secret');
});

test('rejects cross-origin, missing CSRF, missing session, DNS rebinding, and foreign callbacks', async (t) => {
  const h = await fixture(t);
  const b = await h.browser();
  const start = '/api/auth/chatgpt/start';
  assert.equal((await b.request(start, { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await b.request(start, { method: 'POST', body: {}, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await b.request(start, { method: 'POST', body: {}, omitCookie: true })).status, 401);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${h.origin}/api/auth/session`, { headers: { host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(reboundStatus, 403);
  const a = await b.start();
  const stranger = await h.browser();
  assert.equal((await stranger.callback(a)).status, 400);
  assert.equal(h.providerCalls.length, 0);
  assert.equal((await b.callback(a)).status, 200);
});

test('missing, expired, mismatched, and declined callbacks never exchange authorization codes', async (t) => {
  for (const scenario of ['mismatch', 'expired', 'declined', 'missing-client', 'dynamic-client', 'no-code']) {
    await t.test(scenario, async (t) => {
      const h = await fixture(t);
      const b = await h.browser();
      const a = await b.start();
      const parameters = {};
      if (scenario === 'mismatch') parameters.state = 'incorrect';
      if (scenario === 'expired') h.advance(11 * 60 * 1000);
      if (scenario === 'declined') parameters.error = 'access_denied';
      if (scenario === 'missing-client') parameters.client_id = '';
      if (scenario === 'dynamic-client') parameters.client_id = 'dynamic_agent_client';
      if (scenario === 'no-code') parameters.code = '';
      assert.equal((await b.callback(a, parameters)).status, 400);
      assert.equal(h.providerCalls.length, 0);
      assert.equal((await b.callback(a)).status, 400);
    });
  }
});

test('ID token signature, issuer, audience, expiry, nonce, and returning subject are verified', async (t) => {
  const scenarios = [
    { identity: { iss: 'https://attacker.example' } },
    { identity: { aud: 'different-client' } },
    { identity: { exp: 1000 } },
    { identity: { nonce: 'wrong-nonce' } },
    { identity: { sub: '' } },
    { invalidSignature: true },
  ];
  for (const [index, provider] of scenarios.entries()) {
    await t.test(`identity case ${index}`, async (t) => {
      const h = await fixture(t, { provider });
      const b = await h.browser();
      assert.equal((await b.callback(await b.start())).status, 401);
      const status = await b.status();
      assert.equal(status.accounts.length, 1);
      assert.equal(status.accounts[0].connected, false);
      assert.equal(status.account, null);
    });
  }
  await t.test('returning identity cannot replace another account', async (t) => {
    const h = await fixture(t);
    const b = await connect(h);
    const accountId = (await b.status()).account.id;
    const a = await b.start(accountId);
    h.options.subject = 'different-person';
    assert.equal((await b.callback(a)).status, 401);
    assert.equal(await h.auth.getAccessToken(b.req()), 'access-secret');
    assert.equal(JSON.parse(await readFile(h.credentialFile)).profiles[0].subject, 'person-one');
  });
});

test('saved accounts remain separate and returning sign-in reuses client and host without browser JSON credentials', async (t) => {
  const h = await fixture(t);
  const b = await connect(h);
  const first = (await b.status()).account;
  h.options.subject = 'person-two';
  const a2 = await b.start();
  assert.equal((await b.callback(a2, { client_id: 'oaiapp_two' })).status, 200);
  const second = (await b.status()).account;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.label, second.label);
  assert.equal(first.email, second.email);
  const stranger = await h.browser();
  assert.equal(stranger.initial.connected, false);
  assert.equal(stranger.initial.account, null);
  assert.equal(stranger.initial.accounts.length, 2);
  await assert.rejects(h.auth.getAccessToken(stranger.req()), { code: 'chatgpt_signin_required' });
  const selected = await b.request('/api/auth/chatgpt/select', { method: 'POST', body: { profileId: first.id } });
  assert.equal((await selected.json()).account.id, first.id);
  const returning = await b.start(first.id);
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_one');
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
  assert.equal(returning.searchParams.get('login_hint'), first.email);
  assert.ok(returning.searchParams.get('id_token_hint'));
  assert.equal(returning.searchParams.get('ext_agent_host_id'), a2.searchParams.get('ext_agent_host_id'));
  assert.equal((await b.callback(returning, { client_id: 'oaiapp_two' })).status, 400);
});

test('identity-only consent stays signed in but never enables inference, and explicit retry requests consent', async (t) => {
  const h = await fixture(t, { provider: { scope: 'openid profile email' } });
  const b = await connect(h);
  const status = await b.status();
  assert.equal(status.connected, true);
  assert.equal(status.sharing, false);
  await assert.rejects(h.auth.getAccessToken(b.req()), { status: 403, code: 'chatgpt_plan_permission_required' });
  const retry = await b.start(status.account.id);
  assert.equal(retry.searchParams.get('prompt'), 'consent');
  assert.match(retry.searchParams.get('scope'), /chatgpt.tokens.use.direct/);
});

test('refresh is serialized, rotates credentials atomically, retains scopes, and pins the request account', async (t) => {
  const h = await fixture(t, { provider: { expiresIn: 30 } });
  const b = await connect(h);
  const req = b.req();
  const results = await Promise.all([h.auth.getAccessToken(req), h.auth.getAccessToken(b.req()), h.auth.getAccessToken(b.req())]);
  assert.deepEqual(results, ['access-rotated-1', 'access-rotated-1', 'access-rotated-1']);
  assert.equal(h.refreshCount(), 1);
  const stored = JSON.parse(await readFile(h.credentialFile, 'utf8')).profiles[0];
  assert.equal(stored.access_token, 'access-rotated-1');
  assert.equal(stored.refresh_token, 'refresh-rotated-1');
  assert.ok(stored.scopes.includes('chatgpt.tokens.use.direct'));
  const refresh = h.providerCalls.find((entry) => entry.parameters.grant_type === 'refresh_token').parameters;
  assert.equal(refresh.client_id, 'oaiapp_one');
  assert.equal(refresh.refresh_token, 'refresh-secret');
  assert.equal(refresh.scope, undefined);
  await b.request('/api/auth/chatgpt/select', { method: 'POST', body: { profileId: stored.id } });
  await assert.rejects(h.auth.getAccessToken(req), { code: 'chatgpt_account_changed' });
});

test('terminal refresh errors clear tokens but temporary errors preserve credentials', async (t) => {
  for (const temporary of [false, true]) {
    await t.test(temporary ? 'temporary outage' : 'unusable refresh', async (t) => {
      const h = await fixture(t, { provider: { expiresIn: 30, refreshError: temporary ? 'server_error' : 'invalid_grant', refreshStatus: temporary ? 503 : 400 } });
      const b = await connect(h);
      await assert.rejects(h.auth.getAccessToken(b.req()), { code: temporary ? 'server_error' : 'invalid_grant' });
      const stored = JSON.parse(await readFile(h.credentialFile, 'utf8')).profiles[0];
      assert.equal(Boolean(stored.refresh_token), temporary);
      assert.equal(stored.client_id, 'oaiapp_one');
      assert.equal((await b.status()).connected, temporary);
    });
  }
});

test('rate-limited credential refresh preserves the connection and retry guidance', async t => {
  const h = await fixture(t, { provider: { expiresIn: 30, refreshError: 'rate_limit_exceeded', refreshStatus: 429, refreshHeaders: { 'retry-after': '95' } } });
  const b = await connect(h);
  await assert.rejects(h.auth.getAccessToken(b.req()), { status: 429, code: 'chatgpt_rate_limited', retryAfterSeconds: 95 });
  assert.equal((await b.status()).connected, true);
  assert.equal(h.refreshCount(), 1);
});

test('account changes during refresh reject the running request', async (t) => {
  const h = await fixture(t, { provider: { expiresIn: 30 } });
  const b = await connect(h);
  let release;
  h.options.refreshGate = new Promise((resolve) => { release = resolve; });
  const request = h.auth.getAccessToken(b.req());
  // Selecting even the same account creates a new explicit connection context.
  await b.request('/api/auth/chatgpt/select', { method: 'POST', body: { profileId: (await b.status()).account.id } });
  release();
  await assert.rejects(request, { code: 'chatgpt_account_changed' });
});

test('signout revokes refresh tokens, retains registration, removes ID hints, and invalidates other sessions', async (t) => {
  const h = await fixture(t);
  const b = await connect(h);
  const before = JSON.parse(await readFile(h.credentialFile, 'utf8'));
  const other = await h.browser();
  await other.request('/api/auth/chatgpt/select', { method: 'POST', body: { profileId: before.profiles[0].id } });
  const response = await b.request('/api/auth/chatgpt/signout', { method: 'POST', body: {} });
  const status = await response.json();
  assert.equal(status.connected, false);
  assert.equal(status.remoteRevocationConfirmed, true);
  assert.equal(h.revokeCount(), 1);
  assert.equal((await other.status()).connected, false);
  const after = JSON.parse(await readFile(h.credentialFile, 'utf8'));
  assert.equal(after.hostId, before.hostId);
  assert.equal(after.profiles[0].client_id, before.profiles[0].client_id);
  assert.equal(after.profiles[0].access_token, undefined);
  assert.equal(after.profiles[0].refresh_token, undefined);
  assert.equal(after.profiles[0].id_token, undefined);
  const returning = await b.start(after.profiles[0].id);
  assert.equal(returning.searchParams.get('client_id'), 'oaiapp_one');
  assert.equal(returning.searchParams.has('id_token_hint'), false);
});

test('failed remote revocation retries then clears locally with an honest warning', async (t) => {
  const h = await fixture(t, { provider: { revocationError: 503 } });
  const b = await connect(h);
  const response = await b.request('/api/auth/chatgpt/signout', { method: 'POST', body: {} });
  const status = await response.json();
  assert.equal(status.remoteRevocationConfirmed, false);
  assert.match(status.warning, /Remote revocation could not be confirmed/);
  assert.equal(h.revokeCount(), 3);
  assert.equal(status.connected, false);
  assert.equal(JSON.parse(await readFile(h.credentialFile, 'utf8')).profiles[0].refresh_token, undefined);
});

test('failed exchange retains issued registration and retries it without creating another client', async (t) => {
  const h = await fixture(t, { provider: { exchangeError: 'invalid_grant' } });
  const b = await h.browser();
  const first = await b.start();
  assert.equal((await b.callback(first)).status, 401);
  const failed = await b.status();
  assert.equal(failed.account, null);
  assert.equal(failed.accounts.length, 1);
  assert.equal(failed.accounts[0].connected, false);
  const saved = JSON.parse(await readFile(h.credentialFile, 'utf8')).profiles[0];
  assert.equal(saved.client_id, 'oaiapp_one');
  assert.equal(saved.subject, null);
  assert.equal(saved.access_token, undefined);
  const retry = await b.start(failed.accounts[0].id);
  assert.equal(retry.searchParams.get('client_id'), 'oaiapp_one');
  assert.equal(retry.searchParams.has('agent_name_hint'), false);
  assert.equal(retry.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  h.options.exchangeError = null;
  assert.equal((await b.callback(retry)).status, 200);
  const recovered = await b.status();
  assert.equal(recovered.accounts.length, 1);
  assert.equal(recovered.account.id, saved.id);
  assert.equal(recovered.connected, true);
});

test('callbacks overtaken by signout, a new sign-in, or account selection never reactivate credentials', async (t) => {
  for (const action of ['signout', 'new-signin', 'select']) {
    await t.test(action, async (t) => {
      const h = await fixture(t);
      const b = await connect(h);
      const before = await b.status();
      const authorization = await b.start(before.account.id);
      let release;
      h.options.exchangeGate = new Promise((resolve) => { release = resolve; });
      const exchangeStarted = new Promise((resolve) => { h.options.exchangeStarted = resolve; });
      const callback = b.callback(authorization);
      await exchangeStarted;
      if (action === 'signout') await b.request('/api/auth/chatgpt/signout', { method: 'POST', body: {} });
      if (action === 'select') await b.request('/api/auth/chatgpt/select', { method: 'POST', body: { profileId: before.account.id } });
      if (action === 'new-signin') await b.start();
      release();
      const response = await callback;
      assert.equal(response.status, 409);
      assert.match(await response.text(), /cancelled by a newer account action/);
      const after = await b.status();
      assert.equal(after.connectionRevision, before.connectionRevision);
      assert.equal(after.connected, action !== 'signout');
      assert.ok(h.revokeCount() >= 1);
      const record = JSON.parse(await readFile(h.credentialFile, 'utf8')).profiles[0];
      assert.equal(Boolean(record.refresh_token), action !== 'signout');
    });
  }
});

test('successful same-account reauthorization changes the completion revision', async (t) => {
  const h = await fixture(t);
  const b = await connect(h);
  const before = await b.status();
  const a = await b.start(before.account.id);
  assert.equal((await b.callback(a)).status, 200);
  const after = await b.status();
  assert.equal(after.account.id, before.account.id);
  assert.equal(after.connectionRevision, before.connectionRevision + 1);
});
