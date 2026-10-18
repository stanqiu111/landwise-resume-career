import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL engine, serialized PGlite connection. These verify durable
// transitions/constraints; separate-session production lock scheduling still
// requires staging verification. No hosted database or provider calls occur.
const db = new PGlite();
const user = randomUUID();
const otherUser = randomUUID();
const hash = value => createHash('sha256').update(value).digest('hex');
const guest = hash('guest');
const ip = hash('trusted-ip');
const input = hash('resume-and-jd-and-model');
const query = (sql, args = []) => db.query(sql, args);
async function as(role) { await db.exec(`reset role; set role ${role};`); }
async function rpc(name, args = []) {
  return (await query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args)).rows[0].result;
}
const reserve = (options = {}) => rpc('landwise_ai_reserve', [options.requestId || randomUUID(), options.userId ?? null,
  options.userId ? null : options.guestHash || guest, options.ipHash || ip, options.inputHash || input, options.maxCostMicrousd || 60000, options.operation || 'transform']);
const complete = (job, cost = null, result = { transformedResume: 'Synthetic test resume' }) => rpc('landwise_ai_complete', [job.jobId, cost, result]);
const failure = (job, cost = null) => rpc('landwise_ai_fail', [job.jobId, cost]);
const status = (userId = null, guestHash = guest) => rpc('landwise_ai_status', [userId, userId ? null : guestHash]);
const rejects = (promise, detail) => assert.rejects(promise, error => error.code === 'P0001' && error.detail === detail);

