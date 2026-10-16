import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLandwiseApp } from '../server.js';
import { rateLimitError } from '../server/ai-rate-limit.js';
import { jsPDF } from 'jspdf';
import { studentResume, overflowingResume } from './fixtures/resumes.js';

const origin = 'http://127.0.0.1:5174';
const resume = 'Alex Rivera\nalex@example.com\nEXPERIENCE\nEngineer | Northstar\n- Built React dashboards.\nEDUCATION\nBachelor of Science | Western University';
const jobDescription = 'We are hiring a frontend engineer to build React dashboards and work with our product team.';

async function harness(t, inference, options = {}) {
  const app = createLandwiseApp({ auth: { router: express.Router(), getStatus: () => ({ account: { id: 'test-account' } }) }, inference, appOrigin: origin, log: () => {}, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (path, body, requestOrigin = origin) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  post.stream = (body, signal) => fetch(`http://127.0.0.1:${server.address().port}/api/transform`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body), signal,
  });
  post.upload = data => {
    const body = new FormData();
    body.append('resume', new Blob([data], { type: 'application/pdf' }), 'resume.pdf');
    return fetch(`http://127.0.0.1:${server.address().port}/api/parse-pdf`, { method: 'POST', headers: { Origin: origin }, body });
  };
  return post;
}

const transformAnswers = [
  {
    job: { valid: true, roleTitle: 'Frontend engineer', roleLevel: 'entry', requiredSkills: ['React'], niceToHaveSkills: [], mustHaveKeywords: ['React'], requirements: [{ id: 'r1', text: 'React', type: 'skill', priority: 'must_have' }] },
    claims: [{ id: 'c1', text: 'Built React dashboards.', type: 'skill', raw_phrase: 'Built React dashboards.' }],
  },
  { matches: [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'exact', confidence: 1, explanation: 'Source lists React.' }] },
  { edits: [], requirementFeedback: [] },
];

test('untrusted origins cannot start AI or PDF actions', async t => {
  let calls = 0;
  const post = await harness(t, { listModels: () => { calls += 1; } });
  for (const path of ['/api/ai/models', '/api/transform', '/api/parse-pdf']) {
    const result = await post(path, {}, 'https://unrelated.example');
    assert.equal(result.status, 403);
  }
  assert.equal(calls, 0);
});

test('invalid input never requests a ChatGPT client', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: () => { calls += 1; } });
  for (const [path, body] of [
    ['/api/analyze-resume', { resume: 42 }],
    ['/api/transform', { resume, jobDescription: 'short' }],
    ['/api/transform', { resume, jobDescription: { bad: true } }],
  ]) assert.equal((await post(path, body)).status, 400);
  assert.equal(calls, 0);
});

test('signed-out AI calls return a sign-in error, without an API-key fallback', async t => {
  const reject = async () => { throw Object.assign(new Error('Continue with ChatGPT to use your plan in Landwise.'), { status: 401, code: 'chatgpt_signin_required' }); };
  const post = await harness(t, { listModels: reject, getClient: reject });
  for (const [path, body] of [
    ['/api/ai/models', {}], ['/api/analyze-resume', { resume }], ['/api/transform', { resume, jobDescription }],
  ]) {
    const result = await post(path, body);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'chatgpt_signin_required');
    assert.ok(!JSON.stringify(result.body).includes('API_KEY'));
  }
});

test('analysis uses the chosen model and keeps feedback shape', async t => {
  const feedback = { overallScore: 72, sections: [], improvements: [] };
  const post = await harness(t, { getClient: async (req, model) => {
    assert.equal(model, 'account-model');
    assert.ok(req.aiSignal instanceof AbortSignal);
    return { messages: { create: async args => {
      assert.ok(args.messages[0].content.includes(resume));
      assert.equal(args.model, undefined);
      return { content: [{ text: JSON.stringify(feedback) }] };
    } } };
  } });
  const result = await post('/api/analyze-resume', { resume, model: 'account-model' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, feedback);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('transform preserves evidence and export-ready output with ChatGPT adapter', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async (_req, model) => {
    assert.equal(model, 'account-model');
    return { messages: { create: async () => ({ content: [{ text: JSON.stringify(transformAnswers[calls++]) }] }) } };
  } });
  const result = await post('/api/transform', { resume, jobDescription, model: 'account-model' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(calls, 3);
  assert.equal(result.body.transformedResume, resume);
  assert.ok(result.body.resumeClaims.every(claim => resume.includes(claim.raw_phrase)));
  assert.equal(result.body.claim_coverage, 100);
  assert.equal(result.body.pageLimit, 1);
  assert.equal(result.body.pageCount, 1);
});

test('PDF upload returns the real page count without adding page markers to the resume', async t => {
  const post = await harness(t, {});
  for (const count of [1, 2]) {
    const pdf = new jsPDF();
    for (let page = 0; page < count; page++) {
      if (page) pdf.addPage();
      pdf.text(page ? 'EDUCATION' : 'Alex Rivera', 20, 20);
    }
    const response = await post.upload(pdf.output('arraybuffer'));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.pageCount, count);
    assert.match(data.text, /Alex Rivera/);
    assert.doesNotMatch(data.text, /-- \d+ of \d+ --/);
  }
});

test('invalid page limits are rejected before any provider calls', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async () => { calls++; } });
  for (const maxPages of [0, -1, 1.5, 21, '1']) {
    const response = await post('/api/transform', { resume, jobDescription, maxPages });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_page_limit');
  }
  assert.equal(calls, 0);
});

