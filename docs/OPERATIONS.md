# Operating the live site

Reviewed October 20, 2026. Start here for routine maintenance.
The detailed configuration and caps are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Who runs what

| System | Owner responsibility |
| --- | --- |
| GitHub `stanqiu111/landwise-resume-career` | Review changes, pass validation, protect access and source history |
| Vercel project | Hosting, deployment status, runtime logs, environment variables and domains |
| Supabase project | Database availability, email/auth configuration, backups and per-user data |
| Dedicated OpenAI API project | Credits, hard spend limit, key access/expiry, model access and usage review |

The live website keeps running when your laptop is off. Its availability depends
on these hosted services, not the local `npm run dev` process. Vercel's function
filesystem is not a durable application database.

## Regular checks

**After every deployment:**

1. Confirm the intended Git commit is Ready in Vercel and attached to
   `https://landwise-resume.vercel.app`.
2. Run `npm run check:live`. It checks hosted configuration, a guest session
   against the ledger, and public storage config without generating a resume.
   `aiAvailable:false` may mean a budget, capacity or allowance limit; inspect
   `reason`. `/api/health` alone does not test database/provider reachability.
3. Open the studio and career events at desktop and phone widths. After changing
   generation/export behavior, separately test a synthetic resume, confirm its
   report/page count, and inspect the resulting budget settlement.
4. Check Vercel logs for runtime errors. Do not paste keys, cookies, resumes or
   job descriptions into diagnostics.

**While people are using the pilot:** watch failed jobs and sustained busy
responses. There is no configured uptime alert service, automatic job repair,
backup schedule, or operator notification delivery. Log statements alone do
not send an alert. Do not describe the pilot as unattended or highly available.

**Weekly:** check Vercel usage, Supabase database health/storage and pause emails,
OpenAI usage/remaining credit, and outdated career-event sources. Review
`npm audit` and dependency release notes before applying focused updates; do not
run `npm audit fix --force` blindly. Run `npm run check` after dependency changes.
Keep `package-lock.json` committed and use `npm ci` for reproducible installs.

**Monthly and before raising usage:** review the US$10 application gate and the
provider limit (at least US$11) together, reconcile conservatively charged failures, recheck
model pricing and call bounds, and test restoring a private database backup.
The successful live test cost is an example, not a promise of cost per resume.

