import OpenAI from 'openai';
import { performance } from 'node:perf_hooks';
import { withDeadline } from './request-deadline.js';

// Reviewed against the official GPT-6 Luna model page on 2026-10-17. Keep the
// reservation and the rates together when changing the server-selected model.
// https://developers.openai.com/api/docs/models/gpt-6-luna
export const HOSTED_AI_MODEL = 'gpt-6-luna';
export const HOSTED_AI_LIMITS = Object.freeze({
  maxCallsPerJob: 4,
  maxRequestBytes: 60000,
  maxOutputTokens: 12000,
  reservedInputTokensPerCall: 61000,
  responseTimeoutMs: 60000,
  jobTimeoutMs: 240000,
});
// The input bound includes 1,000 tokens of framing beyond the complete JSON
// request's UTF-8 byte bound. No images, tools, files, or conversation IDs exist.
// Reserve cache-write pricing ($0.125/M), the highest permitted input rate,
// plus output ($0.50/M), including reasoning. Four calls cost at most $0.0545
// under these bounds; the job reservation rounds that up to six cents.
export const HOSTED_AI_CALL_RESERVATION_MICRO_USD = 13625;
export const HOSTED_AI_JOB_RESERVATION_MICRO_USD = 60000;

const API_BASE = 'https://api.openai.com/v1';
const JSON_INSTRUCTION = 'Return one valid JSON object only. Do not include Markdown fences or text outside the JSON object.';
const MAX_MESSAGES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_CODES = new Set([
  'invalid_request_error', 'invalid_api_key', 'invalid_value', 'invalid_type', 'invalid_parameter',
  'unsupported_parameter', 'unsupported_value', 'unsupported_model', 'model_not_found', 'model_access_denied',
  'context_length_exceeded', 'insufficient_quota', 'rate_limit_exceeded', 'slow_down',
  'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded', 'billing_hard_limit_reached', 'permission_denied',
  'organization_deactivated', 'account_deactivated', 'server_error', 'server_is_overloaded',
  'service_unavailable', 'invalid_json_schema', 'content_policy_violation', 'invalid_prompt',
]);
const PROVIDER_PARAMS = new Set([
  'model', 'input', 'instructions', 'reasoning', 'reasoning.effort', 'reasoning_effort',
  'text', 'text.format', 'text.format.type', 'response_format', 'max_output_tokens',
  'max_tokens', 'temperature', 'top_p', 'store', 'stream', 'service_tier', 'truncation',
]);
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'AbortError', 'APIError', 'APIConnectionError', 'APIConnectionTimeoutError',
  'APIUserAbortError', 'BadRequestError', 'AuthenticationError', 'PermissionDeniedError',
  'NotFoundError', 'ConflictError', 'UnprocessableEntityError', 'RateLimitError', 'InternalServerError',
]);

function providerErrorMetadata(error, req, callIndex) {
  // SDK APIError subclasses inherit name="Error". Normalize only known class
  // names; never serialize the error, message, stack, cause, body or headers.
  const className = error?.constructor?.name;
  const errorName = ERROR_NAMES.has(className) ? className : ERROR_NAMES.has(error?.name) ? error.name : 'UnknownError';
  const param = error?.param;
  const safeParam = PROVIDER_PARAMS.has(param) || (typeof param === 'string' && param.length <= 64
    && /^input\[\d{1,2}\](?:\.(?:role|content)(?:\[\d{1,2}\](?:\.(?:type|text))?)?)?$/.test(param));
  const providerRequestId = error?.requestID;
  const requestId = req.headers?.['x-request-id'];
  return {
    event: 'hosted_provider_error', model: HOSTED_AI_MODEL, callIndex, errorName,
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null,
    providerCode: PROVIDER_CODES.has(error?.code) ? error.code : null,
    param: safeParam ? param : null,
    ...(typeof providerRequestId === 'string' && /^req_[a-f0-9]{16,128}$/i.test(providerRequestId) ? { providerRequestId } : {}),
    ...(typeof requestId === 'string' && UUID.test(requestId) ? { requestId } : {}),
  };
}

