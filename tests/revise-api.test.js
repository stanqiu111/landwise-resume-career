import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLandwiseApp } from '../server.js';
import { rateLimitError } from '../server/ai-rate-limit.js';
import { studentResume, overflowingResume } from './fixtures/resumes.js';

const origin = 'http://127.0.0.1:5174';
const jobDescription = 'Northstar is hiring a frontend engineer to build React dashboards and test interfaces. Kubernetes experience is preferred.';
const claim = { id: 'c1', text: 'Built React dashboards for operations.', raw_phrase: 'Built React dashboards for operations.', type: 'responsibility' };
const requirements = [
  { id: 'r1', text: 'React', type: 'skill', priority: 'must_have', keywords: ['React'] },
  { id: 'r2', text: 'Kubernetes', type: 'skill', priority: 'nice_to_have', keywords: ['Kubernetes'] },
];
const matches = [{ requirement_id: 'r1', claim_ids: ['c1'], match_type: 'exact', explanation: 'The original resume lists React dashboards.' }];
function fixture(overrides = {}) {
  return { resume: studentResume, jobDescription, instruction: 'Make the React dashboard bullet more direct.', maxPages: 1,
    result: { transformedResume: studentResume, resumeClaims: [claim], jdRequirements: requirements, claimMatches: matches,
      job: { company: 'Northstar', roleTitle: 'Frontend engineer' }, improvements: [], pageLimit: 1, ...overrides } };
}
const edit = (lineId, replacement, sourceQuote) => ({ lineId, replacement, sourceQuote });
const response = edits => ({ edits, reply: edits.length ? 'Made the requested wording change and kept the original facts.' : 'I kept the draft unchanged. Update the original resume with verified experience and transform again before adding new facts.',
  improvements: edits.map(() => 'Clarified an existing bullet.'), requirementFeedback: [{ requirement_id: 'r1', resumeQuote: 'Developed React dashboards for operations.', nextStep: 'Prepare a short dashboard walkthrough.' }] });
const dashboardEdit = edit('line-9', 'Developed React dashboards for operations.', '- Built React dashboards for operations.');

async function harness(t, inference, options = {}) {
  const app = createLandwiseApp({ auth: { router: express.Router(), getStatus: () => ({ account: { id: 'test-account' } }) }, inference, appOrigin: origin, log: () => {}, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (body, path = '/api/revise', requestOrigin = origin) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  post.stream = (body, signal) => fetch(`http://127.0.0.1:${server.address().port}/api/revise`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal,
  });
  return post;
}

test('one follow-up edits the current draft once, preserves history, refreshes report and saves original inputs', async t => {
  let calls = 0;
  let saved;
  const prior = studentResume.replace('Created a planner', 'Built a planner');
  const body = fixture({ transformedResume: prior, savedApplication: { id: 'old-folder', versionId: 'old-version', folder: null },
    revisionHistory: [{ instruction: 'Shorten the planner bullet.', reply: 'Shortened it.', createdAt: '2026-10-16T12:00:00.000Z', changed: true }] });
  const post = await harness(t, { getClient: async (req, model) => {
    assert.equal(model, 'selected-model');
    assert.ok(req.aiSignal instanceof AbortSignal);
    return { messages: { create: async args => {
      calls++;
      assert.match(args.system, /only source of candidate facts/);
      assert.ok(args.messages[0].content.includes(`<current_draft>${prior}</current_draft>`));
      return { content: [{ text: JSON.stringify(response([dashboardEdit])) }] };
    } } };
  } }, { applications: { save: async data => { saved = structuredClone(data); return { id: 'saved-folder', versionId: 'new-version' }; } } });
  const result = await post({ ...body, model: 'selected-model' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(calls, 1);
  assert.equal(result.body.transformedResume, prior.replace('Built React dashboards', 'Developed React dashboards'));
  assert.equal(result.body.revision.changed, true);
  assert.equal(result.body.revisionHistory.length, 2);
  assert.equal(result.body.editCount, 2);
  assert.equal(result.body.matchScore, 67);
  assert.deepEqual(result.body.report.items.map(item => item.status), ['included', 'learn']);
  assert.equal(result.body.report.items[0].resumeQuote, 'Developed React dashboards for operations.');
  assert.equal(result.body.pageCount, 1);
  assert.deepEqual(result.body.job, body.result.job);
  assert.equal(result.body.savedApplication.versionId, 'new-version');
  assert.equal(saved.resume, studentResume);
  assert.equal(saved.jobDescription, jobDescription);
  assert.equal(saved.result.savedApplication, undefined);
  assert.equal(saved.result.saveError, undefined);
});

test('ordinary paraphrases are accepted and source CRLF or outer blank lines do not break revision', async t => {
  const original = `\r\n${studentResume.replace('Built React dashboards', 'Worked on building React dashboards').replaceAll('\n', '\r\n')}\r\n\r\n`;
  const body = fixture({ transformedResume: original.replaceAll('\r\n', '\n').trim(), resumeClaims: [{ ...claim, raw_phrase: 'Worked on building React dashboards for operations.' }] });
  body.resume = original;
  const answer = response([edit('line-9', 'Helped build React dashboards for operations.', '- Worked on building React dashboards for operations.')]);
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(answer) }] }) } }) });
  const result = await post(body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.transformedResume, /Helped build React/);
});

