import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Execute the real migration in PostgreSQL WASM. The only scaffold is Supabase's
// role/auth.uid surface; permission, RLS, JSONB, constraints and PL/pgSQL behavior
// below run in the database engine, not mocked JS. PGlite serializes its single
// connection; Promise.all verifies overlapping RPC outcomes, not multi-session
// PostgreSQL scheduling. The migration also uses database row/advisory locks.
const db = new PGlite();
const users = Array.from({ length: 40 }, () => randomUUID());
const sql = (query, values = []) => db.query(query, values);
async function as(role, user = '') {
  assert.ok(['postgres', 'authenticated', 'anon', 'service_role'].includes(role));
  await db.exec(`reset role; set role ${role};`);
  await sql("select set_config('request.jwt.claim.sub', $1, false)", [user]);
}
async function rpc(name, values = []) {
  assert.match(name, /^landwise_[a-z_]+$/);
  const args = values.map((_, i) => `$${i + 1}`).join(',');
  return (await sql(`select public.${name}(${args}) as result`, values)).rows[0].result;
}
function inputs(label, overrides = {}) {
  return {
    resume: 'Alex Rivera\nEXPERIENCE\n- Built React dashboards.\nEDUCATION\nComputer Science',
    jobDescription: `Frontend Developer at ${label}. Build React dashboards and learn deployment skills.`,
    maxPages: 1,
    result: {
      transformedResume: 'Alex Rivera\nEXPERIENCE\n- Developed React dashboards.\nEDUCATION\nComputer Science',
      matchScore: 67, job: { company: label, roleTitle: 'Frontend Developer' },
      report: { score: 67, items: [{ id: 'r1', requirement: 'React', status: 'included', nextStep: 'Explain components.' },
        { id: 'r2', requirement: 'Deployment', status: 'learn', nextStep: 'Build a deployment demo.' }] },
      revisionHistory: [{ instruction: 'Shorten the first bullet.', reply: 'Shortened it.', createdAt: '2026-10-16T12:00:00.000Z', changed: true }],
    },
    ...overrides,
  };
}
const save = data => rpc('landwise_application_save', [JSON.stringify(data)]);
const get = id => rpc('landwise_application_get', [id]);
const update = (id, patch) => rpc('landwise_application_update', [id, JSON.stringify(patch)]);
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);

before(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    -- Match Supabase's broad defaults so the migration must explicitly revoke
    -- them for private helpers and sponsored-trial functions.
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const id of users) await sql('insert into auth.users(id) values ($1)', [id]);
  await db.exec(await readFile(new URL('../supabase/migrations/202610160001_landwise_foundation.sql', import.meta.url), 'utf8'));
  // Seed legacy rows before migration002, proving the migration keeps already
  // over-limit accounts intact and initializes counters from real stored data.
  await sql(`insert into public.landwise_applications(user_id,job_key,role_title,notes,history)
    select $1, encode(sha256(convert_to('legacy-' || i, 'UTF8')), 'hex'), 'Legacy role', 'Older notes',
      (select jsonb_agg(jsonb_build_object('at','2026-10-16T00:00:00Z','text','Legacy event')) from generate_series(1,101))
    from generate_series(1,51) i`, [users[39]]);
  await sql(`insert into public.landwise_application_versions(application_id,user_id,version_number,resume,job_description,max_pages,result)
    select a.id,a.user_id,i,'Original resume','Original JD',1,
      jsonb_build_object('transformedResume','Saved resume','padding',case when i=1 then repeat('x',6291456) else '' end)
    from (select * from public.landwise_applications where user_id=$1 order by job_key limit 1) a cross join generate_series(1,11) i`, [users[39]]);
  await db.exec(await readFile(new URL('../supabase/migrations/202610170001_landwise_storage_limits.sql', import.meta.url), 'utf8'));
});
after(async () => { await db.close(); });

