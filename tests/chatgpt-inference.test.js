import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createChatGPTInference } from '../server/chatgpt-inference.js';

test('the response deadline covers a stalled SDK body after successful headers', async () => {
  let providerSignal;
  let providerRequests = 0;
  const adapter = createChatGPTInference({
    getAccessToken: async () => 'test-token',
    responseTimeoutMs: 30,
    fetchImpl: async () => Response.json({ models: visibleModels }),
    createOpenAIClient: options => new OpenAI({ ...options, fetch: async (_url, { signal }) => {
      providerRequests += 1;
      providerSignal = signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PRIVATE_PARTIAL"}\n\n'));
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
        // Headers and a partial token arrived, but the provider never finishes.
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } }),
  });
  const client = await adapter.getClient(request);
  await assert.rejects(client.messages.create(prompt), error => {
    assert.equal(error.code, 'chatgpt_response_timeout');
    assert.equal(error.status, 504);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerRequests, 1, 'timeouts do not automatically spend another request');
});

test('response cancellation interrupts a stalled body without waiting for the deadline', async () => {
  const controller = new AbortController();
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const adapter = createChatGPTInference({
    getAccessToken: async () => 'test-token',
    fetchImpl: async () => Response.json({ models: visibleModels }),
    createOpenAIClient: () => ({ responses: { create: async () => ({ async *[Symbol.asyncIterator]() {
      bodyStarted();
      await new Promise(() => {});
    } }) } }),
  });
  const client = await adapter.getClient({ aiSignal: controller.signal });
  const pending = client.messages.create(prompt);
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'request_cancelled', status: 499 });
});

const request = { session: 'test-session' };
const visibleModels = [
  { slug: 'account-first', display_name: 'First model', visibility: 'list' },
  { slug: 'account-second', display_name: 'Second model', visibility: 'list' },
];
const prompt = { model: 'legacy-claude-model', max_tokens: 100, system: 'Return JSON.', messages: [{ role: 'user', content: 'A sample resume.' }] };

function fixture({ models = visibleModels, modelResponse, events, streamError, inferenceError, getAccessToken, streamFinalizer } = {}) {
  const calls = { catalog: [], client: [], inference: [], inferenceOptions: [], auth: [] };
  const adapter = createChatGPTInference({
    getAccessToken: getAccessToken ?? (async req => { calls.auth.push(req); return 'test-account-token'; }),
    fetchImpl: async (...args) => {
      calls.catalog.push(args);
      return modelResponse ?? { ok: true, status: 200, json: async () => ({ models }) };
    },
    createOpenAIClient: options => {
      calls.client.push(options);
      return { responses: { create: async (body, options) => {
        calls.inference.push(body);
        calls.inferenceOptions.push(options);
        if (inferenceError) throw inferenceError;
        return (async function* () {
          for (const event of events ?? [{ type: 'response.completed', response: { status: 'completed', output_text: '{"ok":true}' } }]) yield event;
          streamFinalizer?.();
          if (streamError) throw streamError;
        })();
      } } };
    },
  });
  return { adapter, calls };
}

test('HTTP and streamed rate limits retain cooldown guidance without exposing provider text', async t => {
  for (const [name, options, wait] of [
    ['HTTP 429', { inferenceError: { status: 429, headers: new Headers({ 'retry-after': '91' }), error: { code: 'rate_limit_exceeded', message: 'PRIVATE' } } }, 91],
    ['streamed failure', { events: [{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'PRIVATE' } } }] }, 60],
    ['streamed slowdown', { events: [{ type: 'error', code: 'slow_down', message: 'PRIVATE' }] }, 60],
    ['admission 429', { modelResponse: { ok: false, status: 429, headers: new Headers({ 'retry-after': '180' }), json: async () => ({ detail: 'PRIVATE' }) } }, 180],
  ]) {
    await t.test(name, async () => {
      const { adapter, calls } = fixture(options);
      await assert.rejects((async () => {
        const client = await adapter.getClient(request);
        await client.messages.create(prompt);
      })(), error => {
        assert.equal(error.status, 429);
        assert.equal(error.code, 'chatgpt_rate_limited');
        assert.equal(error.retryAfterSeconds, wait);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
        return true;
      });
      assert.ok(calls.inference.length <= 1, 'never retries automatically');
    });
  }
});

