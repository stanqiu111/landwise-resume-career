import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const GUEST_TTL_SECONDS = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const signInRequired = () => fail(401, 'cloud_sign_in_required', 'Sign in to your Landwise account to continue.');

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length > 512 || right.length > 512) return false;
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function canonicalIP(value) {
  if (typeof value !== 'string' || value.length > 64 || value.includes('%')) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  // URL's IPv6 serializer makes equivalent compressed/expanded forms share a
  // budget bucket. IPv4-mapped socket addresses also share their IPv4 bucket.
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Stateless hosted guest identity and CSRF protection. Keep sessionSecret stable
 * across replicas and deployments: changing it invalidates guest cookies and
 * changes the privacy-preserving quota hashes. This module never reads env vars.
 * trustVercel must only be enabled behind Vercel's trusted request ingress.
 */
export function createHostedSecurity({
  appOrigin,
  sessionSecret,
  production = false,
  trustVercel = false,
  cloudStorage,
  now = () => Date.now(),
} = {}) {
  let origin;
  try { origin = new URL(appOrigin); } catch { /* Fail closed below. */ }
  const localHttp = origin?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (typeof appOrigin !== 'string' || !origin || origin.origin !== appOrigin || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(localHttp && !production))) {
    throw new TypeError('Hosted security requires an exact HTTPS application origin, or a local development origin.');
  }
  const secret = typeof sessionSecret === 'string' ? Buffer.from(sessionSecret, 'utf8')
    : Buffer.isBuffer(sessionSecret) ? Buffer.from(sessionSecret) : null;
  if (!secret || secret.length < 32 || secret.length > 4096
    || (typeof sessionSecret === 'string' && sessionSecret.trim().length === 0)) {
    throw new TypeError('Hosted sessions require a secret of at least 32 bytes.');
  }
  if (typeof production !== 'boolean' || typeof trustVercel !== 'boolean' || typeof now !== 'function') throw new TypeError('Invalid hosted security configuration.');
  const cookieName = production ? '__Host-landwise_guest' : 'landwise_guest';
  const actors = new WeakMap();
  const sessions = new WeakMap();
  const hmac = (purpose, value, encoding = 'base64url') => createHmac('sha256', secret)
    .update(`landwise:${appOrigin}:${purpose}:`).update(value).digest(encoding);

  function readGuest(request) {
    const header = request?.headers?.cookie;
    if (typeof header !== 'string' || header.length > 16384) return null;
    const matching = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    if (matching.length !== 1) return null;
    const value = matching[0].slice(cookieName.length + 1);
    const match = /^v1\.([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match || !V4_UUID.test(match[1])) return null;
    const issuedAt = Number(match[2]);
    const seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || String(issuedAt) !== match[2] || issuedAt > seconds + 60
      || issuedAt + GUEST_TTL_SECONDS <= seconds) return null;
    const payload = `v1.${match[1]}.${match[2]}`;
    if (!equalSecret(match[3], hmac('guest-cookie', payload))) return null;
    return { id: match[1], issuedAt, payload };
  }

  function publicSession(guest) {
    return Object.freeze({ guestHash: hmac('guest-id', guest.id, 'hex'), csrfToken: hmac('csrf', guest.payload) });
  }

  function noCache(response) {
    response?.setHeader('Cache-Control', 'no-store');
    response?.setHeader('Pragma', 'no-cache');
  }

  function session(request, response) {
    if (!request || typeof request !== 'object') throw new TypeError('A server request is required.');
    noCache(response);
    if (sessions.has(request)) return sessions.get(request);
    let guest = readGuest(request);
    if (!guest) {
      if (typeof response?.setHeader !== 'function') throw new TypeError('A response is required to create a guest session.');
      const id = randomUUID();
      const issuedAt = Math.floor(now() / 1000);
      const payload = `v1.${id}.${issuedAt}`;
      guest = { id, issuedAt, payload };
      const cookie = `${cookieName}=${payload}.${hmac('guest-cookie', payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_TTL_SECONDS}${production ? '; Secure' : ''}`;
      const previous = response.getHeader?.('Set-Cookie');
      response.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie] : cookie);
    }
    const value = publicSession(guest);
    sessions.set(request, value);
    return value;
  }

  function requireMutation(request, response) {
    if (request?.headers?.origin !== appOrigin) {
      throw fail(403, 'invalid_origin', 'This request must come from the Landwise app.');
    }
    // Do not use session(): a mutation never mints or repairs its own cookie,
    // even if another middleware called session() on the same request first.
    const guest = readGuest(request);
    if (!guest) throw fail(401, 'session_required', 'Reload Landwise before trying again.');
    const value = publicSession(guest);
    if (!equalSecret(request.headers['x-csrf-token'], value.csrfToken)) {
      throw fail(403, 'invalid_csrf', 'Reload Landwise before trying again.');
    }
    noCache(response);
    return value;
  }

  async function actor(request, { required = false } = {}) {
    const authorization = request?.headers?.authorization;
    if (authorization === undefined) {
      if (required) throw signInRequired();
      return {};
    }
    if (!request || typeof request !== 'object') throw signInRequired();
    if (!actors.has(request)) {
      const operation = (async () => {
        if (!cloudStorage || typeof cloudStorage.forRequest !== 'function') {
          throw fail(503, 'cloud_auth_unavailable', 'Your Landwise account could not be verified. Please try again later.');
        }
        let store;
        try { store = await cloudStorage.forRequest(request); }
        catch (error) {
          if (error?.status === 401 || error?.status === 403) throw signInRequired();
          throw fail(503, 'cloud_auth_unavailable', 'Your Landwise account could not be verified. Please try again later.');
        }
        // forRequest has already verified this token with Supabase and matched
        // its subject to the confirmed, non-anonymous user. Only now derive the
        // actor ID; browser body fields and unverified JWTs never select owners.
        if (request.headers.authorization !== authorization) throw signInRequired();
        const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
        if (!match || match[1].length > 16384 || !store || typeof store !== 'object') throw signInRequired();
        let claims;
        try { claims = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')); }
        catch { throw signInRequired(); }
        if (!UUID.test(claims?.sub || '') || claims?.role !== 'authenticated'
          || !Number.isSafeInteger(claims?.exp) || claims.exp <= Math.floor(now() / 1000)) throw signInRequired();
        return Object.freeze({ userId: claims.sub, store });
      })();
      actors.set(request, operation);
    }
    return actors.get(request);
  }

  function ipHash(request) {
    const raw = trustVercel ? request?.headers?.['x-vercel-forwarded-for'] : request?.socket?.remoteAddress;
    const address = canonicalIP(raw);
    if (!address) throw fail(503, 'client_address_unavailable', 'This request could not be verified. Please try again later.');
    return hmac('client-ip', address, 'hex');
  }

  return { session, requireMutation, actor, ipHash };
}
