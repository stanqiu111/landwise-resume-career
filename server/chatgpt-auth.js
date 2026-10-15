import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { rateLimitError, retryDelaySeconds } from './ai-rate-limit.js';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_ENDPOINT = `${ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const COOKIE = 'landwise_session';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const TRANSACTION_TTL = 10 * 60 * 1000;
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ChatGPTAuthError';
    this.status = status;
    this.code = code;
  }
}

const randomValue = () => randomBytes(32).toString('base64url');
const isText = (value, max = 16384) => typeof value === 'string' && value.length > 0 && value.length <= max;
const safeEqual = (a, b) => {
  if (!isText(a) || !isText(b)) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function cookieValue(request) {
  const value = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function clearTokens(profile) {
  const next = { ...profile };
  for (const key of ['access_token', 'refresh_token', 'id_token', 'token_type', 'expires_at', 'earliest_refresh_at', 'saved_at']) {
    delete next[key];
  }
  next.scopes = [];
  return next;
}

function validStore(value) {
  return value?.version === 1 && isText(value.hostId, 128) && Array.isArray(value.profiles)
    && value.profiles.every((profile) => isText(profile.id, 128) && isText(profile.client_id, 256)
      && profile.client_id !== 'dynamic_agent_client' && (isText(profile.subject, 512) || (profile.pendingRegistration === true && profile.subject === null))
      && profile.issuer === ISSUER && Array.isArray(profile.scopes)
      && profile.scopes.every((scope) => isText(scope, 256)))
    && new Set(value.profiles.map((profile) => profile.id)).size === value.profiles.length
    && new Set(value.profiles.map((profile) => profile.client_id)).size === value.profiles.length;
}

/**
 * A single-user, loopback-only OAuth host. Credentials stay in protected host
 * storage; a browser must explicitly select a saved account after server restart.
 * The process lock prevents two local servers racing rotating refresh tokens.
 */
export async function createChatGPTAuth({
  appOrigin = 'http://127.0.0.1:5174',
  port = 3001,
  storageDir = process.env.LANDWISE_AUTH_DIR || path.join(homedir(), '.config', 'landwise'),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const frontend = new URL(appOrigin);
  if (frontend.origin !== appOrigin || frontend.protocol !== 'http:' || frontend.hostname !== '127.0.0.1'
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ChatGPT local sign-in requires an HTTP 127.0.0.1 app origin and a valid callback port.');
  }
  const callbackOrigin = `http://127.0.0.1:${port}`;
  const redirectUri = `${callbackOrigin}/auth/callback`;
  const credentialPath = path.join(storageDir, 'chatgpt.json');
  const lockPath = path.join(storageDir, 'chatgpt.lock');
  const lockId = randomValue();
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(storageDir)).isDirectory()) throw new Error('ChatGPT credential directory must not be a symbolic link.');
  await chmod(storageDir, 0o700);

  async function acquireLock() {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, id: lockId })); }
      finally { await file.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-lock recovery itself, so two newly started processes
      // cannot each remove the other's fresh lock after observing a crashed PID.
      const recoveryPath = `${lockPath}.recover`;
      let recovery;
      try {
        recovery = await open(recoveryPath, 'wx', 0o600);
      } catch (recoveryError) {
        throw new Error('Landwise account storage is in use or being recovered by another process.', { cause: recoveryError });
      }
      try {
        let oldLock;
        try { oldLock = JSON.parse(await readFile(lockPath, 'utf8')); } catch { /* An incomplete lock is conservatively kept. */ }
        if (!Number.isInteger(oldLock?.pid) || oldLock.pid < 1) throw new Error('Landwise account storage is locked by another process.', { cause: error });
        try {
          process.kill(oldLock.pid, 0);
          throw new Error('Landwise account storage is in use by another process.', { cause: error });
        } catch (lockError) {
          if (lockError.code !== 'ESRCH') throw lockError;
        }
        await unlink(lockPath);
        const file = await open(lockPath, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, id: lockId })); }
        finally { await file.close(); }
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
    }
  }
  await acquireLock();

  async function releaseLock() {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      if (lock.id === lockId) await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function atomicWrite(value) {
    const temporary = path.join(storageDir, `.chatgpt-${randomValue()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
      await file.close();
      await rename(temporary, credentialPath);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  let store;
  try {
    try {
      const fileInfo = await lstat(credentialPath);
      if (!fileInfo.isFile()) throw new Error('ChatGPT credential storage must be a regular file.');
      await chmod(credentialPath, 0o600);
      store = JSON.parse(await readFile(credentialPath, 'utf8'));
      if (!validStore(store)) throw new Error('ChatGPT account storage is invalid; it has been left unchanged.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      store = { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      await atomicWrite(store);
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }

  let writes = Promise.resolve();
  let closed = false;
  const sessions = new Map();
  const requestAccounts = new WeakMap();
  const profileOperations = new Map();
  const signingOut = new Set();
  const profileVersions = new Map();
  let revocationEndpoint;

  function commit(mutator) {
    const operation = writes.catch(() => {}).then(async () => {
      const next = mutator(store);
      try { await atomicWrite(next); }
      catch { throw new AuthError(500, 'auth_storage_failed', 'Landwise could not safely save the connection. Please try again.'); }
      store = next;
    });
    writes = operation;
    return operation;
  }

  function withProfileLock(profileId, action) {
    const operation = (profileOperations.get(profileId) || Promise.resolve()).catch(() => {}).then(action);
    profileOperations.set(profileId, operation);
    operation.finally(() => {
      if (profileOperations.get(profileId) === operation) profileOperations.delete(profileId);
    }).catch(() => {});
    return operation;
  }

  function getSession(request) {
    const id = cookieValue(request);
    const session = id && sessions.get(id);
    if (!session || session.expiresAt <= now()) {
      if (id) sessions.delete(id);
      return null;
    }
    return session;
  }

  function initializeSession(request, response) {
    let session = getSession(request);
    if (session) return session;
    for (const [id, existing] of sessions) if (existing.expiresAt <= now()) sessions.delete(id);
    if (sessions.size >= 100) throw new AuthError(429, 'too_many_sessions', 'Too many local browser sessions. Restart Landwise to continue.');
    const id = randomValue();
    session = { id, csrfToken: randomValue(), profileId: null, selectionVersion: 0, authVersion: 0,
      connectionRevision: 0, expiresAt: now() + SESSION_TTL, pending: null };
    sessions.set(id, session);
    response.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
    return session;
  }

  function requireSession(request) {
    if (request.headers.origin !== appOrigin) throw new AuthError(403, 'invalid_origin', 'This request must come from the local Landwise app.');
    const session = getSession(request);
    if (!session) throw new AuthError(401, 'session_required', 'Reload Landwise, then sign in to continue.');
    if (!safeEqual(request.headers['x-csrf-token'], session.csrfToken)) {
      throw new AuthError(403, 'invalid_csrf', 'Reload Landwise before trying again.');
    }
    return session;
  }

  function sanitizedProfile(profile) {
    const connected = Boolean(profile.id_token && (!profile.access_token || profile.expires_at > now() || profile.refresh_token))
      && !signingOut.has(profile.id);
    return {
      id: profile.id,
      label: profile.label,
      email: profile.email || null,
      name: profile.name || null,
      connected,
      sharing: connected && Boolean(profile.access_token) && profile.scopes.includes('chatgpt.tokens.use.direct'),
    };
  }

  function getStatus(request) {
    const session = getSession(request);
    const selected = session?.profileId && store.profiles.find((profile) => profile.id === session.profileId);
    const account = selected ? sanitizedProfile(selected) : null;
    return {
      authAvailable: true,
      connected: account?.connected || false,
      sharing: account?.sharing || false,
      account,
      accounts: store.profiles.map(sanitizedProfile),
      csrfToken: session?.csrfToken || null,
      connectionRevision: session?.connectionRevision || 0,
      usageUrl: USAGE_URL,
    };
  }

  async function providerRequest(endpoint, parameters) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters),
      });
    } catch {
      throw new AuthError(503, 'auth_temporarily_unavailable', 'ChatGPT could not be reached. Your saved connection has been kept; try again shortly.');
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      if (response.status === 429) {
        const limit = rateLimitError(retryDelaySeconds(response.headers));
        throw Object.assign(new AuthError(429, limit.code, limit.message), { retryAfterSeconds: limit.retryAfterSeconds });
      }
      const providerCode = typeof body?.error === 'string' ? body.error : body?.error?.code;
      const code = typeof providerCode === 'string' && /^[a-z_]{1,80}$/.test(providerCode) ? providerCode : 'auth_provider_error';
      const error = new AuthError(response.status === 429 ? 429 : response.status >= 500 ? 503 : 401, code,
        code === 'invalid_client' ? 'ChatGPT could not recognize this app registration. Please check the connection configuration.'
          : TERMINAL_REFRESH_ERRORS.has(code) ? 'Your ChatGPT connection expired. Please sign in again.'
            : 'ChatGPT could not complete sign-in. Please try again.');
      throw error;
    }
    if (!body || typeof body !== 'object') throw new AuthError(502, 'invalid_token_response', 'ChatGPT returned an incomplete sign-in response. Please sign in again.');
    return body;
  }

  async function validateIdentity(idToken, clientId, expectedNonce, expectedSubject) {
    if (!isText(idToken, 32768)) throw new AuthError(401, 'invalid_identity', 'ChatGPT sign-in could not be verified. Please try again.');
    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(now()),
      });
      if (!isText(payload.sub, 512) || (expectedNonce !== undefined && !safeEqual(payload.nonce, expectedNonce))
        || (expectedSubject && payload.sub !== expectedSubject) || payload.iat > now() / 1000 + 5
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('Invalid identity');
      return payload;
    } catch {
      throw new AuthError(401, 'invalid_identity', 'ChatGPT sign-in could not be verified for this account. Please try again.');
    }
  }

  function credentialFields(tokens, previous = null) {
    const accessToken = isText(tokens.access_token) ? tokens.access_token : null;
    const expiresIn = tokens.expires_in;
    if (accessToken && (String(tokens.token_type).toLowerCase() !== 'bearer'
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)) {
      throw new AuthError(502, 'invalid_token_response', 'ChatGPT returned incomplete credentials. Please sign in again.');
    }
    if (previous && (!accessToken || !isText(tokens.refresh_token))) {
      throw new AuthError(502, 'invalid_token_response', 'ChatGPT returned an incomplete refresh response. Please try again.');
    }
    const scopes = typeof tokens.scope === 'string' ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))] : previous?.scopes || [];
    return {
      access_token: accessToken,
      refresh_token: isText(tokens.refresh_token) ? tokens.refresh_token : null,
      id_token: isText(tokens.id_token, 32768) ? tokens.id_token : previous?.id_token || null,
      token_type: accessToken ? 'Bearer' : null,
      expires_at: accessToken ? now() + expiresIn * 1000 : null,
      earliest_refresh_at: typeof tokens.earliest_refresh_at === 'number' && Number.isFinite(tokens.earliest_refresh_at)
        ? tokens.earliest_refresh_at * 1000 : null,
      scopes,
      saved_at: new Date(now()).toISOString(),
    };
  }

  async function getAccessToken(request) {
    const session = requireSession(request);
    if (!session.profileId || signingOut.has(session.profileId)) throw new AuthError(401, 'chatgpt_signin_required', 'Continue with ChatGPT to use your plan in Landwise.');
    const profileId = session.profileId;
    const selectionVersion = session.selectionVersion;
    const pinned = requestAccounts.get(request);
    if (pinned && (pinned.profileId !== profileId || pinned.selectionVersion !== selectionVersion)) {
      throw new AuthError(409, 'chatgpt_account_changed', 'Your ChatGPT account changed during this request. Please start again.');
    }
    const ensureSelection = () => {
      if (closed || getSession(request) !== session || signingOut.has(profileId)
        || session.profileId !== profileId || session.selectionVersion !== selectionVersion) {
        throw new AuthError(409, 'chatgpt_account_changed', 'Your ChatGPT account changed during this request. Please start again.');
      }
      requestAccounts.set(request, { profileId, selectionVersion });
    };
    return withProfileLock(profileId, async () => {
      let profile = store.profiles.find((entry) => entry.id === profileId);
      if (!profile?.access_token || signingOut.has(profileId) || session.profileId !== profileId) {
        throw new AuthError(401, 'chatgpt_signin_required', 'Continue with ChatGPT to use your plan in Landwise.');
      }
      if (!profile.scopes.includes('chatgpt.tokens.use.direct')) {
        throw new AuthError(403, 'chatgpt_plan_permission_required', 'Enable ChatGPT plan access for Landwise to continue.');
      }
      if (profile.expires_at <= now() + 60000) {
        if (!profile.refresh_token) {
          if (profile.expires_at > now()) { ensureSelection(); return profile.access_token; }
          throw new AuthError(401, 'chatgpt_signin_required', 'Your ChatGPT connection expired. Please sign in again.');
        }
        if (profile.earliest_refresh_at > now() && profile.expires_at > now()) { ensureSelection(); return profile.access_token; }
        let tokens;
        try {
          tokens = await providerRequest(TOKEN_ENDPOINT, {
            grant_type: 'refresh_token', client_id: profile.client_id,
            refresh_token: profile.refresh_token, resource: RESOURCE,
          });
        } catch (error) {
          if (TERMINAL_REFRESH_ERRORS.has(error.code)) {
            await commit((current) => ({ ...current, profiles: current.profiles.map((entry) => entry.id === profileId ? clearTokens(entry) : entry) }));
          }
          throw error;
        }
        if (tokens.id_token) await validateIdentity(tokens.id_token, profile.client_id, undefined, profile.subject);
        const fields = credentialFields(tokens, profile);
        await commit((current) => ({ ...current, profiles: current.profiles.map((entry) => entry.id === profileId ? { ...entry, ...fields } : entry) }));
        profile = store.profiles.find((entry) => entry.id === profileId);
        if (!profile.scopes.includes('chatgpt.tokens.use.direct')) {
          throw new AuthError(403, 'chatgpt_plan_permission_required', 'Enable ChatGPT plan access for Landwise to continue.');
        }
      }
      ensureSelection();
      return profile.access_token;
    });
  }

  async function revoke(profile) {
    if (!profile.refresh_token) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!revocationEndpoint) {
          const discovery = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, {
            redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' },
          });
          if (!discovery.ok) {
            if (discovery.status < 500) return false;
            throw new Error('Discovery unavailable');
          }
          const configuration = await discovery.json();
          const endpoint = new URL(configuration.revocation_endpoint);
          if (configuration.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password) return false;
          revocationEndpoint = endpoint.href;
        }
        const response = await fetchImpl(revocationEndpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: profile.refresh_token, token_type_hint: 'refresh_token', client_id: profile.client_id }),
        });
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch { /* Retry transient discovery, transport, and server failures before clearing locally. */ }
      if (attempt < 2) await sleep(200 * (2 ** attempt));
    }
    return false;
  }

  const router = express.Router();
  router.use(['/api/auth', '/auth/callback'], (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (closed || ![frontend.host, `127.0.0.1:${port}`].includes(request.headers.host)) {
      return response.status(403).json({ error: 'This sign-in is available only on the local Landwise host.', code: 'local_host_required' });
    }
    next();
  });
  const route = (handler) => async (request, response) => {
    try { await handler(request, response); }
    catch (error) {
      if (error instanceof AuthError && error.retryAfterSeconds) response.set('Retry-After', String(error.retryAfterSeconds));
      response.status(error instanceof AuthError ? error.status : 500).json({
        error: error instanceof AuthError ? error.message : 'Landwise could not complete this account action. Please try again.',
        code: error instanceof AuthError ? error.code : 'auth_internal_error',
        ...(error instanceof AuthError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    }
  };

  router.get('/api/auth/session', route((request, response) => {
    const session = initializeSession(request, response);
    const status = getStatus(request);
    response.json({ ...status, csrfToken: session.csrfToken });
  }));

  router.post('/api/auth/chatgpt/start', route((request, response) => {
    const session = requireSession(request);
    const profileId = request.body?.profileId;
    const profile = profileId ? store.profiles.find((entry) => entry.id === profileId) : null;
    if (profileId && !profile) throw new AuthError(404, 'account_not_found', 'Choose a saved ChatGPT account or add a new one.');
    const codeVerifier = randomValue();
    session.authVersion += 1;
    const attempt = {
      handle: randomValue(), state: randomValue(), nonce: randomValue(), codeVerifier,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      redirectUri, expiresAt: now() + TRANSACTION_TTL,
      profileId: profile?.id || null, clientId: profile?.client_id || null,
      authVersion: session.authVersion,
      forceConsent: Boolean(profile && !profile.scopes.includes('chatgpt.tokens.use.direct')),
      opened: false,
    };
    session.pending = attempt;
    response.json({ authorizationUrl: `${appOrigin}/api/auth/chatgpt/authorize?attempt=${attempt.handle}` });
  }));

  router.get('/api/auth/chatgpt/authorize', route((request, response) => {
    const session = getSession(request);
    const attempt = session?.pending;
    if (!attempt || attempt.expiresAt <= now() || attempt.opened || !safeEqual(request.query.attempt, attempt.handle)) {
      throw new AuthError(400, 'invalid_signin_attempt', 'Sign-in has expired. Return to Landwise and try again.');
    }
    attempt.opened = true;
    const profile = attempt.profileId && store.profiles.find((entry) => entry.id === attempt.profileId);
    const authorizationUrl = new URL(AUTHORIZE_ENDPOINT);
    authorizationUrl.search = new URLSearchParams({
      client_id: attempt.clientId || 'dynamic_agent_client',
      ...(attempt.clientId ? {} : { agent_name_hint: 'Landwise' }),
      ext_agent_host_id: store.hostId,
      ...(profile?.id_token ? { id_token_hint: profile.id_token } : {}),
      ...(profile?.email ? { login_hint: profile.email } : {}),
      ...(attempt.forceConsent ? { prompt: 'consent' } : {}),
      response_type: 'code', redirect_uri: attempt.redirectUri,
      scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
      code_challenge_method: 'S256', code_challenge: attempt.codeChallenge,
    }).toString();
    response.redirect(303, authorizationUrl.href);
  }));

  function callbackPage(response, status, title, message) {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.status(status).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Landwise · ChatGPT connection</title><style>body{margin:0;background:#faf9fc;color:#252331;font:16px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:440px;margin:24px;padding:36px;border:1px solid #e9e5ef;border-radius:20px;background:#fff}h1{font-size:24px;line-height:1.3}a{display:inline-block;padding:10px 18px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none}</style><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="${escapeHtml(appOrigin)}">Return to Landwise</a></main></html>`);
  }

  router.get('/auth/callback', async (request, response) => {
    let receivedTokens;
    let issuedClient;
    let tokensHandled = false;
    try {
      const session = getSession(request);
      const attempt = session?.pending;
      if (session) session.pending = null; // Consume before any asynchronous work, including failures.
      if (!attempt || !attempt.opened || attempt.expiresAt <= now() || !safeEqual(request.query.state, attempt.state)) {
        throw new AuthError(400, 'invalid_signin_attempt', 'This sign-in attempt expired or could not be verified. Return to Landwise and try again.');
      }
      if (request.query.error) throw new AuthError(400, 'authorization_declined', 'ChatGPT sign-in was not completed. You can try again from Landwise.');
      const code = request.query.code;
      const returnedClient = request.query.client_id;
      if (!isText(code, 4096)) throw new AuthError(400, 'missing_authorization_code', 'ChatGPT did not return a sign-in code. Please try again.');
      if ((returnedClient !== undefined && (!isText(returnedClient, 256) || !/^[A-Za-z0-9_-]+$/.test(returnedClient)))
        || (attempt.clientId && returnedClient && returnedClient !== attempt.clientId)) {
        throw new AuthError(400, 'client_mismatch', 'ChatGPT returned a different account registration. Please try again.');
      }
      const clientId = attempt.clientId || returnedClient;
      issuedClient = clientId;
      if (!clientId || clientId === 'dynamic_agent_client') throw new AuthError(400, 'registration_incomplete', 'ChatGPT app registration was incomplete. Please try again.');
      const profileId = attempt.profileId || randomUUID();
      const profileVersion = profileVersions.get(profileId) || 0;
      const ensureCurrent = () => {
        if (closed || sessions.get(session.id) !== session || session.expiresAt <= now()
          || session.authVersion !== attempt.authVersion || (profileVersions.get(profileId) || 0) !== profileVersion) {
          throw new AuthError(409, 'signin_superseded', 'This sign-in was cancelled by a newer account action. Return to Landwise to continue.');
        }
      };
      ensureCurrent();
      // Preserve an issued registration even when exchange fails. Identity is not
      // trusted or activated until the signed ID token has been validated.
      if (!attempt.profileId) {
        await commit((current) => {
          ensureCurrent();
          if (current.profiles.some((entry) => entry.client_id === clientId)) {
            throw new AuthError(409, 'registration_exists', 'This account registration is already saved. Select it in Landwise and sign in again.');
          }
          return { ...current, profiles: [...current.profiles, {
            id: profileId, issuer: ISSUER, subject: null, pendingRegistration: true,
            client_id: clientId, email: null, name: null,
            label: `ChatGPT connection · ${profileId.slice(0, 6)}`, scopes: [],
          }] };
        });
      }
      ensureCurrent();
      receivedTokens = await providerRequest(TOKEN_ENDPOINT, {
        grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: attempt.codeVerifier, redirect_uri: attempt.redirectUri, resource: RESOURCE,
      });
      ensureCurrent();
      const previous = store.profiles.find((entry) => entry.id === profileId);
      const identity = await validateIdentity(receivedTokens.id_token, clientId, attempt.nonce, previous?.subject);
      ensureCurrent();
      const fields = credentialFields(receivedTokens);
      const email = isText(identity.email, 320) ? identity.email : null;
      const name = isText(identity.name, 200) ? identity.name : null;
      const profile = {
        id: profileId, issuer: ISSUER, subject: identity.sub, client_id: clientId,
        email, name, label: previous?.pendingRegistration ? `${name || email || 'ChatGPT account'} · ${profileId.slice(0, 6)}` : previous.label,
        ...fields,
      };
      await withProfileLock(profileId, async () => {
        ensureCurrent();
        const previousCredentials = store.profiles.find((entry) => entry.id === profileId);
        await commit((current) => {
          ensureCurrent();
          return { ...current, profiles: current.profiles.map((entry) => entry.id === profileId ? profile : entry) };
        });
        try { ensureCurrent(); }
        catch (error) {
          await revoke({ ...fields, client_id: clientId });
          tokensHandled = true;
          // Account actions can arrive while the atomic disk write is pending.
          // Restore the former credentials before yielding this profile's lock.
          await commit((current) => ({ ...current, profiles: current.profiles.map((entry) => entry.id === profileId ? previousCredentials : entry) }));
          throw error;
        }
        session.profileId = profileId;
        session.selectionVersion += 1;
        session.connectionRevision += 1;
        tokensHandled = true;
      });
      callbackPage(response, 200, 'Connected to ChatGPT', fields.scopes.includes('chatgpt.tokens.use.direct')
        ? 'Landwise can now use your ChatGPT plan. Return to the app to continue.'
        : 'You are signed in, but ChatGPT plan access was not enabled. Return to Landwise to enable it.');
    } catch (error) {
      if (receivedTokens && issuedClient && !tokensHandled) {
        await revoke({ refresh_token: receivedTokens.refresh_token, client_id: issuedClient });
      }
      callbackPage(response, error instanceof AuthError ? error.status : 500, 'Sign-in was not completed',
        error instanceof AuthError ? error.message : 'Landwise could not save this connection. Return to the app and try again.');
    }
  });

  router.post('/api/auth/chatgpt/select', route((request, response) => {
    const session = requireSession(request);
    const profile = store.profiles.find((entry) => entry.id === request.body?.profileId);
    if (!profile) throw new AuthError(404, 'account_not_found', 'This saved ChatGPT account was not found.');
    if (signingOut.has(profile.id)) throw new AuthError(409, 'account_signing_out', 'This ChatGPT account is signing out. Please wait.');
    session.pending = null;
    session.authVersion += 1;
    session.profileId = profile.id;
    session.selectionVersion += 1;
    response.json(getStatus(request));
  }));

  router.post('/api/auth/chatgpt/signout', route(async (request, response) => {
    const session = requireSession(request);
    const profileId = session.profileId;
    session.profileId = null;
    session.selectionVersion += 1;
    session.pending = null;
    session.authVersion += 1;
    let revoked = true;
    if (profileId) {
      signingOut.add(profileId);
      profileVersions.set(profileId, (profileVersions.get(profileId) || 0) + 1);
      // No other local browser may continue using this token set while revoking.
      for (const other of sessions.values()) {
        if (other.profileId === profileId) { other.profileId = null; other.selectionVersion += 1; other.authVersion += 1; }
        if (other.pending?.profileId === profileId) { other.pending = null; other.authVersion += 1; }
      }
      try {
        await withProfileLock(profileId, async () => {
          const profile = store.profiles.find((entry) => entry.id === profileId);
          if (!profile) return;
          revoked = await revoke(profile);
          await commit((current) => ({ ...current, profiles: current.profiles.map((entry) => entry.id === profileId ? clearTokens(entry) : entry) }));
        });
      } finally { signingOut.delete(profileId); }
    }
    response.json({ ...getStatus(request), remoteRevocationConfirmed: revoked,
      warning: revoked ? null : 'Signed out locally. Remote revocation could not be confirmed; disconnect Landwise in ChatGPT Settings → Usage.' });
  }));

  async function close() {
    if (closed) return;
    closed = true;
    sessions.clear();
    await Promise.allSettled([...profileOperations.values()]);
    await writes.catch(() => {});
    await releaseLock();
  }

  return { router, getAccessToken, getStatus, requireSession, close };
}