test('plan allowance exhaustion remains distinct from temporary request limits', async () => {
  const { adapter } = fixture({ inferenceError: { status: 429, headers: new Headers({ 'retry-after': '30' }), error: { code: 'subscription_sharing_usage_limit_exceeded' } } });
  const client = await adapter.getClient(request);
  await assert.rejects(client.messages.create(prompt), error => {
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(error.manageUsageUrl, 'https://chatgpt.com/settings/usage');
    assert.equal(error.retryAfterSeconds, undefined);
    return true;
  });
});

test('model catalog uses account bearer token, visible choices, and server order', async () => {
  const { adapter, calls } = fixture({ models: [
    visibleModels[1], { slug: 'hidden', visibility: 'hidden' }, visibleModels[0],
    { slug: 'account-first', display_name: 'Duplicate', visibility: 'list' },
    { slug: '', visibility: 'list' }, { slug: 'fallback-label', visibility: 'list' }, null,
  ] });
  assert.deepEqual(await adapter.listModels(request), [
    { slug: 'account-second', displayName: 'Second model' },
    { slug: 'account-first', displayName: 'First model' },
    { slug: 'fallback-label', displayName: 'fallback-label' },
  ]);
  assert.equal(calls.catalog[0][0], 'https://api.openai.com/v1/models');
  assert.equal(calls.catalog[0][1].headers.Authorization, 'Bearer test-account-token');
  assert.equal(calls.auth[0], request);
});

test('Responses adapter selects the first account model and omits unsupported legacy fields', async () => {
  const { adapter, calls } = fixture();
  const client = await adapter.getClient(request);
  assert.deepEqual(await client.messages.create(prompt), { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
  assert.deepEqual(calls.inference[0], {
    model: 'account-first', input: prompt.messages, instructions: 'Return JSON.', store: false, stream: true,
  });
  assert.deepEqual(calls.client[0], { apiKey: 'test-account-token', baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 120000 });
});

test('selected model is validated once per top-level request and credentials refreshed for each step', async () => {
  const { adapter, calls } = fixture();
  const client = await adapter.getClient(request, 'account-second');
  await client.messages.create(prompt);
  await client.messages.create(prompt);
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.inference[1].model, 'account-second');
  assert.equal(calls.auth.length, 3);
  await adapter.getClient(request, 'account-first');
  assert.equal(calls.catalog.length, 2);
});

test('unavailable model cannot make an inference request', async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.getClient(request, 'invented-model'), { status: 400, code: 'chatgpt_model_unavailable' });
  assert.equal(calls.inference.length, 0);
  const empty = fixture({ models: [] });
  await assert.rejects(empty.adapter.getClient(request), { code: 'chatgpt_model_unavailable' });
});

