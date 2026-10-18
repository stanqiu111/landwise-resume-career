import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { createHostedApp, hostedAppFromEnvironment } from '../server/hosted-app.js';
import { createHostedSecurity } from '../server/hosted-security.js';

const origin = 'http://127.0.0.1:5174';
const userId = '11111111-1111-4111-8111-111111111111';
const token = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url') + '.'
  + Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', exp: 9999999999 })).toString('base64url') + '.signature';
const resume = 'Alex Rivera\nEXPERIENCE\nEngineer | Northstar\n- Built React dashboards.\nEDUCATION\nBachelor of Science';
const payload = { resume, jobDescription: 'We are hiring a frontend engineer to build React dashboards with our product team.', maxPages: 1 };

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function harness(t, options = {}) {
  const events = [], jobs = new Map();
  const store = { save: async () => { events.push('save'); return { id: randomUUID() }; }, list: async () => [{ owner: userId }] };
  const cloudStorage = { publicConfig: { storage: 'supabase', url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' },
    forRequest: async req => {
      if (req.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('Invalid'), { status: 401 });
      return store;
    } };
  const budget = {
    status: async actor => ({ available: true, guestEligible: !actor.userId, remaining: actor.userId ? 3 : 0 }),
    reserve: async input => {
      events.push('reserve');
      const previous = jobs.get(input.requestId);
      if (previous) return { ...previous, admitted: false };
      const receipt = { jobId: randomUUID(), status: 'reserved', admitted: true, input };
      jobs.set(input.requestId, receipt);
      return receipt;
    },
    complete: async input => {
      events.push('complete');
      const job = [...jobs.values()].find(job => job.jobId === input.jobId);
      Object.assign(job, { status: 'completed', result: input.result, actualCostMicrousd: input.actualCostMicrousd });
      return job;
    },
    fail: async input => { events.push(['fail', input.actualCostMicrousd]); },
    acquireUpload: async () => { events.push('upload'); return true; },
    ...options.budget,
  };
  const inference = { getClient: async () => { events.push('provider'); return {}; }, getUsage: () => ({ costMicroUsd: 1234 }), ...options.inference };
  const security = createHostedSecurity({ appOrigin: origin, sessionSecret: 's'.repeat(48), cloudStorage });
  const app = createHostedApp({ security, budget, inference, cloudStorage, enabled: true, log: () => {},
    transform: async () => ({ transformedResume: resume, pageCount: 1, pageLimit: 1 }),
    analyze: async () => ({ overallScore: 70 }), ...options.app });
  const base = await serve(t, app);
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const csrf = (await session.json()).csrfToken;
  const headers = { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Request-ID': randomUUID(), 'Content-Type': 'application/json' };
  const post = async (path = '/api/transform', body = payload, overrides = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { base, post, headers, events, jobs, budget };
}

test('guest first transform reserves before inference and settles before result; completed retry is free', async t => {
  const h = await harness(t);
  const first = await h.post();
  assert.equal(first.status, 200);
  assert.equal(first.body.pageCount, 1);
  assert.deepEqual(h.events, ['reserve', 'provider', 'complete']);
  assert.deepEqual(await h.post(), first);
  assert.deepEqual(h.events, ['reserve', 'provider', 'complete', 'reserve']);
  assert.equal([...h.jobs.values()][0].actualCostMicrousd, 1234);
});

test('pending replay never starts another provider request', async t => {
  const h = await harness(t, { budget: { reserve: async () => ({ jobId: randomUUID(), status: 'reserved', admitted: false }) } });
  assert.equal((await h.post()).status, 409);
  assert.deepEqual(h.events, []);
});

test('origin, cookie, CSRF, input and bad bearer fail before budget or provider', async t => {
  const h = await harness(t);
  for (const headers of [{ Origin: 'https://evil.example' }, { Cookie: '' }, { 'X-CSRF-Token': 'wrong' }, { Authorization: 'Bearer fake' }]) {
    assert.ok([401, 403].includes((await h.post('/api/transform', payload, headers)).status));
  }
  assert.equal((await h.post('/api/transform', { ...payload, resume: 'a'.repeat(30001) })).status, 400);
  assert.equal((await h.post('/api/transform', { ...payload, maxPages: 21 })).status, 400);
  assert.deepEqual(h.events, []);
});

test('guest cannot analyze, revise or access saved applications; verified user owns save', async t => {
  const h = await harness(t);
  assert.equal((await h.post('/api/analyze-resume', { resume })).status, 401);
  assert.equal((await h.post('/api/applications/list', {})).status, 401);
  const result = await h.post('/api/transform', { ...payload, userId: 'spoofed' }, { Authorization: `Bearer ${token}` });
  assert.equal(result.status, 200);
  assert.ok(result.body.savedApplication.id);
  assert.deepEqual(h.events, ['reserve', 'provider', 'save', 'complete']);
  const job = [...h.jobs.values()][0];
  assert.equal(job.input.userId, userId);
  assert.equal(job.input.guestHash, undefined);
});

test('budget rejection prevents all provider work', async t => {
  const h = await harness(t, { budget: { reserve: async () => { throw Object.assign(new Error('Budget reached'), { status: 429, code: 'hosted_ai_budget_limit' }); } } });
  assert.equal((await h.post()).status, 429);
  assert.deepEqual(h.events, []);
});

test('failed generation charges measured usage, sanitizes unknown errors and sends no result', async t => {
  const h = await harness(t, { app: { transform: async () => { throw new Error('private resume and provider credential'); } } });
  const result = await h.post();
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result), /private resume|provider credential/);
  assert.deepEqual(h.events, ['reserve', 'provider', ['fail', 1234]]);
});

test('failed settlement never reports success and remains visible for reconciliation', async t => {
  const h = await harness(t, { budget: { complete: async () => { throw new Error('database down'); }, fail: async () => { throw new Error('database down'); } } });
  assert.equal((await h.post()).status, 502);
  assert.equal([...h.jobs.values()][0].status, 'reserved');
});

test('streaming publishes progress and a result only after settlement', async t => {
  const h = await harness(t);
  const response = await fetch(h.base + '/api/transform', { method: 'POST', headers: { ...h.headers, Accept: 'application/x-ndjson' }, body: JSON.stringify(payload) });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'progress'));
  assert.equal(events.at(-1).type, 'result');
  assert.equal(h.events.at(-1), 'complete');
});

test('PDF parsing uses shared admission and rejects over20pages or2MB', async t => {
  const h = await harness(t);
  const upload = async bytes => {
    const form = new FormData();
    form.append('resume', new Blob([bytes], { type: 'application/pdf' }), 'resume.pdf');
    const headers = { ...h.headers }; delete headers['Content-Type'];
    return fetch(h.base + '/api/parse-pdf', { method: 'POST', headers, body: form });
  };
  const pdf = new jsPDF(); pdf.text('Alex Rivera', 20, 20);
  const response = await upload(pdf.output('arraybuffer'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pageCount, 1);
  for (let index = 1; index < 21; index++) pdf.addPage();
  assert.equal((await upload(pdf.output('arraybuffer'))).status, 400);
  assert.equal((await upload(Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
  assert.deepEqual(h.events, ['upload', 'upload', 'upload']);
});

test('unconfigured production is honest and cannot expose owner login routes', async t => {
  const base = await serve(t, hostedAppFromEnvironment({}));
  const session = await (await fetch(base + '/api/session')).json();
  assert.equal(session.available, false);
  assert.equal(session.csrfToken, null);
  for (const path of ['/api/auth/session', '/api/auth/login', '/api/ai/models']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/api/transform', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 503);
});