test('SQL saves the original inputs, full result and app shape, and deduplicates equivalent latest versions', async () => {
  await as('authenticated', users[0]);
  const input = inputs('Northstar');
  const saved = await save(input);
  assert.equal(saved.versionCount, 1);
  assert.equal(saved.company, 'Northstar');
  assert.equal(saved.practiceTotal, 1);
  assert.equal(saved.practiceDone, 0);
  assert.equal(saved.score, 67);
  const app = await get(saved.id);
  assert.equal(app.jobKey, createHash('sha256').update(input.jobDescription).digest('hex'));
  assert.equal(app.versions[0].resume, input.resume);
  assert.equal(app.versions[0].jobDescription, input.jobDescription);
  assert.deepEqual(app.versions[0].result, input.result);
  assert.equal(app.versions[0].maxPages, 1);
  assert.equal(app.history[0].text, 'First resume prepared');
  assert.equal(app.practice[0].title, 'Deployment: Build a deployment demo.');
  const repeated = await save({ ...input, result: { ...input.result, extraNonDraftMetadata: 'an idempotent retry' } });
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.versionId, saved.versionId);
  assert.equal(repeated.versionCount, 1);
  const updatedDraft = await save({ ...input, result: { ...input.result, transformedResume: input.result.transformedResume.replace('Developed', 'Created') } });
  assert.equal(updatedDraft.versionCount, 2);
  assert.notEqual(updatedDraft.versionId, saved.versionId);
  assert.equal((await get(saved.id)).versions[0].result.transformedResume, input.result.transformedResume);
  const listed = await rpc('landwise_application_list');
  assert.equal(listed.applications.length, 1);
  assert.equal(listed.applications[0].versionCount, 2);
});

test('owner RLS and all application RPCs isolate accounts sharing the same JD', async () => {
  await as('authenticated', users[1]);
  const mine = await save(inputs('Shared JD'));
  await as('authenticated', users[2]);
  assert.deepEqual(await rpc('landwise_application_list'), { applications: [] });
  assert.equal((await sql('select id from public.landwise_applications where id = $1', [mine.id])).rows.length, 0);
  assert.equal((await sql('select id from public.landwise_application_versions where application_id = $1', [mine.id])).rows.length, 0);
  await rejectCode(get(mine.id), 'P0002');
  await rejectCode(update(mine.id, { notes: 'Cannot edit someone else' }), 'P0002');
  await rejectCode(rpc('landwise_application_remove', [mine.id]), 'P0002');
  const theirs = await save(inputs('Shared JD'));
  assert.notEqual(theirs.id, mine.id);
  assert.equal((await rpc('landwise_application_list')).applications.length, 1);
  await rejectCode(sql('update public.landwise_applications set notes = $1 where id = $2', ['bypass RPC', theirs.id]), '42501');
  await rejectCode(sql('delete from public.landwise_application_versions where application_id = $1', [theirs.id]), '42501');
  await as('authenticated', users[1]);
  assert.equal((await get(mine.id)).notes, '');
});

test('anonymous access, missing auth identity and direct client trial access are denied', async () => {
  await as('anon');
  await rejectCode(rpc('landwise_application_list'), '42501');
  await rejectCode(sql('select * from public.landwise_applications'), '42501');
  await as('authenticated');
  await rejectCode(rpc('landwise_application_list'), '42501');
  await as('authenticated', users[0]);
  await rejectCode(rpc('landwise_trial_reserve', [users[0], randomUUID()]), '42501');
  await rejectCode(rpc('landwise_trial_complete', [users[0], randomUUID(), randomUUID(), randomUUID()]), '42501');
  await rejectCode(rpc('landwise_trial_release', [users[0], randomUUID()]), '42501');
  await rejectCode(sql('select * from landwise_private.landwise_trial_ledger'), '42501');
  await as('service_role');
  await rejectCode(sql('select * from landwise_private.landwise_trial_ledger'), '42501');
});

test('overlapping saves are idempotent and updates preserve versions, notes, progress and practice history', async () => {
  await as('authenticated', users[3]);
  const input = inputs('Concurrent');
  const saves = await Promise.all(Array.from({ length: 6 }, () => save(input)));
  assert.equal(new Set(saves.map(item => item.id)).size, 1);
  assert.equal(new Set(saves.map(item => item.versionId)).size, 1);
  const id = saves[0].id;
  let app = await get(id);
  const tasks = app.practice.map(item => ({ ...item, done: true }));
  await Promise.all([
    update(id, { notes: 'Keep my interview notes.', stage: 'interview', practice: tasks }),
    save({ ...input, result: { ...input.result, transformedResume: input.result.transformedResume + '\nSKILLS\nReact' } }),
    save({ ...input, maxPages: 2 }),
  ]);
  app = await get(id);
  assert.equal(app.versions.length, 3);
  assert.equal(app.notes, 'Keep my interview notes.');
  assert.equal(app.stage, 'interview');
  assert.equal(app.practice[0].done, true);
  assert.deepEqual(app.history.map(item => item.text), ['First resume prepared', 'Progress changed to interview', '1 practice tasks completed']);
  const renamed = await update(id, { company: '  Better name  ', roleTitle: '  Frontend Internship  ' });
  assert.equal(renamed.company, 'Better name');
  assert.equal(renamed.roleTitle, 'Frontend Internship');
  assert.equal(renamed.versions.length, 3);
});

