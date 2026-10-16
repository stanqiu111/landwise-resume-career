import { z } from 'zod';
import { APPLICATION_STAGES } from './application-store.js';

const MAX_INPUT_LENGTH = 220000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonblank = z.string().refine(value => Boolean(value.trim()));
const SaveInput = z.object({
  resume: nonblank,
  jobDescription: nonblank,
  maxPages: z.number().int().min(1).max(20),
  result: z.object({ transformedResume: nonblank }).passthrough(),
}).strict();
const Patch = z.object({
  company: z.string().trim().max(160).optional(),
  roleTitle: z.string().trim().min(1).max(160).optional(),
  stage: z.enum(APPLICATION_STAGES).optional(),
  notes: z.string().max(12000).optional(),
  practice: z.array(z.object({
    id: z.string().max(100), title: z.string().max(1000), done: z.boolean(),
  })).max(100).optional(),
}).strict();

function failure(message, status = 400, code = 'application_error') {
  return Object.assign(new Error(message), { status, code });
}

function signInError() {
  return failure('Sign in to your Landwise account again to access your applications.', 401, 'cloud_sign_in_required');
}

// Structural defence only. The caller must verify this token with Supabase Auth
// before constructing the store; the RPC also validates it and applies auth.uid().
function jwtClaims(token) {
  if (typeof token !== 'string' || token.length > 32768
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const [encodedHeader, encodedPayload] = token.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!header || typeof header.alg !== 'string' || !header.alg.trim() || header.alg.toLowerCase() === 'none'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch { return null; }
}

function projectOrigin(value) {
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw failure('Configure a valid Supabase project URL before using cloud applications.', 503, 'application_storage_unavailable');
  }
}

function isPublishableKey(value) {
  if (typeof value !== 'string' || value.length > 32768) return false;
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(value) || jwtClaims(value)?.role === 'anon';
}

function validated(schema, input, message) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw failure(message);
  return parsed.data;
}

function boundedJSON(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw failure('This application could not be saved. Check the draft and try again.'); }
  if (typeof serialized !== 'string' || serialized.length > MAX_INPUT_LENGTH) {
    throw failure('This application is too large to save.');
  }
  return serialized;
}

function applicationId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('Invalid application folder.');
  return id;
}

function remoteError(status, code) {
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302') return signInError();
  if (code === 'P0002') return failure('This application was not found in your account.', 404);
  if (status === 403 || code === '42501') return failure('Your account cannot access this application.', 403);
  if (code === '22023') return failure('Check the application details and try again.', 400);
  if (status === 409 || code === '40001' || code === '40P01') {
    return failure('Your application changed while saving. Refresh it and try again.', 409);
  }
  if (status === 429) return failure('Cloud storage is busy. Wait a moment, then try again.', 429, 'application_storage_busy');
  // In particular, do not pass through provider messages, SQL details, project
  // URLs or credentials. Missing RPCs are a configuration issue, not a missing app.
  return failure('Cloud application storage is unavailable. Your current draft is still available; please try again.', 502, 'cloud_application_error');
}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validSummary = value => object(value) && typeof value.id === 'string' && UUID.test(value.id);
const validApplication = value => validSummary(value) && Array.isArray(value.versions) && Array.isArray(value.practice);
const cloudResult = value => ({ ...value, storage: 'supabase', folder: null });

/**
 * Request-scoped cloud library. Pass the verified end-user accessToken, never a
 * service-role key. Ownership is derived by every RPC from auth.uid(), and writes
 * are serialized atomically in Postgres rather than a process-local JS queue.
 * This module has no environment reads and never falls back to the local store.
 */
export function createSupabaseApplicationStore({
  url, publishableKey, accessToken, fetchImpl = globalThis.fetch, signal, now = Date.now,
  timeoutMs = 15000,
} = {}) {
  const origin = projectOrigin(url);
  if (!isPublishableKey(publishableKey)) {
    throw failure('Configure a Supabase publishable key for cloud applications.', 503, 'application_storage_unavailable');
  }
  const claims = jwtClaims(accessToken);
  const validIdentity = claims?.role === 'authenticated' && typeof claims.sub === 'string' && UUID.test(claims.sub)
    && Number.isFinite(claims.exp) && claims.exp * 1000 > now();
  if (!validIdentity) throw signInError();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw failure('Configure a valid cloud storage timeout.', 503, 'application_storage_unavailable');
  }

  async function rpc(name, args, accepts) {
    signal?.throwIfAborted();
    if (claims.exp * 1000 <= now()) throw signInError();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    function checkAbort() {
      signal?.throwIfAborted();
      if (timeout.aborted) throw failure('Cloud application storage took too long. Your current draft is still available; please try again.', 503, 'cloud_application_error');
    }
    let response;
    try {
      response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args), signal: requestSignal, redirect: 'error', cache: 'no-store',
      });
    } catch {
      checkAbort();
      throw remoteError(502);
    }
    checkAbort();
    let data;
    try { data = await response.json(); }
    catch {
      checkAbort();
      throw remoteError(response.ok ? 502 : response.status);
    }
    checkAbort();
    if (!response.ok) throw remoteError(response.status, data?.code);
    if (!accepts(data)) throw remoteError(502);
    return data;
  }

  return {
    list: async () => cloudResult(await rpc('landwise_application_list', {}, data => object(data)
      && Array.isArray(data.applications) && data.applications.every(validSummary))),
    get: async id => cloudResult(await rpc('landwise_application_get', { p_id: applicationId(id) }, validApplication)),
    save: async inputs => {
      const clean = validated(SaveInput, inputs, 'A completed resume, job description and page limit are required.');
      // Match the existing store's input bound before adding the RPC envelope.
      boundedJSON(clean);
      return cloudResult(await rpc('landwise_application_save', { p_inputs: clean }, data => validSummary(data)
        && typeof data.versionId === 'string' && UUID.test(data.versionId)));
    },
    update: async (id, patch) => {
      const p_id = applicationId(id);
      const p_patch = validated(Patch, patch, 'Check the company, role, progress and notes before saving.');
      boundedJSON(p_patch);
      return cloudResult(await rpc('landwise_application_update', { p_id, p_patch }, validApplication));
    },
    remove: async id => rpc('landwise_application_remove', { p_id: applicationId(id) }, data => object(data) && data.removed === true),
  };
}
