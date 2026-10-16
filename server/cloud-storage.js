import { createSupabaseApplicationStore } from './supabase-applications.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This adapter changes application ownership only. Provider OAuth remains the
// loopback-only connection until a hosted OAuth client is configured separately.
export function createCloudStorage({ url, publishableKey, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const project = new URL(url);
  if (project.protocol !== 'https:' || project.origin !== url || project.username || project.password) {
    throw new Error('SUPABASE_URL must be an HTTPS project origin.');
  }
  // Validate public configuration before exposing any of it to the browser.
  const publicKey = typeof publishableKey === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey);
  let legacyPublic = false;
  if (!publicKey && typeof publishableKey === 'string') {
    try {
      const parts = publishableKey.split('.');
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      legacyPublic = parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) && claims.role === 'anon';
    } catch { /* Secret and malformed keys fail closed. */ }
  }
  if (!publicKey && !legacyPublic) throw new Error('Use a Supabase publishable key, never a secret or service-role key.');
  const requests = new WeakMap();
  return {
    publicConfig: Object.freeze({ storage: 'supabase', url, publishableKey }),
    forRequest(request) {
      if (requests.has(request)) return requests.get(request);
      const operation = (async () => {
        const authorization = request.headers.authorization;
        const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
        if (!match || match[1].length > 16384) throw fail(401, 'cloud_sign_in_required', 'Sign in to your Landwise account to continue.');
        const accessToken = match[1];
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(request.aiSignal ? [request.aiSignal] : [])]);
        let response;
        try {
          response = await fetchImpl(`${url}/auth/v1/user`, {
            headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}` }, signal, redirect: 'error', cache: 'no-store',
          });
        } catch {
          throw fail(503, 'cloud_auth_unavailable', 'Your account could not be verified. Please try again.');
        }
        if ([401, 403].includes(response.status)) throw fail(401, 'cloud_sign_in_required', 'Sign in to your Landwise account again to continue.');
        if (!response.ok) throw fail(503, 'cloud_auth_unavailable', 'Your account could not be verified. Please try again.');
        let user;
        try { user = await response.json(); } catch { /* Fail closed below. */ }
        if (!UUID.test(user?.id || '') || user?.is_anonymous !== false || !user?.confirmed_at) {
          throw fail(401, 'cloud_sign_in_required', 'Verify your email and sign in to your Landwise account.');
        }
        // Never use an ID supplied in the request body or an unverified JWT.
        let claims;
        try { claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')); } catch { /* Rejected below. */ }
        if (claims?.sub !== user.id || claims?.role !== 'authenticated') {
          throw fail(401, 'cloud_sign_in_required', 'Sign in to your Landwise account again to continue.');
        }
        return createSupabaseApplicationStore({ url, publishableKey, accessToken, fetchImpl, signal: request.aiSignal });
      })();
      requests.set(request, operation);
      return operation;
    },
  };
}

export function cloudStorageFromEnvironment(env = process.env) {
  const mode = env.LANDWISE_APPLICATION_STORAGE || 'local';
  if (mode === 'local') return null;
  if (mode !== 'supabase') throw new Error('LANDWISE_APPLICATION_STORAGE must be local or supabase.');
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new Error('Supabase storage requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  return createCloudStorage({ url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY });
}