test('SQL validates bounded inputs, page limits, patches and practice task shapes before writing', async () => {
  await as('authenticated', users[4]);
  for (const input of [null, {}, inputs('Bad', { resume: ' \n\t ' }), inputs('Bad', { jobDescription: 44 }),
    inputs('Bad', { maxPages: 0 }), inputs('Bad', { maxPages: 21 }), inputs('Bad', { maxPages: 1.5 }),
    inputs('Bad', { maxPages: '1' }), inputs('Bad', { user_id: users[1] }), inputs('Bad', { result: { transformedResume: '' } }), inputs('Bad', { resume: 'x'.repeat(221000) })]) {
    await rejectCode(save(input), '22023');
  }
  assert.deepEqual(await rpc('landwise_application_list'), { applications: [] });
  const saved = await save(inputs('Validated'));
  for (const patch of [null, { user_id: users[1] }, { stage: 'made-up' }, { roleTitle: ' ' }, { company: null }, { notes: 'x'.repeat(12001) },
    { practice: null }, { practice: [{ id: 'a', title: 'Read docs', done: false, unexpected: 'extra content' }] }, { practice: [{ id: 'a', title: 'Read docs', done: 'yes' }] }, { practice: Array.from({ length: 101 }, () => ({ id: 'x', title: 'test', done: false })) }]) {
    await rejectCode(update(saved.id, patch), '22023');
  }
  assert.equal((await get(saved.id)).stage, 'resume');
});

test('removing an owned application deletes its versions without affecting another account', async () => {
  await as('authenticated', users[4]);
  const saved = await save(inputs('Remove only mine'));
  assert.deepEqual(await rpc('landwise_application_remove', [saved.id]), { removed: true });
  await rejectCode(get(saved.id), 'P0002');
  assert.equal((await sql('select id from public.landwise_application_versions where application_id = $1', [saved.id])).rows.length, 0);
  await as('authenticated', users[1]);
  assert.equal((await rpc('landwise_application_list')).applications.length, 1);
});

test('trial reservation is service-only, one-at-a-time and idempotent for the same request', async () => {
  await as('service_role');
  const request = randomUUID();
  const reserved = await Promise.all(Array.from({ length: 5 }, () => rpc('landwise_trial_reserve', [users[5], request])));
  assert.ok(reserved.every(item => item.status === 'reserved' && item.requestId === request));
  assert.ok(reserved.every(item => item.reservedAt === reserved[0].reservedAt));
  await assert.rejects(rpc('landwise_trial_reserve', [users[5], randomUUID()]), /trial_request_in_progress/);
  await assert.rejects(rpc('landwise_trial_release', [users[5], randomUUID()]), /trial_reservation_mismatch/);
  assert.equal((await rpc('landwise_trial_reserve', [users[5], request])).status, 'reserved');
  assert.equal((await rpc('landwise_trial_release', [users[5], request])).status, 'available');
  assert.equal((await rpc('landwise_trial_release', [users[5], request])).status, 'available');
  const retry = randomUUID();
  assert.equal((await rpc('landwise_trial_reserve', [users[5], retry])).requestId, retry);
  await rejectCode(rpc('landwise_trial_reserve', [randomUUID(), randomUUID()]), '22023');
});

test('competing trial requests have exactly one winning reservation', async () => {
  await as('service_role');
  const requests = [randomUUID(), randomUUID(), randomUUID()];
  const results = await Promise.allSettled(requests.map(id => rpc('landwise_trial_reserve', [users[6], id])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.message === 'trial_request_in_progress'));
});

