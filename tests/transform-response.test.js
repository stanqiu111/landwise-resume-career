import test from 'node:test';
import assert from 'node:assert/strict';
import { readTransformResponse } from '../src/transformResponse.js';

function streamResponse(events, fragment = 11) {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('fragmented progress and unicode result are decoded without waiting for a closed connection', async () => {
  const updates = [];
  const result = { transformedResume: 'Zoë — Développeuse' };
  const response = streamResponse([{ type: 'progress', steps: [{ label: 'Writing' }] }, { type: 'result', result, elapsedMs: 500 }], 1);
  assert.deepEqual(await readTransformResponse(response, update => updates.push(update)), result);
  assert.equal(updates[0].steps[0].label, 'Writing');
  assert.equal(updates.at(-1).complete, true);
});

test('an interrupted stream cannot silently become a blank result', async () => {
  await assert.rejects(readTransformResponse(streamResponse([{ type: 'progress' }]), () => {}), /ended before your resume was ready/);
});

test('stream failures preserve timeout and quota recovery details', async () => {
  await assert.rejects(readTransformResponse(streamResponse([{ type: 'error', error: 'Usage limit reached.', code: 'quota', manageUsageUrl: 'https://chatgpt.com/settings/usage' }]), () => {}), { code: 'quota', manageUsage: true });
});

test('JSON errors and empty success payloads are reported', async () => {
  await assert.rejects(readTransformResponse(Response.json({ error: 'Session expired.', code: 'session_required' }, { status: 401 }), () => {}), { code: 'session_required' });
  await assert.rejects(readTransformResponse(Response.json({}), () => {}), /did not contain a resume/);
});

test('both response formats preserve the retry delay for the UI cooldown', async () => {
  const error = { error: 'Wait before retrying.', code: 'chatgpt_rate_limited', retryAfterSeconds: 75 };
  for (const response of [Response.json(error, { status: 429 }), streamResponse([{ type: 'error', ...error }])]) {
    await assert.rejects(readTransformResponse(response, () => {}), { code: error.code, retryAfterSeconds: 75 });
  }
});
