import OpenAI, { APIUserAbortError } from 'openai';
import { withDeadline } from './request-deadline.js';
import { AIRateLimitError, rateLimitError, retryDelaySeconds } from './ai-rate-limit.js';

const API_BASE = 'https://api.openai.com/v1';
// Every Landwise model call expects one JSON object. As in the hosted adapter,
// request JSON mode and repeat the instruction in the input messages, which JSON
// mode requires (instructions alone are not enough).
const JSON_INSTRUCTION = 'Return one valid JSON object only. Do not include Markdown fences or text outside the JSON object.';
const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

class ChatGPTInferenceError extends Error {
  constructor(message, status, code, extras = {}) {
    super(message);
    this.name = 'ChatGPTInferenceError';
    this.status = status;
    this.code = code;
    Object.assign(this, extras);
  }
}

function cancelledError() {
  return new ChatGPTInferenceError('This request was cancelled.', 499, 'request_cancelled');
}

function ensureActive(req) {
  if (req?.aiSignal?.aborted) throw cancelledError();
}

// Provider descriptions can contain request data. Only known codes and our own
// fixed messages leave this adapter; never attach a provider payload or token.
function providerError(error, status, headers = error?.headers) {
  if (error instanceof ChatGPTInferenceError || error instanceof AIRateLimitError) return error;
  if (error?.name === 'AbortError' || error instanceof APIUserAbortError) return cancelledError();
  const code = error?.error?.code ?? error?.code;
  const httpStatus = status ?? error?.status;
  switch (code) {
    case 'rate_limit_exceeded':
    case 'slow_down':
      return rateLimitError(retryDelaySeconds(headers));
    case 'subscription_sharing_usage_limit_exceeded':
      return new ChatGPTInferenceError('Your ChatGPT app usage limit has been reached. Open Manage usage in ChatGPT settings to review your limits.', 429, code, { manageUsageUrl: MANAGE_USAGE_URL });
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ChatGPTInferenceError('ChatGPT usage is temporarily unavailable. Please try again later.', 503, code);
    case 'subscription_sharing_user_not_eligible':
      return new ChatGPTInferenceError('ChatGPT plan usage is unavailable for this account or workspace. Check your account permissions.', 403, code);
    case 'subscription_sharing_unsupported_capability':
      return new ChatGPTInferenceError('The selected ChatGPT model does not support this request. Choose another available model.', 400, code);
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return new ChatGPTInferenceError('ChatGPT has not authorized this app request. Check your account and app permissions.', 403, code);
    case 'subscription_sharing_invalid_user':
      return new ChatGPTInferenceError('Your ChatGPT connection could not be verified. Please reconnect ChatGPT.', 401, code);
    default:
      if (httpStatus === 401) return new ChatGPTInferenceError('Your ChatGPT connection could not be verified. Please reconnect ChatGPT.', 401, 'chatgpt_authentication_failed');
      if (httpStatus === 403) return new ChatGPTInferenceError('ChatGPT blocked this request because of account, region, or app permissions.', 403, 'chatgpt_permission_denied');
      if (httpStatus === 429) return rateLimitError(error?.name === 'ChatGPTAuthError' && Number.isFinite(error.retryAfterSeconds)
        ? error.retryAfterSeconds : retryDelaySeconds(headers));
      if (httpStatus === 503) return new ChatGPTInferenceError('ChatGPT is temporarily unavailable. Please try again later.', 503, 'chatgpt_unavailable');
      return new ChatGPTInferenceError('The ChatGPT request could not be completed. Please try again.', 502, 'chatgpt_request_failed');
  }
}

function withJsonInstruction(input) {
  const index = input.findIndex(message => message.role === 'user');
  if (index < 0) return [...input, { role: 'user', content: JSON_INSTRUCTION }];
  return input.map((message, position) => position === index ? { ...message, content: `${JSON_INSTRUCTION}\n\n${message.content}` } : message);
}

function toInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ChatGPTInferenceError('A message is required for ChatGPT.', 400, 'invalid_chatgpt_input');
  }
  return messages.map(({ role, content } = {}) => {
    if (role !== 'user' && role !== 'assistant') {
      throw new ChatGPTInferenceError('This message format is not supported.', 400, 'invalid_chatgpt_input');
    }
    if (typeof content === 'string') return { role, content };
    if (Array.isArray(content) && content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
      return { role, content: content.map(block => block.text).join('\n') };
    }
    throw new ChatGPTInferenceError('This message format is not supported.', 400, 'invalid_chatgpt_input');
  });
}

// Plan streams may leave response.completed.output empty. Keep each message and
// content part separately: done events replace deltas, rather than duplicating
// them. Nothing is returned until the whole stream has completed successfully.
function responseTextCollector() {
  const items = new Map();
  const indexesById = new Map();
  let refused = false;
  let incomplete = false;

  function entryFor(event) {
    const id = event.item?.id ?? event.item_id;
    const index = event.output_index ?? indexesById.get(id) ?? 0;
    if (id) indexesById.set(id, index);
    if (!items.has(index)) items.set(index, { parts: new Map() });
    return items.get(index);
  }

  function setPart(entry, index, part) {
    if (part?.type === 'refusal') refused = true;
    if (part?.type === 'output_text' && typeof part.text === 'string') {
      entry.parts.set(index, part.text);
    }
  }

  function addItem(event, done) {
    const entry = entryFor(event);
    const item = event.item;
    entry.type = item.type;
    if (item.phase != null) entry.phase = item.phase;
    if (done && item.type === 'message' && item.status && item.status !== 'completed') incomplete = true;
    if (Array.isArray(item.content)) {
      if (done) entry.parts.clear();
      item.content.forEach((part, index) => setPart(entry, index, part));
    }
  }

  function add(event) {
    if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item) {
      addItem(event, event.type === 'response.output_item.done');
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const entry = entryFor(event);
      const index = event.content_index ?? 0;
      entry.parts.set(index, (entry.parts.get(index) ?? '') + event.delta);
    } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      entryFor(event).parts.set(event.content_index ?? 0, event.text);
    } else if (event.type === 'response.content_part.done') {
      setPart(entryFor(event), event.content_index ?? 0, event.part);
    } else if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
      refused = true;
    }
  }

  function finish(response) {
    if (Array.isArray(response?.output)) {
      const hasCanonicalText = response.output.some(item => item?.type === 'message'
        && item.content?.some(part => part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()));
      if (hasCanonicalText) {
        for (const index of items.keys()) {
          if (index >= response.output.length) items.delete(index);
        }
      }
      response.output.forEach((item, output_index) => addItem({ item, output_index }, true));
    }
    if (incomplete) throw new ChatGPTInferenceError('ChatGPT stopped before finishing. Please try again; no partial result was saved.', 502, 'chatgpt_response_incomplete');
    if (refused) throw new ChatGPTInferenceError('ChatGPT could not fulfill this request. Review your input and try again.', 422, 'chatgpt_response_refused');

    const ordered = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    const messages = ordered.filter(item => !item.type || item.type === 'message');
    const hasFinalAnswer = messages.some(item => item.phase === 'final_answer');
    const answer = messages.filter(item => hasFinalAnswer ? item.phase === 'final_answer' : item.phase !== 'commentary');
    const text = answer.map(item => [...item.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part).join('')).join('');
    // The convenience field is authoritative when no phase metadata needs to
    // distinguish commentary from the answer consumed by the JSON pipeline.
    if (!messages.some(item => item.phase) && typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text;
    return text;
  }

  return { add, finish };
}

