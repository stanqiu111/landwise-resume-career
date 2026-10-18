# Landwise accounts, storage and hosted API ledger

Updated October 17, 2026. The selected project is the Personal / Free project
`supabase-amber-pebble` (`audfewrmqgsefeutappd`). The public URL is
**https://landwise-nu.vercel.app**.

All three migrations, including the hosted AI ledger, are applied remotely.
The hosted API runtime is **locally tested but not activated**. No hosted
OpenAI API key or service-role runtime key is configured, and an enforceable
US$5 provider spending stop has not been verified.
Custom SMTP is OFF, and public account email delivery has not been verified.
Keep public account sign-in disabled until its authentication flow is ready.
See [deployment status](./DEPLOYMENT.md) for the live/source distinction.

## Application ownership and stored data

Supabase mode gives each verified Landwise account its own library: original
resume text, job description, tailored versions, fit reports, follow-up history,
notes and practice progress. Original PDF binaries are not stored in Supabase;
PDF and DOCX exports are regenerated in the browser. The local studio defaults
to local folders, and switching storage mode does not upload those folders.

The server verifies each account bearer token with Supabase Auth and rejects
unconfirmed or anonymous accounts. Application RPCs then use that same end-user
token and the publishable project key. Ownership comes from `auth.uid()`, never
a user ID supplied by the browser. RLS protects direct reads; owner-scoped RPCs
serialize writes. Service-role credentials are **not used for library CRUD**.
Auth or storage failures never fall back to a local or another user's library.
A completed AI draft remains exportable if its account save fails.

Storage triggers enforce 50 applications/user, 10 versions/application,
5 MiB/user, 100 MiB globally and 100 history events/application. Notes are capped
at 12,000 characters; practice lists at 100 tasks with 1,000-character titles.
Saved page limits are 1–20; save/patch payloads also have a 220,000-character
input bound. Logical payload accounting includes serialized application/version
rows, not PostgreSQL indexes or physical disk overhead. Direct RPC calls cannot
bypass these limits. Existing versions/history are retained when full; new
growth is rejected atomically. Deletions and smaller edits reclaim quota.

## Migration and account setup

1. Foundation: `supabase/migrations/202610160001_landwise_foundation.sql`.
   Storage limits: `202610170001_landwise_storage_limits.sql`. Both are already
   applied to this project via the SQL Editor; do not rerun them. They are not
   recorded as CLI migration-history entries. Preserve that distinction when
   adopting CLI deployment.
2. Hosted pilot: `202610170002_landwise_ai_budget.sql` is also already applied
   via the SQL Editor. It adds private tables and service-role-only spending,
   allowance and upload RPCs. Live verification found seven protected ledger
   tables, five server RPCs, zero browser-callable RPCs, five service-role-callable
   RPCs and zero AI jobs. It does not activate AI, fund an API account or configure
   email delivery. No resumes or AI jobs were created by these checks.
3. Configure exact authentication redirects. Local testing uses
   `http://127.0.0.1:5174/`; production uses
   `https://landwise-nu.vercel.app/`. Set up and verify custom SMTP for email
   links, or implement/configure and verify a supported Google OAuth flow.
   Leave `LANDWISE_ACCOUNT_SIGN_IN_ENABLED=false` until that work is complete.
4. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in server configuration.
   For the optional local cloud library, also set
   `LANDWISE_APPLICATION_STORAGE=supabase`. The hosted entrypoint always uses
   cloud storage; it never writes local application folders. The public config
   route intentionally returns the publishable key. A legacy `anon` key is
   accepted; secret/service-role keys are rejected in this field.