export class OpenAIInferenceError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'OpenAIInferenceError';
    this.status = status;
    this.code = code;
  }
}

const fail = (message, status, code) => new OpenAIInferenceError(message, status, code);
const cancelled = () => fail('This request was cancelled.', 499, 'request_cancelled');
const timedOut = () => fail('The resume service took too long to finish. Please try again.', 504, 'hosted_ai_timeout');

function ensureActive(req) {
  if (req.aiSignal?.aborted) throw cancelled();
}

function providerError(error) {
  if (error instanceof OpenAIInferenceError) return error;
  if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') return cancelled();
  if (error?.name === 'APIConnectionTimeoutError') return timedOut();
  if (error?.status === 429) return fail('The resume service is busy. Please try again shortly.', 429, 'hosted_ai_rate_limited');
  if (error?.status === 401 || error?.status === 403) {
    return fail('The resume service is temporarily unavailable. Please try again later.', 503, 'hosted_ai_unavailable');
  }
  if (error?.status >= 500) return fail('The resume service is temporarily unavailable. Please try again shortly.', 503, 'hosted_ai_unavailable');
  // Provider messages can contain resume text, credentials, or request details.
  return fail('The resume service could not complete this request. Please try again.', 502, 'hosted_ai_request_failed');
}

function requestBody({ system, messages } = {}) {
  if ((system !== undefined && typeof system !== 'string') || (system?.length || 0) > HOSTED_AI_LIMITS.maxRequestBytes
    || !Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw fail('The resume request has an unsupported format or is too large.', 400, 'invalid_hosted_ai_input');
  }
  const input = messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw fail('The resume request has an unsupported message format.', 400, 'invalid_hosted_ai_input');
    }
    let content = message.content;
    if (Array.isArray(content) && content.length <= MAX_MESSAGES
      && content.every((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.length <= HOSTED_AI_LIMITS.maxRequestBytes)) {
      content = content.map((part) => part.text).join('\n');
    }
    if (typeof content !== 'string' || content.length > HOSTED_AI_LIMITS.maxRequestBytes) {
      throw fail('The resume request has an unsupported message format or is too large.', 400, 'invalid_hosted_ai_input');
    }
    return { role: message.role, content };
  });
  // JSON mode requires an explicit instruction in the conversation. Include
  // it in actual input as well as instructions, even when the caller's user
  // prompt only describes an object shape without the literal JSON marker.
  const userMessage = input.find((message) => message.role === 'user');
  if (userMessage) userMessage.content = `${JSON_INSTRUCTION}\n\n${userMessage.content}`;
  else input.push({ role: 'user', content: JSON_INSTRUCTION });
  const body = {
    model: HOSTED_AI_MODEL,
    instructions: system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION,
    input,
    store: false,
    stream: false,
    service_tier: 'default',
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_object' } },
    max_output_tokens: HOSTED_AI_LIMITS.maxOutputTokens,
    truncation: 'disabled',
  };
  // Bound the WHOLE serialized request, including instructions, role metadata,
  // JSON escaping, and all fixed parameters. Characters are not UTF-8 bytes.
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > HOSTED_AI_LIMITS.maxRequestBytes) {
    throw fail('This resume request is too large. Shorten the source text and try again.', 413, 'hosted_ai_input_too_large');
  }
  return body;
}

