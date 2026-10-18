import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedSecurity } from '../server/hosted-security.js';

const appOrigin = 'https://landwise.example';
const sessionSecret = 'synthetic-session-secret-at-least-32-bytes';
const userId = '11111111-1111-4111-8111-111111111111';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims = {}) => `${encode({ alg: 'RS256' })}.${encode({ sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.synthetic_signature`;
const response = () => {
  const headers = new Map();
  return { setHeader: (name, value) => headers.set(name.toLowerCase(), value), getHeader: (name) => headers.get(name.toLowerCase()) };
};
const create = (options = {}) => createHostedSecurity({ appOrigin, sessionSecret, production: true, ...options });
function mint(security, headers = {}) {
  const req = { headers, socket: { remoteAddress: '203.0.113.2' } };
  const res = response();
  const result = security.session(req, res);
  const cookie = res.getHeader('set-cookie')?.split(';')[0];
  return { req, res, result, cookie };
}
function mutation(cookie, csrfToken, overrides = {}) {
  return { headers: { origin: appOrigin, cookie, 'x-csrf-token': csrfToken, ...overrides } };
}

test('configuration fails closed for public HTTP, non-origin URLs and short secrets', () => {
  for (const origin of [undefined, 'http://landwise.example', `${appOrigin}/`, `${appOrigin}/path`, `${appOrigin}?q=x`, 'https://user:password@landwise.example']) {
    assert.throws(() => create({ appOrigin: origin }), /origin/);
  }
  for (const secret of [undefined, '', 'x'.repeat(31), ' '.repeat(32), Buffer.alloc(31)]) {
    assert.throws(() => create({ sessionSecret: secret }), /32 bytes/);
  }
  assert.throws(() => create({ appOrigin: 'http://127.0.0.1:5174' }), /origin/);
  assert.doesNotThrow(() => create({ appOrigin: 'http://127.0.0.1:5174', production: false }));
  assert.throws(() => create({ trustVercel: 'yes' }), /configuration/);
});

test('guest session mints signed host cookie with secure attributes and separate opaque hashes', () => {
  const security = create();
  const first = mint(security);
  const header = first.res.getHeader('Set-Cookie');
  assert.match(header, /^__Host-landwise_guest=v1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43};/);
  assert.match(header, /; Path=\//);
  assert.match(header, /; HttpOnly/);
  assert.match(header, /; SameSite=Lax/);
  assert.match(header, /; Max-Age=31536000/);
  assert.match(header, /; Secure$/);
  assert.doesNotMatch(header, /Domain=/i);
  assert.match(first.result.guestHash, /^[0-9a-f]{64}$/);
  assert.match(first.result.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.result.guestHash, first.result.csrfToken);
  assert.equal(first.res.getHeader('cache-control'), 'no-store');
  assert.deepEqual(security.session(first.req, first.res), first.result);
  assert.equal(first.res.getHeader('set-cookie'), header);
  const secondResponse = response();
  const repeated = security.session({ headers: { cookie: first.cookie } }, secondResponse);
  assert.deepEqual(repeated, first.result);
  assert.equal(secondResponse.getHeader('set-cookie'), undefined);
  assert.deepEqual(create().session({ headers: { cookie: first.cookie } }, response()), first.result);
  assert.notEqual(mint(security).result.guestHash, first.result.guestHash);
});

test('local guest cookie omits production-only prefix and secure attribute', () => {
  const local = mint(create({ appOrigin: 'http://127.0.0.1:5174', production: false }));
  assert.match(local.res.getHeader('set-cookie'), /^landwise_guest=/);
  assert.doesNotMatch(local.res.getHeader('set-cookie'), /; Secure/);
});

test('valid mutation requires exact origin, signed cookie and matching CSRF', () => {
  const security = create();
  const { cookie, result } = mint(security);
  assert.deepEqual(security.requireMutation(mutation(cookie, result.csrfToken), response()), result);
  for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: `${appOrigin}/` }, { origin: 'https://attacker.example' }]) {
    assert.throws(() => security.requireMutation(mutation(cookie, result.csrfToken, headers), response()), { status: 403, code: 'invalid_origin' });
  }
  for (const csrf of [undefined, '', 'wrong', 'é'.repeat(43), [result.csrfToken]]) {
    assert.throws(() => security.requireMutation(mutation(cookie, csrf), response()), { status: 403, code: 'invalid_csrf' });
  }
  const another = mint(security);
  assert.throws(() => security.requireMutation(mutation(cookie, another.result.csrfToken), response()), { code: 'invalid_csrf' });
});

