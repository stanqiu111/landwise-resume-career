import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { GUEST_TAILORINGS, LOCAL_SETUP_URL, canRecoverHostedRequest, createHostedRequestIds, guestDraftForAccount, hostedActionAccess, hostedFailureMessage, keepHostedRequestId, validateHostedInputs } from '../src/hostedAccess.js';
import { canStartLandwiseSignIn, cloudAuthorizationHeaders, validateStorageConfig } from '../src/cloudAccount.js';
import { GUEST_TAILORINGS as SERVER_GUEST_TAILORINGS } from '../server/hosted-budget.js';

const guestSession = { available: true, guestEligible: true, authenticated: false, remaining: 15, limit: 15 };

test('guests see how many of their 15 free tailorings are left, then where to run Landwise locally', () => {
  assert.equal(GUEST_TAILORINGS, 15);
  assert.equal(GUEST_TAILORINGS, SERVER_GUEST_TAILORINGS, 'browser copy and server limit agree');
  assert.match(LOCAL_SETUP_URL, /^https:\/\/github\.com\/stanqiu111\/landwise-resume-career\/blob\/main\/docs\/LOCAL_DEVELOPMENT\.md#run-landwise-on-your-computer$/);
  assert.equal(hostedActionAccess(guestSession, false, 'transform', false).message, 'You have 15 free tailorings. No signup required.');
  assert.equal(hostedActionAccess({ ...guestSession, remaining: 4 }, false, 'transform', false).message, '4 of 15 free tailorings left. No signup required.');
  assert.equal(hostedActionAccess({ ...guestSession, remaining: 1 }, false, 'transform', false).allowed, true);
  const usedUp = hostedActionAccess({ ...guestSession, available: false, guestEligible: false, remaining: 0, reason: 'guest_trial_used' }, false, 'transform', false);
  assert.equal(usedUp.allowed, false);
  assert.equal(usedUp.local, true);
  assert.equal(usedUp.exhausted, true);
  assert.equal(usedUp.signIn, false);
  for (const reason of ['daily_limit', 'monthly_limit', 'monthly_budget']) {
    assert.equal(hostedActionAccess({ ...guestSession, available: false, reason }, false, 'transform', false).local, true, `${reason} offers the local version`);
  }
  assert.notEqual(hostedActionAccess({ ...guestSession, available: false, reason: 'ai_busy' }, false, 'transform', false).local, true);
  assert.match(usedUp.message, /used your 15 free tailorings\. To keep going, run Landwise on your own computer with your ChatGPT account/);
  const withAccounts = hostedActionAccess({ ...guestSession, available: false, guestEligible: false, remaining: 0, reason: 'guest_trial_used' }, false, 'transform', true);
  assert.equal(withAccounts.signIn, true);
  assert.match(withAccounts.message, /Create a free Landwise account, or run Landwise on your own computer/);
  const feedback = hostedActionAccess(guestSession, false, 'analyze', false);
  assert.equal(feedback.local, true);
  assert.match(feedback.message, /Resume feedback and follow-up changes are available when you run Landwise on your own computer/);
  assert.match(hostedFailureMessage({ code: 'hosted_ai_allowance_used' }, false, false), /used your 15 free tailorings/);
  assert.match(hostedFailureMessage({ code: 'hosted_ai_allowance_used' }, true, false), /monthly AI allowance/);
  assert.match(hostedFailureMessage({ code: 'cloud_sign_in_required' }, false, false), /run Landwise on your own computer/);
});

test('the live site’s local-setup link lands on an existing heading', async () => {
  const guide = await readFile(new URL('../docs/LOCAL_DEVELOPMENT.md', import.meta.url), 'utf8');
  const slug = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
  const anchors = guide.split('\n').filter(line => /^#{1,6} /.test(line)).map(line => slug(line.replace(/^#+ /, '')));
  assert.ok(anchors.includes(LOCAL_SETUP_URL.split('#')[1]));
});

test('guests may tailor but cannot analyze or revise without a free account', () => {
  assert.equal(hostedActionAccess(guestSession, false, 'transform').allowed, true);
  assert.equal(hostedActionAccess(guestSession, false, 'analyze').signIn, true);
  assert.equal(hostedActionAccess(guestSession, false, 'revise').allowed, false);
  assert.equal(hostedActionAccess({ ...guestSession, guestEligible: false }, false).signIn, true);
  assert.equal(hostedActionAccess({ ...guestSession, available: false, guestEligible: false, reason: 'guest_trial_used' }, false).signIn, true);
});

test('hosted availability and verified account allowance gate every AI action', () => {
  assert.equal(hostedActionAccess(null, false).allowed, false);
  assert.equal(hostedActionAccess({ ...guestSession, available: false }, false).allowed, false);
  assert.equal(hostedActionAccess(guestSession, true).allowed, false);
  assert.match(hostedActionAccess({ ...guestSession, available: false, reason: 'monthly_allowance' }, true).message, /monthly AI allowance/);
  for (const action of ['transform', 'analyze', 'revise']) {
    assert.equal(hostedActionAccess({ ...guestSession, authenticated: true, remaining: 3 }, true, action).allowed, true);
    assert.equal(hostedActionAccess({ ...guestSession, authenticated: true, remaining: 0 }, true, action).allowed, false);
  }
});

test('hosted signup stays disabled until explicitly enabled, without disabling existing users', () => {
  const config = { storage: 'supabase', url: 'https://project.supabase.co', publishableKey: 'public', mode: 'hosted', signInEnabled: false };
  assert.equal(validateStorageConfig(config).signInEnabled, false);
  assert.equal(canStartLandwiseSignIn(config, true), false);
  assert.equal(canStartLandwiseSignIn({ ...config, signInEnabled: undefined }, true), false);
  assert.equal(canStartLandwiseSignIn({ ...config, signInEnabled: true }, true), true);
  assert.equal(canStartLandwiseSignIn({ ...config, signInEnabled: undefined }, false), true);
  assert.equal(hostedActionAccess(guestSession, false, 'transform', false).allowed, true);
  assert.match(hostedActionAccess({ ...guestSession, guestEligible: false }, false, 'transform', false).message, /used your 15 free tailorings/);
  assert.equal(hostedActionAccess({ ...guestSession, authenticated: true, remaining: 2 }, true, 'revise', false).allowed, true);
  assert.doesNotMatch(hostedFailureMessage({ code: 'hosted_ai_allowance_used' }, false, false), /3|Create a free/);
});

test('hosted request IDs survive an unchanged retry but never carry into changed or completed work', () => {
  let id = 0;
  const ids = createHostedRequestIds(() => `request-${++id}`);
  const first = ids.for('transform', { resume: 'source', jobDescription: 'role' });
  assert.equal(ids.for('transform', { resume: 'source', jobDescription: 'role' }), first);
  assert.notEqual(ids.for('transform', { resume: 'updated source', jobDescription: 'role' }), first);
  const revision = ids.for('revise', { instruction: 'shorten' });
  assert.equal(ids.for('revise', { instruction: 'shorten' }), revision);
  ids.complete('revise');
  assert.notEqual(ids.for('revise', { instruction: 'shorten' }), revision);
});

test('hosted inputs enforce character and UTF-8 totals without truncating user experience', () => {
  assert.equal(validateHostedInputs('a'.repeat(30000), 'b'.repeat(20000)), '');
  assert.match(validateHostedInputs('a'.repeat(30001)), /resume is too long/);
  assert.match(validateHostedInputs('resume', 'b'.repeat(20001)), /job description is too long/);
  assert.match(validateHostedInputs('漢'.repeat(20001)), /too large/);
  assert.match(validateHostedInputs('resume', 'job', { resume: 'resume', result: { evidence: 'a'.repeat(60000) } }), /too large/);
});

test('guest draft handoff is bound to the requested email and expires', () => {
  const handoff = { email: 'student@example.com', expiresAt: 200, draft: { resume: 'private guest draft' } };
  assert.equal(guestDraftForAccount(handoff, null, 100), null);
  assert.equal(guestDraftForAccount(handoff, { id: 'different-user', email: 'other@example.com' }, 100), null);
  assert.deepEqual(guestDraftForAccount(handoff, { id: 'target-user', email: 'STUDENT@example.com' }, 100), handoff.draft);
  assert.equal(guestDraftForAccount(handoff, { id: 'target-user', email: 'student@example.com' }, 201), null);
});

test('guest AI headers stay empty, application auth remains strict, and stale guest views cannot adopt another account token', async () => {
  let session = null;
  const client = { auth: { getSession: async () => ({ data: { session }, error: null }) } };
  assert.deepEqual(await cloudAuthorizationHeaders(client, null, { allowGuest: true }), {});
  await assert.rejects(cloudAuthorizationHeaders(client, null), /Sign in/);
  session = { access_token: 'private-token', user: { id: 'new-user' } };
  await assert.rejects(cloudAuthorizationHeaders(client, null, { allowGuest: true }), /account changed/);
  assert.deepEqual(await cloudAuthorizationHeaders(client, 'new-user', { allowGuest: true }), { Authorization: 'Bearer private-token' });
});

test('hosted limit errors explain the user action without provider billing or plan upsells', () => {
  assert.match(hostedFailureMessage({ code: 'guest_limit' }), /free Landwise account/);
  assert.match(hostedFailureMessage({ code: 'monthly_allowance' }), /monthly AI allowance/);
  assert.match(hostedFailureMessage({ code: 'shared_budget' }), /temporarily at capacity/);
  assert.doesNotMatch(hostedFailureMessage({ code: 'shared_budget', message: 'private provider billing details' }), /billing|subscription|ChatGPT/);
  assert.match(hostedFailureMessage({ code: 'hosted_ai_allowance_used' }, true), /monthly AI allowance/);
  assert.match(hostedFailureMessage({ code: 'hosted_ai_allowance_used' }, false), /free Landwise account/);
  assert.match(hostedFailureMessage({ code: 'hosted_ai_daily_limit' }), /tomorrow/);
  assert.match(hostedFailureMessage({ code: 'hosted_result_unavailable' }), /cannot be recovered/);
});

test('an existing request can be recovered after allowance use, but only transient failures reuse its ID', () => {
  assert.equal(canRecoverHostedRequest({ available: false, csrfToken: 'csrf', reason: 'guest_trial_used' }), true);
  assert.equal(canRecoverHostedRequest({ available: false, csrfToken: 'csrf', reason: 'ai_busy' }), true);
  assert.equal(canRecoverHostedRequest({ available: false, csrfToken: null, reason: 'configuration' }), false);
  assert.equal(keepHostedRequestId(new Error('network interrupted')), true);
  assert.equal(keepHostedRequestId({ code: 'hosted_ai_busy' }), true);
  assert.equal(keepHostedRequestId({ code: 'hosted_request_failed' }), true);
  assert.equal(keepHostedRequestId({ code: 'transform_failed' }), true);
  assert.equal(keepHostedRequestId({ code: 'hosted_budget_unavailable' }), true);
  assert.equal(keepHostedRequestId({ code: 'hosted_result_unavailable' }), false);
  assert.equal(keepHostedRequestId({ code: 'hosted_ai_timeout' }), false);
});

test('exhausted allowance permits only an exact transient analysis or revision replay for the same workspace', () => {
  let count = 0;
  const requests = createHostedRequestIds(() => `request-${++count}`);
  const exhausted = { csrfToken: 'csrf', available: false, authenticated: true, remaining: 0, reason: 'monthly_allowance' };
  const cases = [
    ['analyze', { resume: 'original resume' }, { resume: 'changed resume' }],
    ['revise', { resume: 'original resume', result: { transformedResume: 'current draft' }, instruction: 'shorten my second bullet' }, { resume: 'original resume', result: { transformedResume: 'current draft' }, instruction: 'rewrite every bullet' }],
  ];
  for (const [action, payload, changed] of cases) {
    assert.equal(hostedActionAccess(exhausted, true, action).allowed, false);
    assert.equal(requests.canRetry(action, payload, exhausted), false, 'a fresh request cannot bypass the allowance');
    const requestId = requests.for(action, payload);
    assert.equal(requests.canRetry(action, payload, exhausted), false, 'an active request cannot be submitted twice');
    requests.failed(action, { code: 'hosted_budget_unavailable' });
    assert.equal(requests.canRetry(action, payload, exhausted), true);
    assert.equal(requests.canRetry(action, changed, exhausted), false, 'changed inputs cannot inherit recovery permission');
    assert.equal(requests.for(action, payload), requestId, 'recovery keeps the original server receipt ID');
    assert.equal(requests.canRetry(action, payload, exhausted), false, 'submitting a replay consumes its retry state until another failure');
    requests.failed(action, { code: 'hosted_request_failed' });
    assert.equal(createHostedRequestIds().canRetry(action, payload, exhausted), false, 'a new account workspace has no recovery permission');
    assert.equal(requests.canRetry(action, payload, { ...exhausted, csrfToken: null }), false);
    requests.failed(action, { code: 'hosted_result_unavailable' });
    assert.equal(requests.canRetry(action, payload, exhausted), false, 'confirmed terminal state clears recovery permission');
    assert.notEqual(requests.for(action, payload), requestId, 'a later admitted action gets a new receipt after confirmed terminal failure');
  }
});

test('cancelled requests can be checked again, while completed or replaced payloads lose recovery permission', () => {
  let count = 0;
  const requests = createHostedRequestIds(() => `request-${++count}`);
  const session = { csrfToken: 'csrf', available: false, reason: 'ai_busy' };
  const payload = { resume: 'source', instruction: 'shorten' };
  requests.for('revise', payload);
  requests.failed('revise', { code: 'unexpected' }, { aborted: true });
  assert.equal(requests.canRetry('revise', payload, session), true);
  requests.for('revise', { ...payload, instruction: 'keep the purpose clear' });
  assert.equal(requests.canRetry('revise', payload, session), false);
  requests.failed('revise', new Error('connection interrupted'));
  requests.complete('revise');
  assert.equal(requests.canRetry('revise', { ...payload, instruction: 'keep the purpose clear' }, session), false);
});