function resultText(response) {
  if (response?.status !== 'completed') {
    throw fail('The resume response was incomplete. No partial draft was saved; please try again.', 502, 'hosted_ai_response_incomplete');
  }
  const items = Array.isArray(response.output) ? response.output : [];
  if (items.some((item) => item?.type === 'message' && item.status && item.status !== 'completed')) {
    throw fail('The resume response was incomplete. No partial draft was saved; please try again.', 502, 'hosted_ai_response_incomplete');
  }
  if (items.some((item) => item?.content?.some((part) => part?.type === 'refusal'))) {
    throw fail('The resume service could not fulfill this request. Review the input and try again.', 422, 'hosted_ai_response_refused');
  }
  const messages = items.filter((item) => item?.type === 'message');
  const hasFinal = messages.some((item) => item.phase === 'final_answer');
  const selected = messages.filter((item) => hasFinal ? item.phase === 'final_answer' : item.phase !== 'commentary');
  let text = selected.map((item) => (Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text).join('')).join('');
  if (!messages.some((item) => item.phase) && typeof response.output_text === 'string' && response.output_text.trim()) text = response.output_text;
  if (!text.trim()) throw fail('The resume service returned no result. Please try again.', 502, 'hosted_ai_empty_response');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected a JSON object');
  } catch {
    throw fail('The resume service returned an unreadable result. Please try again.', 502, 'hosted_ai_invalid_json');
  }
  return text;
}

const validTokens = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

function meteredUsage(usage) {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const cachedInputTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  if (!validTokens(inputTokens, 1050000) || !validTokens(outputTokens, 128000)
    || !validTokens(cachedInputTokens, inputTokens) || !validTokens(cacheWriteTokens, inputTokens - cachedInputTokens)
    || (usage.total_tokens !== undefined && usage.total_tokens !== inputTokens + outputTokens)) return null;
  // Integer nanoUSD avoids floating-point rounding down. Report integer
  // microUSD, rounding up once per request; reasoning is already in output.
  const uncached = BigInt(inputTokens - cachedInputTokens - cacheWriteTokens);
  const nanoUsd = uncached * 100n + BigInt(cachedInputTokens) * 10n + BigInt(cacheWriteTokens) * 125n + BigInt(outputTokens) * 500n;
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens,
    costMicroUsd: Number((nanoUsd + 999n) / 1000n), estimated: false };
}

function estimatedUsage() {
  return { inputTokens: HOSTED_AI_LIMITS.reservedInputTokensPerCall,
    outputTokens: HOSTED_AI_LIMITS.maxOutputTokens, cachedInputTokens: 0,
    cacheWriteTokens: HOSTED_AI_LIMITS.reservedInputTokensPerCall,
    costMicroUsd: HOSTED_AI_CALL_RESERVATION_MICRO_USD, estimated: true };
}

/**
 * API-funded inference only. The caller authorizes and reserves the job first,
 * then settles getUsage(req).costMicroUsd even when the job fails or is aborted.
 * getUsage includes a full conservative estimate for any sent, unsettled call,
 * so an outer cancellation race can settle safely without awaiting this client.
 * Final usage replaces that estimate instead of adding a second charge.
 * Optional onUsage(req, event) is awaited once per sent call. Events never include
 * prompts, responses, credentials, or provider descriptions. A failed usage
 * callback stops additional calls, while getUsage keeps the cost for settlement.
 * The fixed model and per-request WeakMap prevent client-supplied model upgrades
 * or bypassing the four-call limit by obtaining another client for the same job.
 */