**For the first week after raising limits:** run this daily in the SQL Editor. Any
row is a stuck job that blocks all AI work; handle it with
[Stop AI spending or investigate a stuck job](#stop-ai-spending-or-investigate-a-stuck-job).

```sql
select id, created_at from landwise_private.landwise_ai_jobs
where status = 'reserved' and created_at < clock_timestamp() - interval '6 minutes';
```

## Deployments and rollback

Use a branch and pull request for every change, as in the
[shipping guide](SHIPPING.md), and run:

```sh
npm ci
npm run security:setup
npm run check
```

A separate GitHub Actions workflow is not configured: the current GitHub OAuth
connection does not have permission to create workflow files. Run the full
check locally before pushing. Production validation is enforced by the Vercel
build below, independently of GitHub Actions. Branch protection is not configured
by this repository; a future PR-required check would need separate setup.

Pushing/merging `main` triggers Vercel. `vercel.json` runs
`npm run verify:hosted`: source secret scan, lint, the test suite, then the hosted
build and credential reference scan. A failure stops that deployment before it replaces the current
live alias. The local build is additionally checked by `npm run check`.
Build server dependencies on Vercel/Linux, especially the native PDF parser;
do not upload a macOS prebuilt function bundle.

Environment-variable changes apply to new deployments. Editing a flag or key
in Settings does not change already-running code: redeploy, then recheck the
public domain. Preview deployments should not use production funding/database
credentials. A browser-bundle preview alone has no working API.

For a bad release, use Vercel's deployment controls to restore the **last tested
hosted deployment**, and check its flags, configuration and API afterwards.
On the Hobby plan, Vercel can roll back only to the immediately previous
production deployment; if that one is not safe to restore, revert in Git and
redeploy instead.
Avoid old coming-soon preview deployments. Then revert the faulty change in
Git and redeploy so the source and live state agree. Code rollback does not
roll back Supabase migrations or restore deleted user data; plan additive,
backward-compatible migrations and verify database compatibility before rollback.

**Guest-trial limits:** `202610200001_landwise_guest_trials.sql` is applied, so
never restore a deployment from before that change until you have run
`supabase/rollbacks/202610200001_landwise_guest_trials_down.sql` in the SQL
Editor. Older servers reject a status above 3 remaining, so every guest session
would fail. To lower limits or stop spending, roll forward instead: apply new
limits in a new migration, or set `LANDWISE_HOSTED_AI_ENABLED=false` and redeploy.

## Stop AI spending or investigate a stuck job

Set `LANDWISE_HOSTED_AI_ENABLED=false` in Vercel Production and redeploy.
Verify `/api/health` reports `configured:false` and the studio says AI is
unavailable. This intentionally makes `npm run check:live` fail its readiness
check. Career events and the frontend can still be served. Disabling new
admission does not cancel an already-running provider request.

| Symptom | Action |
| --- | --- |
| Daily/monthly capacity reached | Inspect the ledger/provider usage; wait for the documented UTC reset rather than resetting counters |
| Repeated `hosted_ai_busy` long after normal processing | Check for a reserved job and follow the [manual reconciliation procedure](SUPABASE.md#reconciling-an-interrupted-ai-job) |
| `hosted_settlement_pending` / `hosted_reservation_unconfirmed` | Disable admission while reconciling; do not clear a slot until remote work is known to have stopped |
| Provider 429 or unavailable | Check sanitized provider code/request ID, project credit, hard limits and model/key access |
| Database unavailable | Check Supabase status, paused-project state and credentials; do not fall back to another user's files |
| Result ready but saving failed | User can download/retry saving; a successful AI job still consumes its allowance |
| Browser lost connection | Retry the same unchanged request in that tab to recover its cached result; avoid refresh while unsaved |

A confirmed generation failure does not consume the success allowance, but
its attempts and incurred costs remain. Unknown sent-call costs are charged
conservatively. A completed request whose response was lost still counts as
success. Cached recovery lasts up to seven days and may be evicted sooner;
request IDs in the browser do not survive refresh.

Keep the dedicated provider hard limit enabled and auto-reload OFF. Verify these
settings in the provider dashboard; code does not configure or prove them.
OpenAI hard-limit enforcement can slightly overshoot while state
propagates, which is why the app’s US$10 gate stays at least US$1 below the
provider limit (US$11 or more). An alert alone is not a
spending stop. [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)

## Backups and data retention

Git backs up code, not live application data. Free Supabase projects should be
regularly exported with the Supabase CLI and stored off-site; paid plans provide
different backup options. Follow the [Supabase backup guide](https://supabase.com/docs/guides/platform/backups)
for the current procedure. No automatic off-site backup is configured here.

Include application/version tables, required auth/ownership data, and the
private `landwise_private` budget/entitlement tables in a documented backup and
restore plan. Verify what the export command includes; do not assume a default
schema dump covers everything. Store encrypted backups outside Git/Vercel
assets, limit access, and test restoration in a separate project before
relying on them. Restoring an old ledger can reopen spent allowance: reconcile
usage before re-enabling AI. Never test a restore over the live database.

Original uploaded PDF binaries are not retained by the application; the saved
library contains text and reports. The recovery cache can contain sensitive
resume/evidence text. Expiration blocks retrieval after seven days, but physical
deletion occurs on later ledger activity, so this is not a guaranteed seven-day
erasure policy. Ledger/cost history survives application deletion. Define a
retention/deletion policy and scheduled cleanup before wider adoption; do not
advertise account deletion or automatic data erasure that is not implemented.

## Changing the domain or credentials

For a custom domain, configure it in Vercel, set the exact HTTPS
`LANDWISE_APP_ORIGIN`, update Supabase Site URL/allowed auth redirects and any
links in this documentation, redeploy, and test origin/CSRF and sign-in flows.
API mutations from a different origin are deliberately rejected. Guest/IP
identity hashes include the origin, so a domain change can reset those buckets.

Keep `LANDWISE_SESSION_SECRET` stable between deployments; changing it
invalidates guest cookies and quota hashes. If a private key is exposed, disable
admission, rotate it through the provider and Vercel, redeploy, and verify access.
A Supabase project change also requires updating the `connect-src` host in
`vercel.json`. Review any key expiry policy before it causes an outage.

## Before a wider launch

For source publication, also complete [the repository security checklist](../SECURITY.md#before-changing-visibility-to-public).

- **Account access:** finish custom SMTP, production redirects and email-link
  sign-in, then test two-user isolation before enabling
  `LANDWISE_ACCOUNT_SIGN_IN_ENABLED`. Cloud libraries, Analyze and follow-up
  remain unavailable to public guests until then.
- **Availability:** Free Supabase projects may pause after a low-activity week.
  Watch the project's emails and restore it if paused. Paid plans avoid that
  automatic pausing. [Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- **Hosting eligibility:** Vercel Hobby is for personal, non-commercial use and
  has resource limits. A free-to-users product is not automatically eligible
  for a personal plan. Review eligibility before operating this as a business.
  [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- **Operations:** arrange alert delivery, ownership of incident response,
  tested backups, and privacy/retention disclosures. One-job concurrency and the
  300/day site limit are still a small pilot, not a launch-scale service.
- **Schema management:** reconcile CLI migration history before adopting
  `supabase db push`. Checked-in migrations are applied through the SQL
  Editor; [DEPLOYMENT.md](DEPLOYMENT.md#applied-migrations) lists each applied file. Add new migrations; never edit/reapply old ones.