test('bad instructions, missing evidence and tampered non-bullet history stop before inference', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async () => { calls++; } });
  for (const body of [
    { ...fixture(), instruction: '' }, { ...fixture(), instruction: 'x'.repeat(2001) }, { ...fixture(), instruction: { text: 'edit' } },
    { ...fixture(), maxPages: 0 }, { ...fixture(), maxPages: '1' },
    fixture({ transformedResume: studentResume.replace('Northstar', 'Different Company') }),
    fixture({ transformedResume: studentResume.replace('Expected 2027', 'Expected 2026') }),
    fixture({ transformedResume: studentResume + '\n- Invented a new experience.' }),
    fixture({ resumeClaims: [{ ...claim, raw_phrase: 'Invented leadership experience.' }] }),
  ]) assert.equal((await post(body)).status, 400);
  assert.equal(calls, 0);
});

test('successive small requests may touch different bullets while preserving the original structure', async t => {
  const original = 'Alex Rivera\nalex@example.com\nEXPERIENCE\nEngineer | Northstar\n- Built React dashboards.\n- Built a directory.\n- Built a planner.\n- Built a search form.\nEDUCATION\nBachelor of Science | Western University';
  const prior = original.replace('- Built a directory.', '- Created a directory.').replace('- Built a planner.', '- Created a planner.');
  const body = fixture({ transformedResume: prior, resumeClaims: [{ ...claim, raw_phrase: 'Built React dashboards.' }] });
  body.resume = original;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([edit('line-4', 'Developed React dashboards.', '- Built React dashboards.')])) }] }) } }) });
  const result = await post(body);
  assert.equal(result.status, 200);
  assert.equal(result.body.editCount, 3);
});

test('unsupported tools, invented metrics, mismatched evidence and broad rewrites are rejected after one call', async t => {
  let calls = 0;
  let answer;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => { calls++; return { content: [{ text: JSON.stringify(answer) }] }; } } }) });
  for (const badEdit of [
    { ...dashboardEdit, replacement: 'Built React dashboards and Kubernetes deployments for operations.' },
    { ...dashboardEdit, replacement: 'Built React dashboards with Docker for operations.' },
    { ...dashboardEdit, replacement: 'AWS integrations for React dashboards for operations.' },
    { ...dashboardEdit, replacement: 'Built 10 React dashboards for operations.' },
    { ...dashboardEdit, replacement: 'Built two React dashboards for operations.' },
    { ...dashboardEdit, sourceQuote: '- Created a planner that groups coursework by deadline and displays progress for each class.' },
    { ...dashboardEdit, lineId: 'line-8', replacement: 'Senior Engineer | New company' },
  ]) {
    answer = response([badEdit]);
    const result = await post(fixture());
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'invalid_resume_revision');
    assert.match(result.body.error, /previous draft is unchanged/);
  }
  answer = { transformedResume: 'An entirely new resume.', reply: 'Rewrote it.' };
  assert.equal((await post(fixture())).body.code, 'invalid_resume_revision');
  assert.equal(calls, 8);
});

test('metrics cannot be borrowed from another bullet even when both values exist in the original', async t => {
  const original = studentResume.replace('Built React dashboards for operations.', 'Built 3 React dashboards for operations.').replace('Connected dashboard components', 'Connected 5 dashboard components');
  const body = fixture({ transformedResume: original, resumeClaims: [{ ...claim, raw_phrase: 'Built 3 React dashboards for operations.' }] });
  body.resume = original;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([
    edit('line-9', 'Built 5 React dashboards for operations.', '- Built 3 React dashboards for operations.'),
  ])) }] }) } }) });
  assert.equal((await post(body)).body.code, 'invalid_resume_revision');
});

test('a no-op explains the factual boundary and retains the saved version, report and retryable save notice', async t => {
  let saves = 0;
  const body = fixture({ savedApplication: { id: 'folder', versionId: 'existing-version' }, saveError: 'Prior draft still needs saving.',
    report: { items: [{ id: 'r1', resumeQuote: 'Built React dashboards for operations.', nextStep: 'Keep the original interview task.' }] } });
  body.instruction = 'Add Kubernetes experience even though it is not in my source.';
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([])) }] }) } }) }, { applications: { save: async () => { saves++; } } });
  const result = await post(body);
  assert.equal(result.status, 200);
  assert.equal(result.body.transformedResume, studentResume);
  assert.equal(result.body.revision.changed, false);
  assert.match(result.body.revision.reply, /Update the original resume/);
  assert.equal(result.body.savedApplication.versionId, 'existing-version');
  assert.equal(result.body.saveError, body.result.saveError);
  assert.equal(result.body.report.items[0].nextStep, 'Keep the original interview task.');
  assert.equal(result.body.matchScore, 67);
  assert.equal(saves, 0);
});