test('trial completion requires an owned saved version and remains used after deletion or release', async () => {
  await as('authenticated', users[7]);
  const own = await save(inputs('Trial application'));
  await as('authenticated', users[0]);
  const other = await save(inputs('Other trial application'));
  await as('service_role');
  const request = randomUUID();
  await rpc('landwise_trial_reserve', [users[7], request]);
  await rejectCode(rpc('landwise_trial_complete', [users[7], request, other.id, other.versionId]), '22023');
  await rejectCode(rpc('landwise_trial_complete', [users[7], request, own.id, randomUUID()]), '22023');
  await assert.rejects(rpc('landwise_trial_complete', [users[7], randomUUID(), own.id, own.versionId]), /trial_reservation_mismatch/);
  const completed = await rpc('landwise_trial_complete', [users[7], request, own.id, own.versionId]);
  assert.equal(completed.status, 'used');
  assert.equal(completed.applicationId, own.id);
  assert.equal(completed.versionId, own.versionId);
  assert.deepEqual(await rpc('landwise_trial_complete', [users[7], request, own.id, own.versionId]), completed);
  assert.deepEqual(await rpc('landwise_trial_release', [users[7], request]), completed);
  await assert.rejects(rpc('landwise_trial_reserve', [users[7], randomUUID()]), /trial_already_used/);
  await as('authenticated', users[7]);
  await rpc('landwise_application_remove', [own.id]);
  await as('service_role');
  assert.deepEqual(await rpc('landwise_trial_complete', [users[7], request, own.id, own.versionId]), completed);
  assert.deepEqual(await rpc('landwise_trial_reserve', [users[7], request]), completed);
  await assert.rejects(rpc('landwise_trial_reserve', [users[7], randomUUID()]), /trial_already_used/);
});

