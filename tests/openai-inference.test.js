import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAIInference, HOSTED_AI_MODEL, HOSTED_AI_LIMITS,
  HOSTED_AI_CALL_RESERVATION_MICRO_USD, HOSTED_AI_JOB_RESERVATION_MICRO_USD,
} from '../server/openai-inference.js';

const parameters = { system: 'You are a careful resume editor.', messages: [{ role: 'user', content: 'Return a JSON object describing the resume.' }] };
const usage = { input_tokens: 1001, output_tokens: 3, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 201 },
  output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 1004 };
const completed = (overrides = {}) => ({ id: 'resp_synthetic', object: 'response', status: 'completed',
  output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
  usage, ...overrides });
const textResponse = (text) => completed({ output: [{ type: 'message', status: 'completed',
  content: [{ type: 'output_text', text }] }] });

function fixture(options = {}) {
  const calls = [];
  const events = [];
  const logs = [];
  const inference = createOpenAIInference({
    apiKey: 'synthetic-server-key',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      return Response.json(options.response || completed());
    },
    onUsage: async (req, event) => {
      events.push({ req, event });
      if (options.onUsage) await options.onUsage(req, event);
    },
    log: value => logs.push(JSON.parse(value)),
    ...options.dependencies,
  });
  return { inference, calls, events, logs };
}

async function invoke(f, req = {}, overrides = {}) {
  const client = await f.inference.getClient(req, 'user-selected-expensive-model');
  const result = await client.messages.create({ ...parameters, ...overrides });
  return { result, req, client };
}

test('missing explicit server key fails safely without reading an environment key or sending requests', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-env-key-that-must-not-be-used';
  try {
    const inference = createOpenAIInference({ fetchImpl: () => { throw new Error('must not send'); } });
    await assert.rejects(inference.getClient({}), { status: 503, code: 'hosted_ai_not_configured' });
    assert.equal(inference.getUsage({}).costMicroUsd, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('fixed server model, standard tier, bounded output, JSON mode and no storage override user parameters', async () => {
  const f = fixture();
  const req = {};
  const { result } = await invoke(f, req, { model: 'gpt-6-astra', max_tokens: 999999, max_output_tokens: 999999,
    stream: true, store: true, tools: [{ type: 'web_search' }] });
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
  assert.equal(f.calls.length, 1);
  const { body, init, url } = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-server-key');
  assert.equal(init.redirect, 'error');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.service_tier, 'default');
  assert.equal(body.max_output_tokens, 12000);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.text, { format: { type: 'json_object' } });
  assert.equal(body.truncation, 'disabled');
  assert.equal(body.tools, undefined);
  assert.match(body.instructions, /JSON object only/);
  assert.equal(f.events[0].req, req);
  assert.equal(f.events[0].event.costMicroUsd, 71);
  assert.equal(f.events[0].event.estimated, false);
  assert.equal(f.inference.getUsage(req).costMicroUsd, 71);
  assert.doesNotMatch(JSON.stringify(f.events[0].event), /synthetic-server-key|careful resume editor|Return a JSON/);
});

test('JSON text blocks and final answer phases preserve the existing messages.create contract', async () => {
  const f = fixture({ response: completed({ output_text: 'Ignore this commentary', output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Working on it' }] },
    { type: 'message', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '{"answer":' }, { type: 'output_text', text: '42}' }] },
  ] }) });
  const { result } = await invoke(f, {}, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Line one' }, { type: 'text', text: 'Line two' }] }] });
  assert.equal(result.content[0].text, '{"answer":42}');
  assert.match(f.calls[0].body.input[0].content, /^Return one valid JSON object only\./);
  assert.ok(f.calls[0].body.input[0].content.endsWith('Line one\nLine two'));
});