export function createOpenAIInference({
  apiKey,
  fetchImpl = globalThis.fetch,
  onUsage,
  log = console.info,
  responseTimeoutMs = HOSTED_AI_LIMITS.responseTimeoutMs,
  jobTimeoutMs = HOSTED_AI_LIMITS.jobTimeoutMs,
  now = () => performance.now(),
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof log !== 'function' || (onUsage !== undefined && typeof onUsage !== 'function')) throw new TypeError('Invalid inference dependencies.');
  if (!Number.isInteger(responseTimeoutMs) || responseTimeoutMs < 1 || responseTimeoutMs > HOSTED_AI_LIMITS.responseTimeoutMs
    || !Number.isInteger(jobTimeoutMs) || jobTimeoutMs < 1 || jobTimeoutMs > HOSTED_AI_LIMITS.jobTimeoutMs) {
    throw new TypeError('Inference deadlines must be within the server limits.');
  }
  const configured = typeof apiKey === 'string' && apiKey.trim().length > 0;
  const jobs = new WeakMap();

  function getUsage(req) {
    const job = jobs.get(req);
    const summary = { model: HOSTED_AI_MODEL, calls: 0, inputTokens: 0, outputTokens: 0,
      cachedInputTokens: 0, cacheWriteTokens: 0, costMicroUsd: 0, estimated: false };
    const events = [...(job?.events || []), ...(job?.pending?.sent ? [estimatedUsage()] : [])];
    for (const event of events) {
      summary.calls += 1;
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'costMicroUsd']) summary[key] += event[key];
      summary.estimated ||= event.estimated;
    }
    return summary;
  }

  async function getClient(req) {
    if (!configured) throw fail('The resume service is not configured yet. Please try again later.', 503, 'hosted_ai_not_configured');
    if (!req || typeof req !== 'object') throw new TypeError('A server request object is required.');
    ensureActive(req);
    let job = jobs.get(req);
    if (!job) {
      job = { startedAt: now(), attempts: 0, inFlight: false, pending: null, accountingFailed: false, events: [] };
      jobs.set(req, job);
    }
    return {
      messages: {
        async create(parameters) {
          ensureActive(req);
          if (job.accountingFailed) throw fail('Usage could not be recorded safely. Please try again later.', 503, 'hosted_ai_accounting_failed');
          if (job.inFlight) throw fail('A resume step is already running. Wait for it to finish.', 409, 'hosted_ai_call_in_progress');
          if (job.attempts >= HOSTED_AI_LIMITS.maxCallsPerJob) throw fail('This resume job reached its processing limit. Please start a new request.', 429, 'hosted_ai_call_limit');
          const remaining = jobTimeoutMs - (now() - job.startedAt);
          if (remaining <= 0) throw timedOut();
          const body = requestBody(parameters);
          const callIndex = ++job.attempts;
          job.inFlight = true;
          job.pending = { callIndex, sent: false };
          let sent = false;
          let response;
          let result;
          let failure;
          try {
            result = await withDeadline(req.aiSignal, Math.min(responseTimeoutMs, remaining), timedOut(), async (signal) => {
              signal.throwIfAborted();
              const client = new OpenAI({
                apiKey, baseURL: API_BASE, maxRetries: 0, logLevel: 'off', timeout: Math.min(responseTimeoutMs, remaining),
                fetch: async (url, init) => {
                  signal.throwIfAborted();
                  sent = true;
                  job.pending.sent = true;
                  // Never forward the application's API key to a redirect host.
                  return fetchImpl(url, { ...init, redirect: 'error' });
                },
              });
              response = await client.responses.create(body, { signal });
              signal.throwIfAborted();
              return { content: [{ type: 'text', text: resultText(response) }], stop_reason: 'end_turn' };
            });
          } catch (error) {
            if (sent && !(error instanceof OpenAIInferenceError)) {
              try {
                Promise.resolve(log(JSON.stringify(providerErrorMetadata(error, req, callIndex)))).catch(() => {});
              } catch { /* Diagnostic failures never alter billing or user errors. */ }
            }
            failure = req.aiSignal?.aborted ? cancelled() : providerError(error);
          }
          try {
            if (sent) {
              const usage = meteredUsage(response?.usage) || estimatedUsage();
              const event = Object.freeze({ callIndex, model: HOSTED_AI_MODEL, ...usage,
                outcome: failure ? 'failed' : 'succeeded' });
              job.events.push(event); // Retain before awaiting any external ledger.
              job.pending = null;
              if (onUsage) {
                try {
                  await withDeadline(undefined, Math.min(10000, Math.max(1, jobTimeoutMs - (now() - job.startedAt))),
                    fail('Usage could not be recorded safely. Please try again later.', 503, 'hosted_ai_accounting_failed'),
                    () => onUsage(req, event));
                } catch {
                  job.accountingFailed = true;
                  throw fail('Usage could not be recorded safely. Please try again later.', 503, 'hosted_ai_accounting_failed');
                }
              }
            }
            if (failure) throw failure;
            ensureActive(req);
            return result;
          } finally { job.pending = null; job.inFlight = false; }
        },
      },
    };
  }

  return { getClient, getUsage };
}