5. Hosted AI additionally needs server-only `SUPABASE_SERVICE_ROLE_KEY`,
   `OPENAI_API_KEY` and a stable random `LANDWISE_SESSION_SECRET` of at least
   32 bytes. Set the exact HTTPS `LANDWISE_APP_ORIGIN`. Never put these secrets
   in `VITE_*` variables, frontend builds, Git or logs. Enable
   `LANDWISE_HOSTED_AI_ENABLED` only after the separate spending/activation
   checks in [DEPLOYMENT.md](./DEPLOYMENT.md#activation-procedure).
6. Before exposing account sign-in, use two real test accounts: save the same
   JD in each, verify distinct libraries, and confirm neither can read, edit or
   delete the other's application ID. Account switches must clear the studio
   and cancel in-flight work; a same-account token refresh must preserve it.

## Hosted API allowance and spending

Hosted AI uses the application's server-funded OpenAI API key. It does not use
visitors' ChatGPT plans or the owner's local ChatGPT credentials. A signed guest
cookie permits one successful Transform; verified accounts permit three
successful AI jobs per UTC month across Transform, Analyze and follow-up.
Guest Analyze/follow-up require sign-in. Cookies cannot establish one human:
clearing or expiring a cookie, using incognito or another browser creates another
identity. Guest quota hashes depend on the session secret, which must remain
stable across deployments. A guest's successful result is downloadable and may
be cached for recovery, but is not automatically saved to an account library.

The service reserves US$0.06 before inference against a US$4 monthly application
budget. It admits at most one global active job, 10 attempts/day, 100/month and
3 attempts/IP/day. Failures keep the success allowance but still count as
attempts and spending. Known provider usage settles cost; uncertain sent calls
are conservatively estimated, and unknown total cost keeps the full reservation.
Provider usage comes only from the trusted server, never client claims.
Attempts/cost belong to the UTC reservation month; account success allowances
use the UTC completion month. Application deletion does not restore an AI
allowance. A successful result still counts if saving its application fails.

The provider adapter permits at most four calls/job, 60,000 UTF-8 bytes/request,
12,000 output tokens/call and 60 seconds/call. Work has a 240-second route budget
inside the 300-second function limit, with remaining time reserved for save and
settlement. No provider auto-retry or automatic credit reload is enabled.
**The US$5 provider-side spending stop remains unverified.** An alert-only
budget is insufficient; the application gate is not proof of a billing hard
cap. Keep AI disabled until that stop and the US$1 margin are established.

The AI migration exposes only these server-role RPCs:

| RPC | Purpose |
| --- | --- |
| `landwise_ai_status` | Return allowance/availability for one server-verified actor |
| `landwise_ai_reserve` | Atomically reserve cost, attempt and global job slot |
| `landwise_ai_complete` | Settle cost, consume success allowance and optionally cache result |
| `landwise_ai_fail` | Settle failed cost without consuming success allowance |
| `landwise_upload_acquire` | Atomically admit a PDF upload separately from AI attempts |

The private ledger stores hashed guest/IP identities, request/input hashes,
status, cost and timestamps. It does not store raw IPs, credentials, original
resume or JD inputs. A bounded recovery result can contain tailored resume text,
report and quoted source evidence; it is sensitive data too. Cache limits are
220,000 serialized UTF-8 bytes/result and 10 MiB total. Results are recoverable
for up to seven days, with earlier eviction when full. Expired results are
unavailable but removed only on the next status, reserve or successful complete
operation; without activity they can remain stored longer. Cost and entitlement
records outlive the cache and application deletion. Oversized results still
settle successfully but cannot be recovered from this cache.

PDF parsing accepts one file up to 2 MiB, 1–20 pages and 30,000 extracted
characters, in a credential-free worker with a 10-second deadline and at most
one worker per process. Heap and best-effort RSS limits are documented in
[deployment limits](./DEPLOYMENT.md#hosted-pilot-architecture-and-limits).
Upload admission allows 100 attempts/day globally, 10/IP/day and
10/guest/day. These counters use UTC, retain the current and previous two days
on subsequent upload admission, and contain no uploaded content. They do not
consume AI attempt budgets.

An actor's request UUID is bound to its operation and input hash. Same-input
replays return the existing job/result without inference; changed-input replays
are rejected. Browser identities, prices and usage never control ledger calls.
The original `landwise_trial_*` functions in the foundation are legacy,
inactive groundwork; the API pilot uses `landwise_ai_*` and does not wire the
old subscription sponsorship flow.

## Reconciling an interrupted AI job

There is no automatic reservation expiry. If a worker crashes or both settlement
calls fail, all new AI work remains blocked by the reserved global slot. A
reservation can also commit successfully while its HTTP response is lost; in
that case the worker may not know the job ID. Browser disconnection does not
cancel the independent settlement RPC. The safe failure mode is reduced
availability until an operator reconciles the job.

The pilot has no configured alert delivery service. Monitor the Vercel runtime
console for `hosted_settlement_pending` (job ID) and `hosted_reservation_unconfirmed`
(request ID), and investigate sustained `hosted_ai_busy` responses. These logs
must contain identifiers only, not actor identities, resume/JD text or secrets.

1. Disable new admission with `LANDWISE_HOSTED_AI_ENABLED=false` and verify
   workers are quiesced. As a privileged database operator, inspect reserved
   jobs older than the 300-second function limit plus an operational margin.
   This query uses a 60-second margin and does not select private result data:

   ```sql
   select id, request_id, operation, created_at, reservation_month,
          reserved_cost_microusd
   from landwise_private.landwise_ai_jobs
   where status = 'reserved'
     and created_at < clock_timestamp() - interval '6 minutes';
   ```

2. Match the request/job ID to runtime and provider usage evidence. Confirm the
   original function and remote provider work have stopped. The query's age
   filter alone is insufficient; never admit a replacement while the old job
   might still be live. Do not log or copy resume/JD contents while inspecting.
3. Reconcile a known completed result with the service-only complete operation
   when its result and provider cost are trustworthy. If completion cannot be
   established but the work is definitely stopped, conservatively settle the
   recorded job as failed, charging its entire US$0.06 reservation:

   ```sql
   select public.landwise_ai_fail('REPLACE_WITH_CONFIRMED_JOB_UUID'::uuid, null);
   ```

   This preserves the first-success/monthly success allowance, but does not
   refund attempts or the reserved cost. A repeat settlement preserves the
   recorded completed/failed state. Never delete the job, reset cost/entitlement
   counters or enter zero cost merely because usage is unknown.
4. Verify no reserved job remains and inspect the remaining application and
   provider budget before enabling admission again. Record the operator action
   with identifiers only. No automatic expiry, refund or retry should replace
   this reconciliation.

## Validation boundaries

`npm test` includes real PostgreSQL-engine tests through PGlite for RLS, role
permissions, ownership, quota boundaries, version/history retention,
idempotency, cache bounds and allowance/cost settlement. Adapter/security/API
tests cover identity verification, fixed safe errors, secret isolation and
provider failures without paid calls. PGlite uses one connection: these tests
do not prove separate-session contention, production credentials, provider
billing enforcement, email delivery or live two-account isolation. Those
remain activation checks against the hosted environment.

Relevant documentation: [Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser),
[row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security),
[redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