test('matching-style input carries its JSON instruction inside input, without relying on top-level instructions', async () => {
  const matching = { system: 'Match verified facts. Return valid JSON only.',
    messages: [{ role: 'user', content: 'Return {"matches":[]} using only supplied evidence.' }] };
  const original = structuredClone(matching);
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.input.some(item => item.role === 'user' && /JSON/.test(item.content))) {
      return Response.json({ error: { code: 'invalid_request_error', param: 'input', message: 'Input must mention JSON.' } }, { status: 400 });
    }
    return Response.json(completed());
  } });
  const { result } = await invoke(f, {}, matching);
  assert.equal(result.content[0].text, '{"ok":true}');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].body.input[0].content, /^Return one valid JSON object only\./);
  assert.ok(f.calls[0].body.input[0].content.endsWith(matching.messages[0].content));
  assert.deepEqual(matching, original, 'the caller\'s transcript remains untouched');
});

test('the whole serialized UTF-8 request is bounded before any billable request', async () => {
  for (const input of [
    { system: 'x'.repeat(59000), messages: [{ role: 'user', content: 'y'.repeat(1000) }] },
    { messages: [{ role: 'user', content: 'é'.repeat(31000) }] },
    { messages: [{ role: 'user', content: '\u0000'.repeat(10000) }] },
  ]) {
    const f = fixture();
    const req = {};
    await assert.rejects(invoke(f, req, input), { status: 413, code: 'hosted_ai_input_too_large' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.inference.getUsage(req).costMicroUsd, 0);
  }
  const f = fixture();
  await invoke(f, {}, { messages: [{ role: 'user', content: 'x'.repeat(58000) }] });
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0].body)) <= HOSTED_AI_LIMITS.maxRequestBytes);
});

test('unsupported messages cannot send images, files, tools, or unlimited framing', async () => {
  for (const messages of [[], [{ role: 'tool', content: 'text' }], [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.test/image' }] }],
    Array.from({ length: 17 }, () => ({ role: 'user', content: 'x' }))]) {
    const f = fixture();
    await assert.rejects(invoke(f, {}, { messages }), { code: 'invalid_hosted_ai_input' });
    assert.equal(f.calls.length, 0);
  }
});

test('four-call cap survives getClient calls and keeps jobs separate', async () => {
  const f = fixture();
  const req = {};
  const first = await f.inference.getClient(req);
  const second = await f.inference.getClient(req, 'another-model');
  for (let i = 0; i < 4; i += 1) await (i % 2 ? first : second).messages.create(parameters);
  await assert.rejects(first.messages.create(parameters), { code: 'hosted_ai_call_limit' });
  assert.equal(f.calls.length, 4);
  assert.equal(f.inference.getUsage(req).calls, 4);
  assert.equal(f.inference.getUsage(req).costMicroUsd, 284);
  await invoke(f, {});
  assert.equal(f.calls.length, 5);
  assert.equal(HOSTED_AI_MODEL, 'gpt-6-luna');
  assert.ok(4 * HOSTED_AI_CALL_RESERVATION_MICRO_USD <= HOSTED_AI_JOB_RESERVATION_MICRO_USD);
  assert.equal(HOSTED_AI_JOB_RESERVATION_MICRO_USD, 60000);
});

test('parallel calls within a job are rejected rather than bursting spend', async () => {
  let release;
  let started;
  const sent = new Promise((resolve) => { started = resolve; });
  const f = fixture({ fetchImpl: async () => { started(); await new Promise((resolve) => { release = resolve; }); return Response.json(completed()); } });
  const client = await f.inference.getClient({});
  const first = client.messages.create(parameters);
  await sent;
  await assert.rejects(client.messages.create(parameters), { code: 'hosted_ai_call_in_progress' });
  release();
  await first;
  assert.equal(f.calls.length, 1);
});

test('failed, incomplete, refused, empty, and non-object output is never returned as a usable draft', async (t) => {
  const cases = [
    [completed({ status: 'incomplete' }), 'hosted_ai_response_incomplete'],
    [completed({ status: 'failed', error: { message: 'sensitive provider description' } }), 'hosted_ai_response_incomplete'],
    [completed({ output: [{ type: 'message', status: 'in_progress', content: [] }] }), 'hosted_ai_response_incomplete'],
    [completed({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'sensitive refusal' }] }] }), 'hosted_ai_response_refused'],
    [completed({ output: [] }), 'hosted_ai_empty_response'],
    [textResponse('```json\n{}\n```'), 'hosted_ai_invalid_json'],
    [textResponse('[]'), 'hosted_ai_invalid_json'],
    [textResponse('null'), 'hosted_ai_invalid_json'],
  ];
  for (const [response, code] of cases) {
    await t.test(code, async () => {
      const f = fixture({ response });
      const req = {};
      await assert.rejects(invoke(f, req), (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /sensitive/);
        return true;
      });
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].event.outcome, 'failed');
      assert.equal(f.inference.getUsage(req).costMicroUsd, 71);
    });
  }
});