test('overflow receives exactly one sequential shortening pass and the result fits the requested limit', async t => {
  let calls = 0;
  const extraction = { ...transformAnswers[0], claims: [{ id: 'c1', text: 'Built React dashboards for operations.', type: 'skill', raw_phrase: 'Built React dashboards for operations.' }] };
  const longBullet = '- Built React dashboards for operations. ' + 'Worked on useful dashboard interfaces for operations teams. '.repeat(100);
  const longResume = studentResume.replace('- Built React dashboards for operations.', longBullet);
  const lineId = `line-${longResume.split('\n').findIndex(line => line === longBullet)}`;
  const answers = [extraction, transformAnswers[1], { edits: [] }, { edits: [{ lineId, replacement: 'Built React dashboards for operations.' }] }];
  const post = await harness(t, { getClient: async () => ({ messages: { create: async args => {
    if (calls >= 2) assert.match(args.messages[0].content, /LENGTH LIMIT: The finished resume must fit within 1 page/);
    return { content: [{ text: JSON.stringify(answers[calls++]) }] };
  } } }) });
  const response = await post('/api/transform', { resume: longResume, jobDescription, maxPages: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.pageCount, 1);
  assert.equal(response.body.pageLimit, 1);
  assert.equal(calls, 4);
});

test('persistent overflow ends visibly after one shortening pass without returning an oversized resume', async t => {
  let calls = 0;
  const extraction = { ...transformAnswers[0], claims: [{ id: 'c1', text: 'Built React dashboards for operations.', type: 'skill', raw_phrase: 'Built React dashboards for operations.' }] };
  const answers = [extraction, transformAnswers[1], { edits: [] }, { edits: [] }];
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(answers[calls++]) }] }) } }) });
  const response = await post.stream({ resume: overflowingResume, jobDescription, maxPages: 1 });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).code, 'resume_too_long');
  assert.ok(!events.some(event => event.type === 'result'));
  assert.equal(calls, 4);
});

test('progress arrives before AI completion and all three AI requests run sequentially', async t => {
  let releaseExtraction;
  let calls = 0;

  const logs = [];
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => {
    const index = calls++;
    if (index === 0) await new Promise(resolve => { releaseExtraction = resolve; });
    return { content: [{ text: JSON.stringify(transformAnswers[index]) }] };
  } } }) }, { log: line => logs.push(line) });
  const response = await post.stream({ resume, jobDescription });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"type":"progress"/);
  assert.equal(calls, 1, 'no second request starts while extraction is running');
  releaseExtraction();
  let output = new TextDecoder().decode(first.value);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  const events = output.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).result.transformedResume, resume);
  assert.ok(events.at(-1).steps.every(step => step.status === 'completed'));
  assert.equal(calls, 3);
  assert.ok(logs.some(line => line.includes('transform_complete')));
  assert.doesNotMatch(logs.join(''), /Alex|alex@example|Northstar|React/);
});

test('a hung pipeline times out, aborts work and sends a terminal stream error', async t => {
  let signal;
  const post = await harness(t, { getClient: async req => {
    signal = req.aiSignal;
    return new Promise(() => {});
  } }, { transformTimeoutMs: 30 });
  const response = await post.stream({ resume, jobDescription });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, 'transform_timeout');
  assert.equal(signal.aborted, true);
  assert.ok(!events.some(event => event.type === 'result'));
});

