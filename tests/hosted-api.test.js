import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { createHostedApp, hostedAppFromEnvironment } from '../server/hosted-app.js';
import { createHostedSecurity } from '../server/hosted-security.js';
import { ACCOUNT_MONTHLY_ACTIONS, GUEST_TAILORINGS } from '../server/hosted-budget.js';

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
    status: async actor => ({ available: true, guestEligible: !actor.userId, remaining: actor.userId ? ACCOUNT_MONTHLY_ACTIONS : GUEST_TAILORINGS }),
    reserve: async input => {
      events.push('reserve');
      const previous = jobs.get(input.requestId);
      if (previous) return { ...previous, admitted: false };
      const receipt = { jobId: randomUUID(), status: 'reserved', admitted: true, reservedCostMicrousd: 60000, input };
      jobs.set(input.requestId, receipt);
      return receipt;
    },
    complete: async input => {
      events.push('complete');
      const job = [...jobs.values()].find(job => job.jobId === input.jobId);
      Object.assign(job, { status: 'completed', result: input.result, actualCostMicrousd: input.actualCostMicrousd, chargedCostMicrousd: input.actualCostMicrousd });
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

test('the session reports 15 free tailorings for a browser and 3 monthly actions for an account', async t => {
  const h = await harness(t);
  const guestSession = await (await fetch(`${h.base}/api/session`)).json();
  assert.equal(guestSession.authenticated, false);
  assert.equal(guestSession.limit, 15);
  const accountSession = await (await fetch(`${h.base}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(accountSession.authenticated, true);
  assert.equal(accountSession.limit, 3);
});

test('settlement and replay logs contain committed receipt metadata only', async t => {
  const logs = [];
  const h = await harness(t, { app: { log: value => logs.push(JSON.parse(value)) } });
  assert.equal((await h.post()).status, 200);
  assert.equal((await h.post()).status, 200);
  const receipt = [...h.jobs.values()][0];
  const ledgerLogs = logs.filter(item => item.event.startsWith('hosted_ai_'));
  const metadata = { requestId: h.headers['X-Request-ID'], jobId: receipt.jobId, status: 'completed',
    reservedCostMicrousd: 60000, chargedCostMicrousd: 1234 };
  assert.deepEqual(ledgerLogs, [{ event: 'hosted_ai_settled', ...metadata }, { event: 'hosted_ai_replayed', ...metadata }]);
  for (const sensitive of [resume, payload.jobDescription, h.headers.Cookie, h.headers['X-CSRF-Token'], receipt.input.guestHash, receipt.input.ipHash]) {
    assert.ok(!JSON.stringify(logs).includes(sensitive), 'private content and identity hashes are excluded');
  }
  assert.deepEqual(h.events, ['reserve', 'provider', 'complete', 'reserve']);
});

test('failed settlement logs only the charge confirmed by the ledger', async t => {
  const logs = [];
  const h = await harness(t, { app: {
    log: value => logs.push(JSON.parse(value)),
    transform: async () => { throw new Error('private provider failure'); },
  }, budget: { fail: async input => ({ jobId: input.jobId, status: 'failed', reservedCostMicrousd: 60000,
    chargedCostMicrousd: 13625, result: { secret: 'private receipt content' } }) } });
  assert.equal((await h.post()).status, 502);
  const entry = logs.find(item => item.event === 'hosted_ai_settled');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.chargedCostMicrousd, 13625, 'log the confirmed receipt, not a recomputed estimate');
  assert.doesNotMatch(JSON.stringify(logs), /private provider|private receipt|secret/);
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

test('hosted secret alias is server-only, case-sensitive and never overrides canonical key validation', async t => {
  const environment = {
    LANDWISE_APP_ORIGIN: origin, LANDWISE_SESSION_SECRET: 's'.repeat(48),
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    OPENAI_API_KEY: 'sk-proj-test_not_a_real_provider_key', LANDWISE_HOSTED_AI_ENABLED: 'true',
  };
  for (const [name, keys, configured] of [
    ['existing alias', { Supabase_Key: 'sb_secret_alias_test' }, true],
    ['canonical preferred', { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_canonical_test', Supabase_Key: 'invalid' }, true],
    ['invalid canonical fails closed', { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_wrong', Supabase_Key: 'sb_secret_alias_test' }, false],
    ['empty canonical fails closed', { SUPABASE_SERVICE_ROLE_KEY: '', Supabase_Key: 'sb_secret_alias_test' }, false],
    ['public alias rejected', { Supabase_Key: 'sb_publishable_wrong' }, false],
    ['user JWT alias rejected', { Supabase_Key: token }, false],
    ['wrong case ignored', { SUPABASE_KEY: 'sb_secret_alias_test' }, false],
  ]) {
    await t.test(name, async t => {
      const base = await serve(t, hostedAppFromEnvironment({ ...environment, ...keys }));
      assert.deepEqual(await (await fetch(base + '/api/health')).json(), { mode: 'hosted', configured });
      const publicConfig = await (await fetch(base + '/api/storage/config')).json();
      assert.deepEqual(publicConfig, {
        storage: 'supabase', url: environment.SUPABASE_URL,
        publishableKey: environment.SUPABASE_PUBLISHABLE_KEY, mode: 'hosted', signInEnabled: false,
      });
      assert.doesNotMatch(JSON.stringify(publicConfig), /sb_secret_|sk-proj-|Supabase_Key|SUPABASE_SERVICE_ROLE_KEY/);
    });
  }
});