test('migration grants only intended RPCs and pins every definer search path', async () => {
  await as('postgres');
  const functions = (await sql(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'landwise_%' and p.prosecdef`)).rows;
  assert.equal(functions.length, 8);
  assert.ok(functions.every(item => item.proconfig.includes('search_path=""')));
  const policies = (await sql("select tablename, qual, with_check from pg_policies where tablename like 'landwise_%'")).rows;
  assert.equal(policies.length, 2);
  assert.ok(policies.every(policy => policy.qual.includes('auth.uid()') && policy.with_check.includes('auth.uid()')));
  const privileges = (await sql(`select
    has_function_privilege('authenticated', 'public.landwise_application_save(jsonb)', 'execute') as app_allowed,
    has_function_privilege('authenticated', 'public.landwise_trial_reserve(uuid,uuid)', 'execute') as trial_denied,
    has_function_privilege('anon', 'public.landwise_trial_reserve(uuid,uuid)', 'execute') as anonymous_denied,
    has_function_privilege('service_role', 'public.landwise_trial_reserve(uuid,uuid)', 'execute') as trial_allowed`)).rows[0];
  assert.deepEqual(privileges, { app_allowed: true, trial_denied: false, anonymous_denied: false, trial_allowed: true });
});

const quotaError = (promise, detail) => assert.rejects(promise, error => error.code === 'P0001' && error.detail === detail);
async function usage(user) {
  await as('postgres');
  const row = (await sql('select application_count, payload_bytes from landwise_private.landwise_storage_user_usage where user_id=$1', [user])).rows[0];
  return { applicationCount: row?.application_count || 0, bytes: Number(row?.payload_bytes || 0) };
}
async function globalBytes() {
  await as('postgres');
  return Number((await sql('select payload_bytes from landwise_private.landwise_storage_global_usage')).rows[0].payload_bytes);
}
async function verifyCounters() {
  await as('postgres');
  const rows = (await sql(`with actual as (
    select user_id,sum(app_count)::integer as application_count,sum(bytes)::bigint as payload_bytes from (
      select a.user_id,1 as app_count,landwise_private.landwise_storage_payload_bytes(to_jsonb(a)) as bytes from public.landwise_applications a
      union all
      select v.user_id,0,landwise_private.landwise_storage_payload_bytes(to_jsonb(v)) from public.landwise_application_versions v
    ) data group by user_id)
    select coalesce(a.user_id,u.user_id) from actual a full join landwise_private.landwise_storage_user_usage u using(user_id)
    where a.application_count is distinct from u.application_count or a.payload_bytes is distinct from u.payload_bytes`)).rows;
  assert.deepEqual(rows, []);
  const totals = (await sql(`select
    (select payload_bytes from landwise_private.landwise_storage_global_usage) as global_bytes,
    coalesce(sum(payload_bytes),0)::bigint as user_bytes from landwise_private.landwise_storage_user_usage`)).rows[0];
  assert.equal(totals.global_bytes, totals.user_bytes);
}
async function fillUserTo(user, versionId, targetBytes) {
  // Privileged fixture setup still passes through the real table triggers. The
  // padding is stored in an actual JSONB result; counters are never falsified.
  await as('postgres');
  await sql("update public.landwise_application_versions set result=jsonb_set(result,'{quotaFixturePadding}','\"\"'::jsonb) where id=$1", [versionId]);
  const current = await usage(user);
  const padding = targetBytes - current.bytes;
  assert.ok(padding >= 0);
  await sql("update public.landwise_application_versions set result=jsonb_set(result,'{quotaFixturePadding}',to_jsonb(repeat('x',$2::integer))) where id=$1", [versionId, padding]);
  assert.equal((await usage(user)).bytes, targetBytes);
}

test('storage migration keeps legacy over-limit records and permits reductions without allowing growth', async () => {
  const legacy = users[39];
  const before = await usage(legacy);
  assert.equal(before.applicationCount, 51);
  assert.ok(before.bytes > 5 * 1024 * 1024);
  await as('authenticated', legacy);
  const listed = (await rpc('landwise_application_list')).applications;
  const large = listed.find(item => item.versionCount === 11);
  assert.ok(large);
  const original = await get(large.id);
  assert.equal(original.history.length, 101);
  assert.equal(original.versions.length, 11);
  await quotaError(save(inputs('Legacy extra application')), 'landwise_application_limit');
  const shorter = await update(large.id, { notes: '' });
  assert.equal(shorter.history.length, 101);
  assert.equal(shorter.versions.length, 11);
  await quotaError(update(large.id, { notes: 'grow' }), 'landwise_user_storage_limit');
  await quotaError(update(large.id, { stage: 'interview' }), 'landwise_history_limit');
  assert.ok((await usage(legacy)).bytes < before.bytes);
  await as('authenticated', legacy);
  await rpc('landwise_application_remove', [large.id]);
  assert.equal((await usage(legacy)).applicationCount, 50);
  await verifyCounters();
  // Finish cleaning the legacy fixture through accounting-triggered deletes.
  await sql('delete from public.landwise_applications where user_id=$1', [legacy]);
  assert.deepEqual(await usage(legacy), { applicationCount: 0, bytes: 0 });
  await verifyCounters();
});

test('50 applications is an inclusive per-account cap; another user and idempotent saves still work', async () => {
  const owner = users[8];
  await as('authenticated', owner);
  const saved = [];
  for (let index = 0; index < 50; index++) saved.push(await save(inputs(`Application cap ${index}`)));
  assert.equal((await rpc('landwise_application_list')).applications.length, 50);
  assert.equal((await save(inputs('Application cap 0'))).versionId, saved[0].versionId);
  await quotaError(save(inputs('Application cap 50')), 'landwise_application_limit');
  assert.equal((await rpc('landwise_application_list')).applications.length, 50);
  await as('authenticated', users[9]);
  assert.equal((await save(inputs('Application cap 50'))).versionCount, 1);
  await rejectCode(sql('insert into public.landwise_applications(user_id,job_key,role_title) values ($1,$2,$3)', [owner, 'a'.repeat(64), 'Bypass']), '42501');
  await rejectCode(sql('select * from landwise_private.landwise_storage_user_usage'), '42501');
  await as('authenticated', owner);
  await rpc('landwise_application_remove', [saved[0].id]);
  await save(inputs('Application cap 50'));
  assert.equal((await usage(owner)).applicationCount, 50);
  await verifyCounters();
});

test('ten saved versions are retained, the eleventh is rejected and retries do not use another slot', async () => {
  await as('authenticated', users[10]);
  const input = inputs('Version boundary');
  let saved;
  for (let version = 1; version <= 10; version++) {
    input.result.transformedResume = `Saved draft ${version}`;
    saved = await save(input);
    assert.equal(saved.versionCount, version);
  }
  const duplicate = await save(input);
  assert.equal(duplicate.versionId, saved.versionId);
  input.result.transformedResume = 'An eleventh draft';
  await quotaError(save(input), 'landwise_version_limit');
  const kept = await get(saved.id);
  assert.equal(kept.versions.length, 10);
  assert.equal(kept.versions[0].result.transformedResume, 'Saved draft 1');
  assert.equal(kept.versions[9].result.transformedResume, 'Saved draft 10');
  await update(saved.id, { notes: 'Interview preparation still works.' });
  await verifyCounters();
});

test('5 MiB budget counts UTF-8 bytes exactly, blocks RPC growth atomically, and deletion reclaims it', async () => {
  const owner = users[11];
  await as('authenticated', owner);
  const input = inputs('User byte boundary');
  const saved = await save(input);
  await fillUserTo(owner, saved.versionId, 5 * 1024 * 1024 - 3);
  await as('authenticated', owner);
  await update(saved.id, { notes: 'é' }); // Two UTF-8 bytes, one JS character.
  assert.equal((await usage(owner)).bytes, 5 * 1024 * 1024 - 1);
  await as('authenticated', owner);
  await update(saved.id, { notes: 'abc' });
  assert.equal((await usage(owner)).bytes, 5 * 1024 * 1024);
  await as('authenticated', owner);
  await quotaError(update(saved.id, { notes: 'four' }), 'landwise_user_storage_limit');
  assert.equal((await save(input)).versionId, saved.versionId);
  await quotaError(save({ ...input, result: { ...input.result, transformedResume: 'A new draft' } }), 'landwise_user_storage_limit');
  assert.equal((await get(saved.id)).versions.length, 1);
  assert.equal((await get(saved.id)).notes, 'abc');
  await as('authenticated', users[12]);
  await save(inputs('Independent user byte allowance'));
  const beforeDelete = await globalBytes();
  await as('authenticated', owner);
  await rpc('landwise_application_remove', [saved.id]);
  assert.equal(await globalBytes(), beforeDelete - 5 * 1024 * 1024);
  assert.deepEqual(await usage(owner), { applicationCount: 0, bytes: 0 });
  await as('authenticated', owner);
  await save(input);
  await verifyCounters();
});

test('history stops at 100 events without discarding old events or breaking note edits', async () => {
  await as('authenticated', users[13]);
  const saved = await save(inputs('History boundary'));
  let stage;
  for (let index = 0; index < 99; index++) {
    stage = index % 2 ? 'resume' : 'applied';
    await update(saved.id, { stage });
  }
  const before = await get(saved.id);
  assert.equal(before.history.length, 100);
  await quotaError(update(saved.id, { stage: stage === 'applied' ? 'resume' : 'applied' }), 'landwise_history_limit');
  const after = await update(saved.id, { notes: 'Notes remain editable.' });
  assert.deepEqual(after.history, before.history);
  assert.equal(after.stage, before.stage);
  await verifyCounters();
});

test('100 MiB global payload cap is shared across users and rejects whole writes until deletion frees space', async () => {
  const globalLimit = 100 * 1024 * 1024;
  const filled = [];
  // Store real payloads rather than faking the counter. A single large fixture
  // version is built with privileged SQL to avoid hundreds of repetitive RPCs;
  // every fixture mutation is still checked by the database quota triggers.
  for (let index = 14; index < 34; index++) {
    const user = users[index];
    await as('authenticated', user);
    const saved = await save(inputs(`Global budget ${index}`));
    const owned = await usage(user);
    const remaining = globalLimit - await globalBytes();
    await fillUserTo(user, saved.versionId, Math.min(5 * 1024 * 1024, owned.bytes + remaining));
    filled.push({ user, ...saved });
  }
  assert.equal(await globalBytes(), globalLimit);
  await as('authenticated', users[34]);
  await quotaError(save(inputs('One account beyond global budget')), 'landwise_global_storage_limit');
  assert.deepEqual(await rpc('landwise_application_list'), { applications: [] });
  await as('authenticated', filled[19].user);
  await quotaError(update(filled[19].id, { notes: 'x' }), 'landwise_global_storage_limit');
  await verifyCounters();
  await as('authenticated', filled[0].user);
  await rpc('landwise_application_remove', [filled[0].id]);
  assert.equal(await globalBytes(), globalLimit - 5 * 1024 * 1024);
  await as('authenticated', users[34]);
  assert.equal((await save(inputs('One account beyond global budget'))).versionCount, 1);
  await verifyCounters();
});