before(async () => {
  await db.exec(`set timezone='UTC'; create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key); create schema landwise_private;
    revoke all on schema landwise_private from public,anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  await query('insert into auth.users(id) values ($1),($2)', [user, otherUser]);
  await db.exec(await readFile(new URL('../supabase/migrations/202610170002_landwise_ai_budget.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await as('postgres');
  await db.exec(`truncate landwise_private.landwise_ai_jobs,landwise_private.landwise_ai_months,
    landwise_private.landwise_ai_days,landwise_private.landwise_ai_ip_days,landwise_private.landwise_ai_entitlements,
    landwise_private.landwise_upload_days cascade;`);
  await as('service_role');
});
after(async () => { await db.close(); });

test('only service-role RPCs may reserve, settle, read status or acquire upload capacity', async () => {
  for (const role of ['anon', 'authenticated']) {
    await as(role);
    for (const operation of [() => reserve(), () => status(), () => complete({ jobId: randomUUID() }),
      () => failure({ jobId: randomUUID() }), () => rpc('landwise_upload_acquire', [guest, ip])]) {
      await assert.rejects(operation(), error => error.code === '42501');
    }
  }
  await as('service_role');
  await assert.rejects(query('select * from landwise_private.landwise_ai_jobs'), error => error.code === '42501');
  assert.deepEqual(await status(), { guestEligible: true, remaining: 1, available: true });
  const receipt = await reserve();
  assert.equal(receipt.admitted, true);
  assert.ok(!JSON.stringify(receipt).includes(guest));
  assert.ok(!JSON.stringify(receipt).includes(ip));
});

test('request UUID/input hash replay is actor-scoped and never admits a duplicate provider job', async () => {
  const requestId = randomUUID();
  const first = await reserve({ requestId });
  assert.equal((await status()).reason, 'ai_busy');
  const duplicate = await reserve({ requestId });
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.admitted, false);
  await rejects(reserve({ requestId, inputHash: hash('changed-body') }), 'landwise_ai_idempotency_conflict');
  await rejects(reserve({ requestId, guestHash: hash('different-guest') }), 'landwise_ai_busy');
  const result = { transformedResume: 'Verified synthetic draft', report: { score: 70 } };
  await complete(first, 12000, result);
  const replayed = await reserve({ requestId });
  assert.equal(replayed.admitted, false);
  assert.deepEqual(replayed.result, result);
  assert.equal(replayed.chargedCostMicrousd, 12000);
  const other = await reserve({ requestId, guestHash: hash('different-guest'), ipHash: hash('another-ip') });
  assert.equal(other.admitted, true);
  assert.notEqual(other.jobId, first.jobId);
  assert.equal(other.result, undefined);
});

test('failures keep entitlement but count attempts and charge actual or whole unknown reservation', async () => {
  const first = await reserve();
  const failed = await failure(first);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.chargedCostMicrousd, 60000);
  assert.equal((await status()).remaining, 1);
  const second = await reserve();
  await failure(second, 13625);
  const third = await reserve();
  await failure(third, 0);
  await rejects(reserve(), 'landwise_ai_ip_limit');
  await as('postgres');
  const monthly = (await query('select attempts,committed_microusd from landwise_private.landwise_ai_months')).rows[0];
  assert.equal(monthly.attempts, 3);
  assert.equal(Number(monthly.committed_microusd), 73625);
});

test('a guest gets one lifetime successful transform and signed users get three successful monthly jobs', async () => {
  await rejects(reserve({ operation: 'analyze' }), 'landwise_ai_sign_in_required');
  await complete(await reserve(), 1000);
  assert.deepEqual(await status(), { guestEligible: false, remaining: 0, available: false, reason: 'guest_trial_used' });
  await rejects(reserve({ ipHash: hash('new-ip') }), 'landwise_ai_allowance_used');
  for (const operation of ['transform', 'revise', 'analyze']) {
    await complete(await reserve({ userId: user, operation, ipHash: hash(operation) }), 1000);
  }
  assert.equal((await status(user)).remaining, 0);
  assert.equal((await status(user)).reason, 'monthly_allowance');
  await rejects(reserve({ userId: user, ipHash: hash('fresh-ip') }), 'landwise_ai_allowance_used');
  assert.equal((await status(otherUser)).remaining, 3);
  await as('postgres');
  await query("update landwise_private.landwise_ai_entitlements set month=month - interval '1 month' where actor_key=$1", [`user:${user}`]);
  await as('service_role');
  assert.equal((await status(user)).remaining, 3);
  assert.equal((await status()).remaining, 0);
});

test('the monthly US$4 boundary reserves worst case first, then blocks further spending', async () => {
  const first = await reserve({ maxCostMicrousd: 3940000 });
  await failure(first);
  const last = await reserve();
  assert.equal(last.admitted, true);
  await failure(last);
  await rejects(reserve({ maxCostMicrousd: 1 }), 'landwise_ai_budget_limit');
  assert.equal((await status()).reason, 'monthly_budget');
  await as('postgres');
  assert.equal(Number((await query('select committed_microusd from landwise_private.landwise_ai_months')).rows[0].committed_microusd), 4000000);
});

test('actual overrun is recorded rather than hidden and settlement is idempotent', async () => {
  const job = await reserve();
  const settled = await complete(job, 4000001);
  assert.equal(settled.chargedCostMicrousd, 4000001);
  assert.deepEqual(await failure(job, 0), settled);
  assert.deepEqual(await complete(job, 0), settled);
  await rejects(reserve({ guestHash: hash('another-guest'), ipHash: hash('another-ip') }), 'landwise_ai_budget_limit');
  await as('postgres');
  assert.equal((await query('select successful_jobs from landwise_private.landwise_ai_entitlements')).rows[0].successful_jobs, 1);
});

test('ten global daily attempts and 100 monthly attempts count failures and reject admission atomically', async () => {
  for (let index = 0; index < 10; index++) await failure(await reserve({ ipHash: hash(`ip-${index}`) }), 0);
  await rejects(reserve({ ipHash: hash('ip-11') }), 'landwise_ai_daily_limit');
  await as('postgres');
  await query('update landwise_private.landwise_ai_days set attempts=0');
  await query('update landwise_private.landwise_ai_months set attempts=99');
  await as('service_role');
  await failure(await reserve({ ipHash: hash('new-month-boundary-ip') }), 0);
  await rejects(reserve({ ipHash: hash('new-month-boundary-ip2') }), 'landwise_ai_monthly_limit');
  await as('postgres');
  assert.equal((await query('select attempts from landwise_private.landwise_ai_months')).rows[0].attempts, 100);
  assert.equal((await query('select attempts from landwise_private.landwise_ai_days')).rows[0].attempts, 1);
});

test('overlapping admissions have one winner and an old active job never expires into overlapping work', async () => {
  const jobs = await Promise.allSettled([reserve(), reserve({ guestHash: hash('other'), ipHash: hash('other-ip') })]);
  assert.equal(jobs.filter(job => job.status === 'fulfilled').length, 1);
  const active = jobs.find(job => job.status === 'fulfilled').value;
  await as('postgres');
  await query("update landwise_private.landwise_ai_jobs set created_at=clock_timestamp()-interval '1 day' where id=$1", [active.jobId]);
  await as('service_role');
  await rejects(reserve({ guestHash: hash('third'), ipHash: hash('third-ip') }), 'landwise_ai_busy');
  assert.equal((await status()).reason, 'ai_busy');
  await failure(active);
  assert.equal((await reserve({ guestHash: hash('third'), ipHash: hash('third-ip') })).admitted, true);
});

test('expired or oversized cached results never restore allowance or cause replay to rerun AI', async () => {
  const requestId = randomUUID();
  const job = await reserve({ requestId });
  await complete(job, 500, { output: 'x'.repeat(220000) });
  const oversized = await reserve({ requestId });
  assert.equal(oversized.resultUnavailable, true);
  assert.equal(oversized.admitted, false);
  assert.equal((await status()).remaining, 0);
  const secondRequest = randomUUID();
  const signed = await reserve({ requestId: secondRequest, userId: user, ipHash: hash('signed-ip') });
  await complete(signed, 500, { output: 'recoverable' });
  await as('postgres');
  const stored = (await query('select created_at,expires_at from landwise_private.landwise_ai_results where job_id=$1', [signed.jobId])).rows[0];
  assert.equal(new Date(stored.expires_at) - new Date(stored.created_at), 7 * 86400000);
  await query("update landwise_private.landwise_ai_results set expires_at=clock_timestamp()-interval '1 second'");
  await as('service_role');
  const expired = await reserve({ requestId: secondRequest, userId: user, ipHash: hash('signed-ip') });
  assert.equal(expired.admitted, false);
  assert.equal(expired.resultUnavailable, true);
  assert.equal((await status(user)).remaining, 2);
});

test('durable recovery results stay under 10 MiB by evicting oldest cache entries only', async () => {
  await as('postgres');
  await query(`insert into landwise_private.landwise_ai_jobs(actor_key,request_id,input_hash,ip_hash,operation,status,reservation_month,reserved_cost_microusd,charged_cost_microusd,settled_at)
    select 'guest:'||encode(sha256(convert_to('cache-'||i,'UTF8')),'hex'),gen_random_uuid(),$1,$2,'transform','completed',date_trunc('month',now())::date,60000,0,now()
    from generate_series(1,48) i`, [input, ip]);
  await query(`insert into landwise_private.landwise_ai_results(job_id,result,payload_bytes,expires_at,created_at)
    select id,jsonb_build_object('output',repeat('x',217986)),218000,now()+interval '1 day',now()-interval '1 day'
    from landwise_private.landwise_ai_jobs`);
  await as('service_role');
  const job = await reserve();
  await complete(job, 0, { output: 'x'.repeat(217986) });
  await as('postgres');
  const totals = (await query('select count(*)::integer as count,sum(payload_bytes)::bigint as bytes from landwise_private.landwise_ai_results')).rows[0];
  assert.equal(totals.count, 48);
  assert.ok(Number(totals.bytes) <= 10 * 1024 * 1024);
  assert.equal((await query('select count(*)::integer as count from landwise_private.landwise_ai_jobs')).rows[0].count, 49);
  assert.equal((await query('select sum(successful_jobs)::integer as count from landwise_private.landwise_ai_entitlements')).rows[0].count, 1);
});

test('PDF quotas are independent, atomic, scoped by guest/IP and retain only three days', async () => {
  const upload = (guestHash = guest, ipHash = ip) => rpc('landwise_upload_acquire', [guestHash, ipHash]);
  for (let index = 0; index < 10; index++) assert.equal(await upload(), true);
  await rejects(upload(), 'landwise_upload_limit');
  await rejects(upload(hash('new-guest')), 'landwise_upload_limit');
  await rejects(upload(guest, hash('new-ip')), 'landwise_upload_limit');
  assert.equal(await upload(hash('new-guest'), hash('new-ip')), true);
  assert.equal((await reserve()).admitted, true, 'uploads do not consume AI attempts');
  await as('postgres');
  await query("insert into landwise_private.landwise_upload_days(day,scope,attempts) values (current_date-4,'global',99)");
  await query("update landwise_private.landwise_upload_days set attempts=99 where day=current_date and scope='global'");
  await as('service_role');
  assert.equal(await upload(hash('last-guest'), hash('last-ip')), true);
  await rejects(upload(hash('one-too-many'), hash('one-too-many')), 'landwise_upload_limit');
  await as('postgres');
  assert.equal((await query('select count(*)::integer as count from landwise_private.landwise_upload_days where day<current_date-2')).rows[0].count, 0);
  assert.equal((await query("select attempts from landwise_private.landwise_upload_days where day=current_date and scope='global'")).rows[0].attempts, 100);
});
