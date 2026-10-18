import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const Actor = z.object({ userId: z.string().regex(UUID).optional(), guestHash: z.string().regex(HASH).optional() })
  .refine(value => Boolean(value.userId) !== Boolean(value.guestHash));
const Reserve = z.object({ requestId: z.string().regex(UUID), userId: z.string().regex(UUID).optional(), guestHash: z.string().regex(HASH).optional(),
  ipHash: z.string().regex(HASH), inputHash: z.string().regex(HASH), maxCostMicrousd: z.number().int().min(1).max(4000000),
  operation: z.enum(['transform', 'revise', 'analyze']).default('transform') })
  .refine(value => Boolean(value.userId) !== Boolean(value.guestHash));
const Settlement = z.object({ jobId: z.string().regex(UUID), actualCostMicrousd: z.number().int().min(0).max(100000000).nullish() });
const Upload = z.object({ guestHash: z.string().regex(HASH), ipHash: z.string().regex(HASH) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 503, code = 'hosted_budget_unavailable') => Object.assign(new Error(message), { status, code });
const errors = new Map([
  ['landwise_upload_limit', [429, 'upload_limit', 'The daily PDF upload limit has been reached. Paste your resume text or try again tomorrow.']],
  ['landwise_ai_busy', [409, 'hosted_ai_busy', 'Another AI request is running or awaiting recovery. Please try again later.']],
  ['landwise_ai_allowance_used', [429, 'hosted_ai_allowance_used', 'Your sponsored AI allowance has been used. Sign in to check your monthly allowance.']],
  ['landwise_ai_budget_limit', [429, 'hosted_ai_budget_limit', 'The pilot AI budget has been reached for this month. Your inputs are still available.']],
  ['landwise_ai_daily_limit', [429, 'hosted_ai_daily_limit', 'The pilot daily AI request limit has been reached. Please try again tomorrow.']],
  ['landwise_ai_monthly_limit', [429, 'hosted_ai_monthly_limit', 'The pilot monthly AI request limit has been reached. Please try again next month.']],
  ['landwise_ai_ip_limit', [429, 'hosted_ai_ip_limit', 'The daily AI request limit for this connection has been reached. Please try again tomorrow.']],
  ['landwise_ai_idempotency_conflict', [409, 'hosted_ai_idempotency_conflict', 'This request ID belongs to different inputs. Start a new request for these changes.']],
  ['landwise_ai_sign_in_required', [401, 'cloud_sign_in_required', 'Sign in to your Landwise account to use analysis and follow-up editing.']],
]);

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw fail('The sponsored request could not be verified.', 400, 'invalid_hosted_request');
  return result.data;
}
function validServiceKey(value) {
  if (typeof value !== 'string' || value.length > 32768) return false;
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')).role === 'service_role'; }
  catch { return false; }
}
const receipt = data => object(data) && UUID.test(data.jobId || '') && ['reserved', 'completed', 'failed'].includes(data.status)
  && typeof data.admitted === 'boolean' && Number.isSafeInteger(data.reservedCostMicrousd);

// This object must remain server-only. Identities and actual costs must come from
// verified server state, never req.body. Settlement intentionally has no browser
// AbortSignal: a disconnected browser must not prevent charging a finished job.
export function createHostedBudget({ url, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
    origin = parsed.origin;
  } catch { throw fail('Configure the private hosted budget service before enabling sponsored AI.'); }
  if (!validServiceKey(serviceRoleKey) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw fail('Configure the private hosted budget service before enabling sponsored AI.');
  }
  async function rpc(name, args, accepts) {
    let response;
    let data;
    try {
      response = await fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store',
      });
      data = await response.json();
    } catch {
      throw fail('The AI budget service could not confirm this request. No new AI work can start until it is confirmed.');
    }
    if (!response.ok) {
      const known = data?.code === 'P0001' && errors.get(data?.details);
      if (known) throw fail(known[2], known[0], known[1]);
      throw fail('The AI budget service is unavailable. Your inputs are still available; please try again later.');
    }
    if (!accepts(data)) throw fail('The AI budget service returned an incomplete response. Please try again later.');
    return data;
  }
  const actorArgs = value => ({ p_user_id: value.userId || null, p_guest_hash: value.guestHash || null });
  return {
    acquireUpload: async input => {
      const value = parse(Upload, input);
      return rpc('landwise_upload_acquire', { p_guest_hash: value.guestHash, p_ip_hash: value.ipHash }, data => data === true);
    },
    status: async actor => rpc('landwise_ai_status', actorArgs(parse(Actor, actor)), data => object(data)
      && typeof data.guestEligible === 'boolean' && Number.isInteger(data.remaining) && data.remaining >= 0 && data.remaining <= 3 && typeof data.available === 'boolean'),
    reserve: async input => {
      const value = parse(Reserve, input);
      return rpc('landwise_ai_reserve', { ...actorArgs(value), p_request_id: value.requestId, p_ip_hash: value.ipHash,
        p_input_hash: value.inputHash, p_max_cost_microusd: value.maxCostMicrousd, p_operation: value.operation }, receipt);
    },
    complete: async input => {
      const value = parse(Settlement, input);
      let result = input.result ?? null;
      if (result !== null && !object(result)) throw fail('The completed result could not be stored.', 400, 'invalid_hosted_result');
      try {
        // Success and billing still settle when a result cannot fit the cache.
        if (result && Buffer.byteLength(JSON.stringify(result), 'utf8') > 220000) result = null;
      } catch { result = null; }
      return rpc('landwise_ai_complete', { p_job_id: value.jobId, p_actual_cost_microusd: value.actualCostMicrousd ?? null, p_result: result }, receipt);
    },
    fail: async input => {
      const value = parse(Settlement, input);
      return rpc('landwise_ai_fail', { p_job_id: value.jobId, p_actual_cost_microusd: value.actualCostMicrousd ?? null }, receipt);
    },
  };
}