test('missing, modified and duplicate guest cookies never mint during a mutation', () => {
  const security = create();
  const first = mint(security);
  const tampered = `${first.cookie.slice(0, -1)}${first.cookie.endsWith('A') ? 'B' : 'A'}`;
  for (const cookie of [undefined, '', tampered, `${first.cookie}; ${first.cookie}`, first.cookie.replace('v1.', 'v2.'), `__Host-landwise_guest=${'a'.repeat(17000)}`]) {
    const res = response();
    assert.throws(() => security.requireMutation(mutation(cookie, first.result.csrfToken), res), { status: 401, code: 'session_required' });
    assert.equal(res.getHeader('set-cookie'), undefined);
  }
  const req = { headers: { origin: appOrigin } };
  const res = response();
  const freshlyMinted = security.session(req, res);
  req.headers['x-csrf-token'] = freshlyMinted.csrfToken;
  assert.throws(() => security.requireMutation(req, res), { code: 'session_required' });
});

test('GET repairs malformed cookies, rejects expired or future signed timestamps, and survives replica restarts', () => {
  let now = Date.now();
  const security = create({ now: () => now });
  const first = mint(security);
  const rotated = create({ sessionSecret: 'a-new-synthetic-secret-at-least-32-bytes', now: () => now });
  assert.throws(() => rotated.requireMutation(mutation(first.cookie, first.result.csrfToken), response()), { code: 'session_required' });
  assert.ok(mint(rotated, { cookie: first.cookie }).cookie);
  now += 365 * 24 * 60 * 60 * 1000;
  assert.throws(() => security.requireMutation(mutation(first.cookie, first.result.csrfToken), response()), { code: 'session_required' });
  const repaired = mint(security, { cookie: first.cookie });
  assert.ok(repaired.cookie);
  assert.notEqual(repaired.result.guestHash, first.result.guestHash);
  now -= (365 * 24 * 60 * 60 + 120) * 1000;
  assert.throws(() => security.requireMutation(mutation(first.cookie, first.result.csrfToken), response()), { code: 'session_required' });
});

test('guest cookie scope separates different origins and preserves other response cookies', () => {
  const security = create();
  const req = { headers: {} };
  const res = response();
  res.setHeader('Set-Cookie', 'another_cookie=value; HttpOnly');
  security.session(req, res);
  assert.equal(res.getHeader('set-cookie').length, 2);
  const first = mint(security);
  const other = create({ appOrigin: 'https://another.example' });
  assert.throws(() => other.requireMutation(mutation(first.cookie, first.result.csrfToken, { origin: 'https://another.example' }), response()), { code: 'session_required' });
});

test('optional actor is anonymous only when Authorization is absent', async () => {
  let calls = 0;
  const security = create({ cloudStorage: { forRequest: async () => { calls += 1; throw Object.assign(new Error('Private upstream details'), { status: 401 }); } } });
  assert.deepEqual(await security.actor({ headers: {} }), {});
  assert.equal(calls, 0);
  await assert.rejects(security.actor({ headers: {} }, { required: true }), { status: 401, code: 'cloud_sign_in_required' });
  for (const authorization of ['', null, 'Bearer bad', 'Basic invalid', `Bearer ${jwt()}`]) {
    await assert.rejects(security.actor({ headers: { authorization } }), (error) => {
      assert.equal(error.code, 'cloud_sign_in_required');
      assert.doesNotMatch(error.message, /Private upstream/);
      return true;
    });
  }
  assert.equal(calls, 5);
});