test('HTTP provider errors never retry, leak provider messages, or settle sent work as zero', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const f = fixture({ fetchImpl: async () => Response.json({ error: { message: 'private resume and synthetic-server-key', code: 'secret_code' } }, { status }) });
    const req = {};
    await assert.rejects(invoke(f, req), (error) => {
      assert.doesNotMatch(error.message, /private resume|synthetic-server-key|secret_code/);
      assert.equal(error.status, status === 429 ? 429 : status === 400 ? 502 : 503);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.length, 1);
    const total = f.inference.getUsage(req);
    assert.equal(total.costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
    assert.equal(total.estimated, true);
  }
});

test('provider diagnostics retain useful allowlisted metadata without error bodies or secrets', async () => {
  const requestId = '11111111-2222-4333-8444-555555555555';
  const providerRequestId = 'req_0123456789abcdef0123456789abcdef';
  const f = fixture({ fetchImpl: async () => Response.json({ error: {
    message: 'private resume synthetic-server-key', code: 'unsupported_parameter', param: 'reasoning.effort',
    type: 'private-type', extra: 'private-body',
  } }, { status: 400, headers: { 'x-request-id': providerRequestId, 'x-private-header': 'private-header' } }) });
  const req = { headers: { 'x-request-id': requestId, authorization: 'Bearer private-bearer' } };
  await assert.rejects(invoke(f, req), { code: 'hosted_ai_request_failed' });
  assert.deepEqual(f.logs, [{ event: 'hosted_provider_error', model: 'gpt-6-luna', callIndex: 1,
    errorName: 'BadRequestError', status: 400, providerCode: 'unsupported_parameter', param: 'reasoning.effort',
    providerRequestId, requestId }]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private|synthetic-server-key|Return a JSON|careful resume/);
  assert.equal(f.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
});

test('unrecognized provider diagnostic fields are omitted even when they resemble identifiers', async () => {
  const f = fixture({ fetchImpl: async () => Response.json({ error: {
    message: 'secret_resume', code: 'secret_resume', param: 'input[0].secret_resume', type: 'secret_resume',
  } }, { status: 400, headers: { 'x-request-id': 'req_secret_resume' } }) });
  await assert.rejects(invoke(f, { headers: { 'x-request-id': 'secret_resume' } }), { code: 'hosted_ai_request_failed' });
  assert.deepEqual(f.logs, [{ event: 'hosted_provider_error', model: 'gpt-6-luna', callIndex: 1,
    errorName: 'BadRequestError', status: 400, providerCode: null, param: null }]);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret_resume/);
});