test('final completed output wins over streamed deltas and combines message text', async () => {
  const { adapter } = fixture({ events: [
    { type: 'response.output_text.delta', delta: 'partial draft' },
    { type: 'response.completed', response: { status: 'completed', output: [
      { type: 'reasoning', summary: [{ text: 'Do not include.' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Complete ' }, { type: 'output_text', text: 'answer' }] },
    ] } },
  ] });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('deltas can be used only after completion when the final body is omitted', async () => {
  const { adapter } = fixture({ events: [
    { type: 'response.output_text.delta', delta: 'Complete ' },
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.completed' },
  ] });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('interrupted, incomplete, failed, and thrown streams never return partial output', async t => {
  const partial = { type: 'response.output_text.delta', delta: 'SENSITIVE_PARTIAL_RESUME' };
  for (const [name, options, code] of [
    ['ended early', { events: [partial] }, 'chatgpt_stream_interrupted'],
    ['incomplete', { events: [partial, { type: 'response.incomplete' }] }, 'chatgpt_response_incomplete'],
    ['failed', { events: [partial, { type: 'response.failed', response: { error: { code: 'provider_internal', message: 'SENSITIVE_TOKEN' } } }] }, 'chatgpt_request_failed'],
    ['explicit error', { events: [partial, { type: 'error', message: 'SENSITIVE_TOKEN' }] }, 'chatgpt_request_failed'],
    ['network error', { events: [partial], streamError: new Error('SENSITIVE_TOKEN') }, 'chatgpt_request_failed'],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture(options);
      const client = await adapter.getClient(request);
      await assert.rejects(client.messages.create(prompt), error => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /SENSITIVE/);
        assert.doesNotMatch(JSON.stringify(error), /SENSITIVE/);
        return true;
      });
    });
  }
});

test('usage limit arriving after text streaming includes Manage usage guidance', async () => {
  const { adapter } = fixture({ events: [
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private provider detail' } } },
  ] });
  const client = await adapter.getClient(request);
  await assert.rejects(client.messages.create(prompt), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(error.manageUsageUrl, 'https://chatgpt.com/settings/usage');
    assert.match(error.message, /Manage usage/);
    assert.doesNotMatch(error.message, /private provider detail/);
    return true;
  });
});

test('temporary usage and eligibility failures are not treated as expired credentials', async t => {
  for (const [code, status] of [
    ['subscription_sharing_usage_unavailable', 503],
    ['subscription_sharing_user_unavailable', 503],
    ['subscription_sharing_user_not_eligible', 403],
    ['chatpass_v2_scope_not_authorized', 403],
  ]) {
    await t.test(code, async () => {
      const { adapter } = fixture({ inferenceError: { error: { code, message: 'private' } } });
      const client = await adapter.getClient(request);
      await assert.rejects(client.messages.create(prompt), error => {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /reconnect|private/i);
        return true;
      });
    });
  }
});

test('nonstandard admission errors are safely classified by status', async t => {
  for (const [status, code] of [[401, 'chatgpt_authentication_failed'], [403, 'chatgpt_permission_denied'], [503, 'chatgpt_unavailable']]) {
    await t.test(String(status), async () => {
      const { adapter } = fixture({ modelResponse: { ok: false, status, json: async () => ({ detail: 'private token payload' }) } });
      await assert.rejects(adapter.listModels(request), error => {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private token payload/);
        return true;
      });
    });
  }
});

test('missing token and malformed catalog stop requests', async () => {
  const missing = fixture({ getAccessToken: async () => null });
  await assert.rejects(missing.adapter.listModels(request), { status: 401 });
  assert.equal(missing.calls.catalog.length, 0);
  const malformed = fixture({ modelResponse: { ok: true, status: 200, json: async () => ({ data: [] }) } });
  await assert.rejects(malformed.adapter.listModels(request), { code: 'chatgpt_request_failed' });
});

test('completed responses with an empty output list use finished output items', async () => {
  const { adapter } = fixture({ events: [
    { type: 'response.output_text.delta', delta: 'Complete ' },
    { type: 'response.output_item.done', item: { type: 'reasoning', summary: [{ text: 'Do not include.' }] } },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'Complete answer' }] } },
    { type: 'response.completed', response: { status: 'completed', output: [], output_text: '' } },
  ] });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('completed responses with an empty output list fall back to deltas, then fail when nothing was produced', async () => {
  const deltas = fixture({ events: [
    { type: 'response.output_text.delta', delta: 'Complete ' },
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ] });
  const client = await deltas.adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');

  const empty = fixture({ events: [
    { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ] });
  const emptyClient = await empty.adapter.getClient(request);
  await assert.rejects(emptyClient.messages.create(prompt), { code: 'chatgpt_empty_response' });
});

function outputText(text) {
  return { type: 'output_text', text, annotations: [], logprobs: [] };
}

function outputMessage(id, text, extra = {}) {
  return { id, type: 'message', role: 'assistant', status: 'completed', content: [outputText(text)], ...extra };
}

function completedEvents(events, output = []) {
  return [...events, { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output } }]
    .map((event, sequence_number) => ({ ...event, sequence_number }));
}