test('ungrounded submitted claims are discarded and cannot increase the report score', async t => {
  const body = fixture({ resumeClaims: [claim, { id: 'fake', text: 'Uses Kubernetes.', raw_phrase: 'Uses Kubernetes.', type: 'skill' }],
    claimMatches: [...matches, { requirement_id: 'r2', claim_ids: ['fake'], match_type: 'exact' }] });
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([dashboardEdit])) }] }) } }) });
  const result = await post(body);
  assert.equal(result.status, 200);
  assert.equal(result.body.matchScore, 67);
  assert.equal(result.body.report.items[1].status, 'learn');
  assert.equal(result.body.resumeClaims.length, 1);
});

test('revision exchange history is bounded without storing old savedApplication metadata inside snapshots', async t => {
  const history = Array.from({ length: 10 }, (_, i) => ({ instruction: `Edit ${i}`, reply: 'Done.', createdAt: '2026-10-16T12:00:00.000Z' }));
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([dashboardEdit])) }] }) } }) });
  const result = await post(fixture({ revisionHistory: history }));
  assert.equal(result.body.revisionHistory.length, 10);
  assert.equal(result.body.revisionHistory[0].instruction, 'Edit 1');
  assert.equal(result.body.revisionHistory.at(-1).instruction, fixture().instruction);
});

test('overflow ends after one request and never truncates or calls a shortening model', async t => {
  let calls = 0;
  const body = fixture({ transformedResume: overflowingResume });
  body.resume = overflowingResume;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => { calls++; return { content: [{ text: JSON.stringify(response([])) }] }; } } }) });
  const result = await post(body);
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'resume_too_long');
  assert.equal(calls, 1);
});

test('saving a revised draft may fail without losing it or exposing private filesystem errors', async t => {
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => ({ content: [{ text: JSON.stringify(response([dashboardEdit])) }] }) } }) },
    { applications: { save: async () => { throw new Error('private path or secret'); } } });
  const result = await post(fixture({ savedApplication: { id: 'old-folder', versionId: 'old-version' }, saveError: 'An old error' }));
  assert.equal(result.status, 200);
  assert.match(result.body.transformedResume, /Developed React dashboards/);
  assert.equal(result.body.savedApplication, undefined);
  assert.match(result.body.saveError, /revised draft is ready/);
  assert.doesNotMatch(JSON.stringify(result.body), /private path|An old error/);
});

test('revision uses the same authenticated session and origin checks as transform', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async () => { calls++; } }, { auth: { router: express.Router(), requireSession: () => { throw Object.assign(new Error('Sign in first.'), { status: 401, code: 'chatgpt_signin_required' }); } } });
  assert.equal((await post(fixture(), '/api/revise', 'https://untrusted.example')).status, 403);
  assert.equal((await post(fixture())).status, 401);
  assert.equal(calls, 0);
});

test('provider rate limiting is streamed once and cooldown blocks transform and follow-up retries', async t => {
  let calls = 0;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => { calls++; throw rateLimitError(60); } } }) });
  const first = await post.stream(fixture());
  const events = (await first.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).code, 'chatgpt_rate_limited');
  assert.equal(events.at(-1).retryAfterSeconds, 60);
  assert.equal((await post(fixture())).status, 429);
  assert.equal((await post({ resume: studentResume, jobDescription }, '/api/transform')).status, 429);
  assert.equal(calls, 1);
});

test('revision and Analyze cannot overlap on the same account and the lock releases afterward', async t => {
  let release;
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  let calls = 0;
  const post = await harness(t, { getClient: async () => ({ messages: { create: async () => {
    calls++;
    if (calls === 1) { ready(); await new Promise(resolve => { release = resolve; }); }
    return { content: [{ text: JSON.stringify(response([])) }] };
  } } }) });
  const pending = post(fixture());
  await entered;
  const overlapping = await post({ resume: studentResume }, '/api/analyze-resume');
  assert.equal(overlapping.status, 409);
  release();
  assert.equal((await pending).status, 200);
  assert.equal((await post(fixture())).status, 200);
  assert.equal(calls, 2);
});

test('a revision deadline aborts the single provider call and returns an error instead of a partial result', async t => {
  let signal;
  let calls = 0;
  const post = await harness(t, { getClient: async req => {
    signal = req.aiSignal;
    return { messages: { create: async () => { calls++; return new Promise(() => {}); } } };
  } }, { transformTimeoutMs: 25 });
  const result = await post.stream(fixture());
  const events = (await result.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).code, 'revision_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.ok(!events.some(event => event.type === 'result'));
});

test('browser cancellation aborts revision work and does not save a version', async t => {
  let signal;
  let cancelled;
  let saves = 0;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const post = await harness(t, { getClient: async req => {
    signal = req.aiSignal;
    signal.addEventListener('abort', cancelled, { once: true });
    return new Promise(() => {});
  } }, { applications: { save: async () => { saves++; } } });
  const controller = new AbortController();
  const result = await post.stream(fixture(), controller.signal);
  await result.body.getReader().read();
  controller.abort();
  await aborted;
  assert.equal(signal.aborted, true);
  assert.equal(saves, 0);
});
