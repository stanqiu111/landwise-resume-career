import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// The production upgrade path: the original ledger holding live data, then the
// guest-trial migration (pasted twice), then its rollback script. No hosted
// database or provider calls occur.
const db = new PGlite();
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const input = hash('resume-and-jd');
const query = (text, args = []) => db.query(text, args);
async function as(role) { await db.exec(`reset role; set role ${role};`); }
async function rpc(name, args = []) {
  return (await query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args)).rows[0].result;
}
const reserve = (guestHash, ipHash) => rpc('landwise_ai_reserve', [randomUUID(), null, guestHash, ipHash, input, 60000, 'transform']);
const complete = (job, cost) => rpc('landwise_ai_complete', [job.jobId, cost, { transformedResume: 'Synthetic test resume' }]);
const failure = job => rpc('landwise_ai_fail', [job.jobId, 0]);
const status = guestHash => rpc('landwise_ai_status', [null, guestHash]);
const rejects = (promise, detail) => assert.rejects(promise, error => error.code === 'P0001' && error.detail === detail);
const FUNCTIONS = ['public.landwise_ai_status(uuid,text)', 'public.landwise_ai_reserve(uuid,uuid,text,text,text,bigint,text)',
  'public.landwise_upload_acquire(text,text)'];
const SERVICE_ONLY = FUNCTIONS.map(fn => `service_role:${fn.split('(')[0]}`).sort();

async function executors() {
  await as('postgres');
  const allowed = [];
  for (const fn of FUNCTIONS) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows: [row] } = await query("select has_function_privilege($1, $2, 'execute') as ok", [role, fn]);
      if (row.ok) allowed.push(`${role}:${fn.split('(')[0]}`);
    }
  }
  await as('service_role');
  return allowed.sort();
}

before(async () => {
  await db.exec(`set timezone='UTC'; create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key); create schema landwise_private;
    revoke all on schema landwise_private from public,anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  await db.exec(await sql('migrations/202610170002_landwise_ai_budget.sql'));
});
after(async () => { await db.close(); });

test('the guest-trial migration upgrades live ledger data in place and its rollback restores the old limits', async () => {
  const veteran = hash('guest-who-used-the-old-trial');
  const campus = hash('shared-campus-ip');
  await as('service_role');
  await complete(await reserve(veteran, campus), 1000);
  await failure(await reserve(hash('second-guest'), campus));
  await failure(await reserve(hash('third-guest'), campus));
  await rejects(reserve(hash('fourth-guest'), campus), 'landwise_ai_ip_limit');
  assert.equal((await status(veteran)).reason, 'guest_trial_used');
  const inFlight = await reserve(hash('in-flight-guest'), hash('other-ip'));
  await as('postgres');
  await db.exec('grant execute on function public.landwise_ai_status(uuid,text) to anon, public;');

  const forward = await sql('migrations/202610200001_landwise_guest_trials.sql');
  await db.exec(forward);
  await db.exec(forward);
  assert.deepEqual(await executors(), SERVICE_ONLY, 'only the server role may call the ledger, even after a stray grant');
  assert.equal((await status(veteran)).reason, 'ai_busy', 'a job reserved before the upgrade still holds the slot');
  await complete(inFlight, 2000);
  assert.deepEqual(await status(veteran), { guestEligible: true, remaining: 14, available: true });
  const fourth = await reserve(hash('fourth-guest'), campus);
  assert.equal(fourth.admitted, true, 'the shared IP gets the new per-connection allowance');
  await failure(fourth);

  await as('postgres');
  await db.exec(await sql('rollbacks/202610200001_landwise_guest_trials_down.sql'));
  assert.deepEqual(await executors(), SERVICE_ONLY);
  assert.deepEqual(await status(veteran), { guestEligible: false, remaining: 0, available: false, reason: 'guest_trial_used' });
  await rejects(reserve(hash('fifth-guest'), campus), 'landwise_ai_ip_limit');
  assert.equal((await status(hash('brand-new-guest'))).remaining, 1);
});