test('finalized text and content-part events recover text from an empty completion', async t => {
  for (const [name, event] of [
    ['text done', { type: 'response.output_text.done', text: 'Complete answer', logprobs: [] }],
    ['content part done', { type: 'response.content_part.done', part: outputText('Complete answer') }],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture({ events: completedEvents([
        { ...event, item_id: 'msg_answer', output_index: 0, content_index: 0 },
      ]) });
      const client = await adapter.getClient(request);
      assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
    });
  }
});

test('interleaved output and content indexes assemble in response order', async () => {
  const { adapter } = fixture({ events: completedEvents([
    { type: 'response.output_text.delta', item_id: 'msg_second', output_index: 1, content_index: 0, delta: 'third' },
    { type: 'response.output_text.delta', item_id: 'msg_first', output_index: 0, content_index: 1, delta: 'sec' },
    { type: 'response.output_text.delta', item_id: 'msg_first', output_index: 0, content_index: 0, delta: 'first ' },
    { type: 'response.output_text.delta', item_id: 'msg_first', output_index: 0, content_index: 1, delta: 'ond ' },
  ]) });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'first second third');
});

test('finalized text replaces its deltas without losing other content parts', async () => {
  const { adapter } = fixture({ events: completedEvents([
    { type: 'response.output_text.delta', item_id: 'msg_answer', output_index: 0, content_index: 0, delta: 'partial draft ' },
    { type: 'response.output_text.delta', item_id: 'msg_answer', output_index: 0, content_index: 1, delta: 'answer' },
    { type: 'response.output_text.done', item_id: 'msg_answer', output_index: 0, content_index: 0, text: 'Complete ', logprobs: [] },
    { type: 'response.content_part.done', item_id: 'msg_answer', output_index: 0, content_index: 0, part: outputText('Complete ') },
  ]) });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('repeated finalized representations of one message do not duplicate its text', async () => {
  const item = outputMessage('msg_answer', 'Complete answer');
  const { adapter } = fixture({ events: completedEvents([
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'partial' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'Complete answer', logprobs: [] },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: outputText('Complete answer') },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
  ]) });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('finished items and finalized text for separate items are both preserved', async () => {
  const { adapter } = fixture({ events: completedEvents([
    { type: 'response.output_item.done', output_index: 1, item: outputMessage('msg_second', 'answer') },
    { type: 'response.output_text.done', item_id: 'msg_first', output_index: 0, content_index: 0, text: 'Complete ', logprobs: [] },
  ]) });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('authoritative completed messages discard stale streamed content parts', async t => {
  const item = outputMessage('msg_answer', 'Complete answer');
  const fragments = [
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'old draft' },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 1, delta: ' stale extra part' },
  ];
  for (const [name, events] of [
    ['completed body', completedEvents(fragments, [item])],
    ['finished item', completedEvents([...fragments, { type: 'response.output_item.done', output_index: 0, item }])],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture({ events });
      const client = await adapter.getClient(request);
      assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
    });
  }
});

test('a populated completed body is authoritative over stale streamed output items', async () => {
  const { adapter } = fixture({ events: completedEvents([
    { type: 'response.output_text.delta', item_id: 'msg_answer', output_index: 0, content_index: 0, delta: 'old draft' },
    { type: 'response.output_text.delta', item_id: 'msg_stale', output_index: 1, content_index: 0, delta: ' stale extra message' },
  ], [outputMessage('msg_answer', 'Complete answer')]) });
  const client = await adapter.getClient(request);
  assert.equal((await client.messages.create(prompt)).content[0].text, 'Complete answer');
});

test('final-answer messages exclude intermediate commentary in completed bodies and item events', async t => {
  const commentary = outputMessage('msg_commentary', 'I will inspect the resume.', { phase: 'commentary' });
  const answer = outputMessage('msg_answer', '{"ok":true}', { phase: 'final_answer' });
  for (const [name, events] of [
    ['completed body', completedEvents([], [commentary, answer])],
    ['finished items', completedEvents([
      { type: 'response.output_item.done', output_index: 0, item: commentary },
      { type: 'response.output_item.done', output_index: 1, item: answer },
    ])],
    ['item metadata and finalized text', completedEvents([
      { type: 'response.output_item.added', output_index: 0, item: { ...commentary, status: 'in_progress', content: [] } },
      { type: 'response.output_text.done', item_id: commentary.id, output_index: 0, content_index: 0, text: commentary.content[0].text, logprobs: [] },
      { type: 'response.output_item.added', output_index: 1, item: { ...answer, status: 'in_progress', content: [] } },
      { type: 'response.output_text.done', item_id: answer.id, output_index: 1, content_index: 0, text: answer.content[0].text, logprobs: [] },
    ])],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture({ events });
      const client = await adapter.getClient(request);
      assert.equal((await client.messages.create(prompt)).content[0].text, '{"ok":true}');
    });
  }
});