test('invalid job content stops matching and writing and cancels outstanding work', async t => {
  let signal;
  let calls = 0;
  const post = await harness(t, { getClient: async req => {
    signal = req.aiSignal;
    return { messages: { create: async () => ({ content: [{ text: JSON.stringify(calls++ === 0 ? { job: { valid: false }, claims: [] } : transformAnswers[1]) }] }) } };
  } });
  const response = await post('/api/transform', { resume, jobDescription });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'invalid_job_description');
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('disconnecting the browser aborts the ongoing pipeline', async t => {
  let aiSignal;
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const post = await harness(t, { getClient: async req => {
    aiSignal = req.aiSignal;
    aiSignal.addEventListener('abort', cancelled, { once: true });
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const response = await post.stream({ resume, jobDescription }, controller.signal);
  await response.body.getReader().read();
  controller.abort();
  await aborted;
  assert.equal(aiSignal.aborted, true);
});

test('usage limits retain recovery links while unexpected errors stay private', async t => {
  let quota = true;
  const post = await harness(t, { listModels: async () => {
    if (quota) throw Object.assign(new Error('Review your ChatGPT app usage limit.'), { status: 429, code: 'subscription_sharing_usage_limit_exceeded', manageUsageUrl: 'https://chatgpt.com/settings/usage' });
    throw new Error('secret-token-and-private-provider-details');
  } });
  const limited = await post('/api/ai/models', {});
  assert.equal(limited.status, 429);
  assert.equal(limited.body.manageUsageUrl, 'https://chatgpt.com/settings/usage');
  quota = false;
  const failed = await post('/api/ai/models', {});
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed.body).includes('secret-token'));
});

test('a provider rate limit ends the pipeline and repeat requests are held locally', async t => {
  let clientCalls = 0;
  let modelCalls = 0;
  let aiCalls = 0;
  const post = await harness(t, {
    listModels: () => { modelCalls++; return []; },
    getClient: async () => {
      clientCalls++;
      return { messages: { create: async () => { aiCalls++; throw rateLimitError(75); } } };
    },
  });
  const first = await post.stream({ resume, jobDescription });
  const events = (await first.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).retryAfterSeconds, 75);
  for (const [path, body] of [['/api/analyze-resume', { resume }], ['/api/transform', { resume, jobDescription }], ['/api/ai/models', {}]]) {
    const repeat = await post(path, body);
    assert.equal(repeat.status, 429);
    assert.equal(repeat.body.code, 'chatgpt_rate_limited');
    assert.ok(Number(repeat.headers.get('retry-after')) > 0);
  }
  assert.equal(aiCalls, 1);
  assert.equal(clientCalls, 1);
  assert.equal(modelCalls, 0);
});

test('Analyze and Transform cannot run together for the same account, and the lock releases', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const post = await harness(t, { getClient: async () => {
    calls++;
    if (calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { messages: { create: async () => ({ content: [{ text: '{"overallScore":70}' }] }) } };
  } });
  const analysis = post('/api/analyze-resume', { resume });
  await started;
  const overlapping = await post('/api/transform', { resume, jobDescription });
  assert.equal(overlapping.status, 409);
  assert.equal(overlapping.body.code, 'ai_request_in_progress');
  assert.equal(calls, 1);
  release();
  assert.equal((await analysis).status, 200);
  assert.equal((await post('/api/analyze-resume', { resume })).status, 200);
});


test('completed transforms auto-save their inputs and report without another AI call', async t => {
  let calls = 0;
  let saved;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(transformAnswers[calls++]) }] }) } }) }, {
    applications: { save: async data => { saved = data; return { id: 'folder-id', versionId: 'version-id' }; } },
  });
  const response = await post('/api/transform', { resume, jobDescription, maxPages: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.body.savedApplication.id, 'folder-id');
  assert.equal(saved.resume, resume);
  assert.equal(saved.jobDescription, jobDescription);
  assert.equal(saved.result.report.score, 100);
  assert.equal(calls, 3);
});

test('storage failure retains the finished draft and exposes a retryable save notice', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(transformAnswers[calls++]) }] }) } }) }, {
    applications: { save: async () => { throw new Error('private-storage-detail'); } },
  });
  const response = await post('/api/transform', { resume, jobDescription });
  assert.equal(response.status, 200);
  assert.equal(response.body.transformedResume, resume);
  assert.match(response.body.saveError, /could not be saved/);
  assert.doesNotMatch(JSON.stringify(response.body), /private-storage-detail/);
});

test('all library reads and mutations require the local authenticated CSRF session', async t => {
  let operations = 0;
  const reject = () => { throw Object.assign(new Error('Reload Landwise before trying again.'), { status: 403, code: 'invalid_csrf' }); };
  const applications = Object.fromEntries(['list', 'get', 'save', 'update', 'remove'].map(key => [key, () => { operations++; }]));
  const post = await harness(t, {}, { auth: { router: express.Router(), requireSession: reject }, applications });
  for (const action of Object.keys(applications)) assert.equal((await post(`/api/applications/${action}`, {})).status, 403);
  assert.equal(operations, 0);
});

test('a model full rewrite cannot bypass preservation by omitting the edit list', async t => {
  let calls = 0;
  const answers = [transformAnswers[0], transformAnswers[1], { transformedResume: resume.replace('Engineer | Northstar', 'Engineer | Different company') }];
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(answers[calls++]) }] }) } }) });
  const response = await post('/api/transform', { resume, jobDescription });
  assert.equal(response.body.code, 'invalid_tailored_resume');
  assert.equal(calls, 3);
});