test('actor identity is decoded only after verification and ignores all client ownership fields', async () => {
  const store = { list: async () => [] };
  let verified = 0;
  const security = create({ cloudStorage: { forRequest: async () => { verified += 1; return store; } } });
  const req = { headers: { authorization: `Bearer ${jwt()}` }, body: { userId: 'attacker', user_id: 'attacker' } };
  const [first, second] = await Promise.all([security.actor(req), security.actor(req, { required: true })]);
  assert.deepEqual(first, { userId, store });
  assert.equal(second, first);
  assert.equal(verified, 1);
  await assert.rejects(security.actor({ headers: { authorization: 'Bearer malformed' } }), { code: 'cloud_sign_in_required' });
  assert.equal(verified, 2); // Verification path ran before decoding untrusted claims.
});

test('actor rejects expired, malformed, privileged and missing identities even after an adapter returns', async () => {
  const security = create({ cloudStorage: { forRequest: async () => ({}) } });
  for (const claims of [{ sub: 'arbitrary-owner' }, { role: 'service_role' }, { exp: 0 }, { exp: '9999999999' }, { sub: null }]) {
    await assert.rejects(security.actor({ headers: { authorization: `Bearer ${jwt(claims)}` } }), { code: 'cloud_sign_in_required' });
  }
  await assert.rejects(security.actor({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }), { code: 'cloud_sign_in_required' });
});

test('failed account verification never falls back to guest and never exposes upstream errors', async () => {
  const req = { headers: { authorization: `Bearer ${jwt()}` } };
  await assert.rejects(create().actor(req), { status: 503, code: 'cloud_auth_unavailable' });
  const security = create({ cloudStorage: { forRequest: async () => { throw new Error('Private upstream token and database details'); } } });
  await assert.rejects(security.actor(req), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /Private upstream|database details/);
    return true;
  });
});

test('changing bearer headers while verification is pending cannot switch actors', async () => {
  let release;
  const security = create({ cloudStorage: { forRequest: () => new Promise((resolve) => { release = () => resolve({}); }) } });
  const req = { headers: { authorization: `Bearer ${jwt()}` } };
  const operation = security.actor(req);
  req.headers.authorization = `Bearer ${jwt({ sub: '22222222-2222-4222-8222-222222222222' })}`;
  release();
  await assert.rejects(operation, { code: 'cloud_sign_in_required' });
});

test('IP hashing ignores untrusted forwarded headers and normalizes IPv4-mapped and equivalent IPv6 forms', () => {
  const security = create();
  const expected = security.ipHash({ socket: { remoteAddress: '203.0.113.2' } });
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(security.ipHash({ socket: { remoteAddress: '203.0.113.2' }, headers: { 'x-vercel-forwarded-for': '198.51.100.9', 'x-forwarded-for': '198.51.100.8' } }), expected);
  assert.equal(security.ipHash({ socket: { remoteAddress: '::ffff:203.0.113.2' } }), expected);
  assert.equal(security.ipHash({ socket: { remoteAddress: '::ffff:cb00:7102' } }), expected);
  assert.equal(security.ipHash({ socket: { remoteAddress: '2001:db8::1' } }), security.ipHash({ socket: { remoteAddress: '2001:0DB8:0000:0000:0000:0000:0000:0001' } }));
  assert.notEqual(expected, create({ sessionSecret: 'different-server-secret-at-least32-bytes' }).ipHash({ socket: { remoteAddress: '203.0.113.2' } }));
});

test('trusted Vercel IP mode uses only its single valid address and fails closed without it', () => {
  const security = create({ trustVercel: true });
  const request = { headers: { 'x-vercel-forwarded-for': '203.0.113.2', 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(security.ipHash(request), create().ipHash({ socket: { remoteAddress: '203.0.113.2' } }));
  for (const address of [undefined, '', '203.0.113.2, 198.51.100.9', ['203.0.113.2'], 'host.example', '127.0.0.1:1234', 'fe80::1%lo0', '203.0.113.999']) {
    assert.throws(() => security.ipHash({ headers: { 'x-vercel-forwarded-for': address }, socket: { remoteAddress: '127.0.0.1' } }), { status: 503, code: 'client_address_unavailable' });
  }
  assert.throws(() => create().ipHash({ headers: { 'x-vercel-forwarded-for': '203.0.113.2' } }), { code: 'client_address_unavailable' });
});