test('commentary alone is not accepted as the requested answer', async t => {
  const commentary = outputMessage('msg_commentary', 'I will inspect the resume.', { phase: 'commentary' });
  for (const [name, events] of [
    ['completed body', completedEvents([], [commentary])],
    ['finished item with deltas', completedEvents([
      { type: 'response.output_text.delta', item_id: commentary.id, output_index: 0, content_index: 0, delta: commentary.content[0].text },
      { type: 'response.output_item.done', output_index: 0, item: commentary },
    ])],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture({ events });
      const client = await adapter.getClient(request);
      await assert.rejects(client.messages.create(prompt), { code: 'chatgpt_empty_response' });
    });
  }
});

test('refusals produce a sanitized refusal error instead of an empty or partial answer', async t => {
  const refusal = { type: 'refusal', refusal: 'PRIVATE_PROVIDER_REFUSAL' };
  const item = outputMessage('msg_refusal', '', { content: [refusal] });
  const partial = { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'PRIVATE_PARTIAL_ANSWER' };
  for (const [name, events] of [
    ['completed body', completedEvents([partial], [item])],
    ['finished item', completedEvents([partial, { type: 'response.output_item.done', output_index: 0, item }])],
    ['finished part', completedEvents([partial, { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: refusal }])],
    ['refusal done', completedEvents([partial, { type: 'response.refusal.done', item_id: item.id, output_index: 0, content_index: 0, refusal: refusal.refusal }])],
    ['refusal delta', completedEvents([partial, { type: 'response.refusal.delta', item_id: item.id, output_index: 0, content_index: 0, delta: refusal.refusal }])],
  ]) {
    await t.test(name, async () => {
      const { adapter } = fixture({ events });
      const client = await adapter.getClient(request);
      await assert.rejects(client.messages.create(prompt), error => {
        assert.equal(error.status, 422);
        assert.equal(error.code, 'chatgpt_response_refused');
        assert.doesNotMatch(error.message, /PRIVATE/);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
        return true;
      });
    });
  }
});

test('unfinished messages cannot be rescued by an otherwise completed response', async t => {
  for (const status of ['incomplete', 'in_progress']) {
    const item = outputMessage('msg_unfinished', 'PRIVATE_PARTIAL_ANSWER', { status });
    for (const [name, events] of [
      ['completed body', completedEvents([], [item])],
      ['finished item', completedEvents([{ type: 'response.output_item.done', output_index: 0, item }])],
    ]) {
      await t.test(`${status} in ${name}`, async () => {
        const { adapter } = fixture({ events });
        const client = await adapter.getClient(request);
        await assert.rejects(client.messages.create(prompt), error => {
          assert.equal(error.code, 'chatgpt_response_incomplete');
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
          return true;
        });
      });
    }
  }
});