export function createChatGPTInference({
  getAccessToken,
  fetchImpl = fetch,
  createOpenAIClient = options => new OpenAI(options),
  responseTimeoutMs = 120000,
} = {}) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required.');

  async function accessToken(req) {
    ensureActive(req);
    let token;
    try {
      token = await getAccessToken(req);
    } catch (error) {
      ensureActive(req);
      throw error;
    }
    ensureActive(req);
    if (typeof token !== 'string' || !token) {
      throw new ChatGPTInferenceError('Please sign in with ChatGPT to continue.', 401, 'chatgpt_sign_in_required');
    }
    return token;
  }

  async function listModels(req) {
    const token = await accessToken(req);
    try {
      const response = await fetchImpl(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: req?.aiSignal ? AbortSignal.any([req.aiSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      let body;
      try { body = await response.json(); } catch { /* Non-JSON admission failures are handled by status. */ }
      ensureActive(req);
      if (!response.ok) throw providerError(body, response.status, response.headers);
      if (!Array.isArray(body?.models)) throw providerError();
      const seen = new Set();
      return body.models.filter(model => {
        if (model?.visibility !== 'list' || typeof model.slug !== 'string' || !model.slug.trim() || seen.has(model.slug)) return false;
        seen.add(model.slug);
        return true;
      }).map(model => ({
        slug: model.slug,
        displayName: typeof model.display_name === 'string' && model.display_name.trim() ? model.display_name : model.slug,
      }));
    } catch (error) {
      ensureActive(req);
      throw providerError(error);
    }
  }

  async function getClient(req, selectedModel) {
    // Get a fresh account catalog for each top-level application request. The
    // returned client may run multiple steps without repeating this lookup.
    const models = await listModels(req);
    const model = selectedModel || models[0]?.slug;
    if (!models.some(available => available.slug === model)) {
      throw new ChatGPTInferenceError('This ChatGPT model is not available for your account. Refresh the model list and choose an available model.', 400, 'chatgpt_model_unavailable');
    }

    return {
      messages: {
        async create({ system, messages }) {
          const input = toInput(messages);
          try {
            return await withDeadline(req?.aiSignal, responseTimeoutMs,
              new ChatGPTInferenceError('ChatGPT took too long to finish this step. Please try again or choose another model.', 504, 'chatgpt_response_timeout'),
              async signal => {
                const token = await accessToken(req);
                signal.throwIfAborted();
                const client = createOpenAIClient({ apiKey: token, baseURL: API_BASE, maxRetries: 0, timeout: 120000 });
                const stream = await client.responses.create({
                  model,
                  input: withJsonInstruction(input),
                  instructions: typeof system === 'string' && system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION,
                  text: { format: { type: 'json_object' } },
                  store: false,
                  stream: true,
                }, { signal });
                let completed = false;
                let response;
                const textCollector = responseTextCollector();
                for await (const event of stream) {
                  ensureActive(req);
                  signal.throwIfAborted();
                  textCollector.add(event);
                  if (event.type === 'response.failed') throw providerError(event.response?.error);
                  if (event.type === 'error') throw providerError(event.error ?? event);
                  if (event.type === 'response.incomplete') {
                    throw new ChatGPTInferenceError('ChatGPT stopped before finishing. Please try again; no partial result was saved.', 502, 'chatgpt_response_incomplete');
                  }
                  if (event.type === 'response.completed') {
                    if (event.response?.status && event.response.status !== 'completed') {
                      throw new ChatGPTInferenceError('ChatGPT did not finish this request. Please try again.', 502, 'chatgpt_response_incomplete');
                    }
                    completed = true;
                    response = event.response;
                  }
                }
                ensureActive(req);
                if (!completed) {
                  throw new ChatGPTInferenceError('The ChatGPT connection ended before the response was complete. Please try again; no partial result was saved.', 502, 'chatgpt_stream_interrupted');
                }
                const text = textCollector.finish(response);
                if (!text.trim()) throw new ChatGPTInferenceError('ChatGPT returned no text. Please try again.', 502, 'chatgpt_empty_response');
                return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
              });
          } catch (error) {
            ensureActive(req);
            throw providerError(error);
          }
        },
      },
    };
  }

  return { listModels, getClient };
}