test('diagnostic logger failure cannot change usage, retry behavior or the sanitized client error', async () => {
  for (const log of [() => { throw new Error('private-log-failure'); }, async () => { throw new Error('private-log-failure'); }]) {
    const f = fixture({ dependencies: { log }, fetchImpl: async () => Response.json({ error: {
      message: 'private provider error', code: 'model_not_found', param: 'model',
    } }, { status: 404 }) });
    const req = {};
    await assert.rejects(invoke(f, req), { code: 'hosted_ai_request_failed', status: 502 });
    assert.equal(f.calls.length, 1);
    assert.equal(f.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
    assert.equal(f.events.length, 1);
  }
});

test('missing or malformed usage is conservatively recorded even when output succeeds', async () => {
  for (const invalidUsage of [undefined, null, {}, { ...usage, input_tokens: -1 }, { ...usage, output_tokens: 1.5 },
    { ...usage, input_tokens_details: { cached_tokens: 1002 } }, { ...usage, total_tokens: 5 }]) {
    const f = fixture({ response: completed({ usage: invalidUsage }) });
    const { req } = await invoke(f);
    assert.equal(f.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
    assert.equal(f.events[0].event.estimated, true);
  }
});

test('measured cost rounds upward and counts cached reads and writes without double-counting reasoning', async () => {
  const f = fixture({ response: completed({ usage: { input_tokens: 1, output_tokens: 0,
    input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }) });
  const { req } = await invoke(f);
  assert.equal(f.inference.getUsage(req).costMicroUsd, 1);
  assert.equal(f.inference.getUsage(req).estimated, false);
});

test('aborting before send incurs no estimate, but aborting a sent call retains the maximum call cost', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = fixture();
  const initialReq = { aiSignal: controller.signal };
  await assert.rejects(invoke(before, initialReq), { code: 'request_cancelled' });
  assert.equal(before.calls.length, 0);
  assert.equal(before.inference.getUsage(initialReq).costMicroUsd, 0);

  const active = new AbortController();
  let started;
  const sent = new Promise((resolve) => { started = resolve; });
  const after = fixture({ fetchImpl: (_url, { signal }) => { started(); return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }); } });
  const req = { aiSignal: active.signal };
  const pending = invoke(after, req);
  await sent;
  assert.equal(after.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
  assert.equal(after.inference.getUsage(req).calls, 1);
  active.abort();
  // The HTTP route's outer deadline may settle its budget before create()
  // resumes from abort. This immediate snapshot must already include the call.
  assert.equal(after.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
  await assert.rejects(pending, { code: 'request_cancelled' });
  assert.equal(after.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
  assert.equal(after.events.length, 1);
});

test('settled usage replaces a pending-call estimate without double charging', async () => {
  let release;
  let started;
  const sent = new Promise((resolve) => { started = resolve; });
  const f = fixture({ fetchImpl: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return Response.json(completed());
  } });
  const req = {};
  const pending = invoke(f, req);
  await sent;
  assert.equal(f.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
  assert.equal(f.inference.getUsage(req).estimated, true);
  release();
  await pending;
  assert.equal(f.inference.getUsage(req).costMicroUsd, 71);
  assert.equal(f.inference.getUsage(req).calls, 1);
  assert.equal(f.inference.getUsage(req).estimated, false);
});

test('deadline covers hung response bodies and records uncertain spent work', async () => {
  const f = fixture({ dependencies: { responseTimeoutMs: 20 }, fetchImpl: (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
  }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) });
  const req = {};
  await assert.rejects(invoke(f, req), { status: 504, code: 'hosted_ai_timeout' });
  assert.equal(f.inference.getUsage(req).costMicroUsd, HOSTED_AI_CALL_RESERVATION_MICRO_USD);
  assert.equal(f.events.length, 1);
});

test('job deadline cannot be reset by obtaining another client', async () => {
  let time = 0;
  const f = fixture({ dependencies: { now: () => time, jobTimeoutMs: 100 } });
  const req = {};
  await f.inference.getClient(req);
  time = 101;
  await assert.rejects(invoke(f, req), { code: 'hosted_ai_timeout' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.inference.getUsage(req).costMicroUsd, 0);
});

test('usage hook failure is sanitized, preserves cost for settlement and blocks more spending', async () => {
  const f = fixture({ onUsage: () => { throw new Error('Private database and token information'); } });
  const req = {};
  await assert.rejects(invoke(f, req), (error) => {
    assert.equal(error.code, 'hosted_ai_accounting_failed');
    assert.doesNotMatch(error.message, /Private database|token information/);
    return true;
  });
  assert.equal(f.inference.getUsage(req).costMicroUsd, 71);
  await assert.rejects(invoke(f, req), { code: 'hosted_ai_accounting_failed' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.length, 1);
});

test('configured deadlines cannot enlarge the fixed server limits', () => {
  assert.throws(() => createOpenAIInference({ responseTimeoutMs: 60001 }), /deadlines/);
  assert.throws(() => createOpenAIInference({ jobTimeoutMs: 240001 }), /deadlines/);
});