test('finalized text still requires successful terminal completion', async t => {
  const text = 'PRIVATE_FINALIZED_TEXT';
  for (const [source, done] of [
    ['text done', { type: 'response.output_text.done', text, logprobs: [] }],
    ['part done', { type: 'response.content_part.done', part: outputText(text) }],
  ]) {
    const event = { ...done, item_id: 'msg_answer', output_index: 0, content_index: 0, sequence_number: 0 };
    for (const [ending, options, code] of [
      ['ended early', { events: [event] }, 'chatgpt_stream_interrupted'],
      ['incomplete', { events: [event, { type: 'response.incomplete', response: { status: 'incomplete' } }] }, 'chatgpt_response_incomplete'],
      ['failed', { events: [event, { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'PRIVATE_ERROR' } } }] }, 'chatgpt_request_failed'],
      ['error after completion', { events: [...completedEvents([event]), { type: 'error', code: 'server_error', message: 'PRIVATE_ERROR' }] }, 'chatgpt_request_failed'],
      ['network error after completion', { events: completedEvents([event]), streamError: new Error('PRIVATE_ERROR') }, 'chatgpt_request_failed'],
    ]) {
      await t.test(`${source}: ${ending}`, async () => {
        const { adapter } = fixture(options);
        const client = await adapter.getClient(request);
        await assert.rejects(client.messages.create(prompt), error => {
          assert.equal(error.code, code);
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
          return true;
        });
      });
    }
  }
});

test('text blocks and prior assistant messages retain their roles without system items', async () => {
  const { adapter, calls } = fixture();
  const client = await adapter.getClient(request);
  await client.messages.create({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] }, { role: 'user', content: 'Continue.' }] });
  assert.deepEqual(calls.inference[0].input, [{ role: 'assistant', content: 'First\nSecond' }, { role: 'user', content: 'Continue.' }]);
  assert.equal('instructions' in calls.inference[0], false);
  await assert.rejects(client.messages.create({ messages: [{ role: 'system', content: 'Wrong role' }] }), { code: 'invalid_chatgpt_input' });
  assert.equal(calls.inference.length, 1);
});

test('a cancelled request stops before credentials or provider calls are used', async () => {
  const controller = new AbortController();
  controller.abort(new Error('SENSITIVE_CANCELLATION_REASON'));
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.getClient({ aiSignal: controller.signal }), error => {
    assert.equal(error.status, 499);
    assert.equal(error.code, 'request_cancelled');
    assert.doesNotMatch(JSON.stringify(error), /SENSITIVE/);
    return true;
  });
  assert.equal(calls.auth.length, 0);
  assert.equal(calls.catalog.length, 0);
});

test('request cancellation reaches an in-flight model catalog fetch', async () => {
  const controller = new AbortController();
  let startFetch;
  const started = new Promise(resolve => { startFetch = resolve; });
  let fetchSignal;
  const adapter = createChatGPTInference({
    getAccessToken: async () => 'test-account-token',
    fetchImpl: async (_url, { signal }) => {
      fetchSignal = signal;
      startFetch();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_REASON')), { once: true }));
    },
  });
  const pending = adapter.listModels({ aiSignal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { status: 499, code: 'request_cancelled' });
  assert.equal(fetchSignal.aborted, true);
});

test('the SDK receives the request signal and cancellation after completion still discards output', async () => {
  const controller = new AbortController();
  const { adapter, calls } = fixture({ streamFinalizer: () => controller.abort() });
  const client = await adapter.getClient({ aiSignal: controller.signal });
  await assert.rejects(client.messages.create(prompt), { status: 499, code: 'request_cancelled' });
  assert.equal(calls.inferenceOptions[0].signal.aborted, true);
  assert.equal(calls.inferenceOptions[0].signal.reason, controller.signal.reason);
  assert.equal(calls.catalog[0][1].signal.aborted, true);
});

test('a cancelled pipeline step makes no subsequent inference calls', async () => {
  const controller = new AbortController();
  const { adapter, calls } = fixture();
  const client = await adapter.getClient({ aiSignal: controller.signal });
  controller.abort();
  await assert.rejects(client.messages.create(prompt), { status: 499, code: 'request_cancelled' });
  assert.equal(calls.inference.length, 0);
});

test('stream abort errors are sanitized as cancellation without leaking their descriptions', async () => {
  const { adapter } = fixture({
    events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    streamError: Object.assign(new Error('PRIVATE_ABORT_REASON'), { name: 'AbortError' }),
  });
  const client = await adapter.getClient(request);
  await assert.rejects(client.messages.create(prompt), error => {
    assert.equal(error.status, 499);
    assert.equal(error.code, 'request_cancelled');
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});
