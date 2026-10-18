# Deployment status

Updated October 17, 2026.

## Live site and activation status

Current URL: **https://landwise-nu.vercel.app**. Vercel project
`personal-93a7/landwise` is on Hobby, connected to `stanqiu111/landwise`, production
branch `main`.

The hosted studio and API are deployed. **Paid AI and public account sign-in
remain disabled** until their activation checks are complete. Deployment
`dpl_8Rk9DxrDD6QYbWnkx5EEkr8hPgcU` from commit `e9f6b69` reached Ready on
October 17, 2026. No paid provider call was made.

| Item | Verified state |
| --- | --- |
| Hosted studio and career events | Deployed at the URL above |
| Hosted API and guest identity | Live configuration and secure cookie verified; AI disabled |
| Shared spending ledger | Applied; automated tests and live permission checks pass |
| Foundation and application storage-limit migrations | Applied to the selected Supabase project |
| AI budget migration, `202610170002_landwise_ai_budget.sql` (migration003) | Applied remotely; permissions/counts verified |
| Hosted OpenAI API key | Not configured or used for a live test |
| Hosted Supabase service-role key | Not configured in the runtime |
| Provider-side US$5 spending stop | Not verified; required before activation |
| Public account email delivery | Custom SMTP toggle is OFF; delivery is not verified |
| Public account sign-in | Keep `LANDWISE_ACCOUNT_SIGN_IN_ENABLED=false` |

The new source configuration builds `npm run build:hosted` into `dist-hosted`
and rewrites `/api/:path*` to the `api/index.js` entrypoint, with a 300-second
Vercel function limit. `npm run build:public` still produces the separate static preview.
`npm run dev` and `npm run build` retain the local studio. Local ChatGPT account
files and account-picker routes are excluded from the hosted runtime.

Six hosted environment settings have been saved in Vercel, including the
session secret, public Supabase configuration and both feature flags set to
false. This does not activate inference; the API and service-role keys are
still absent.

Live checks: `/api/health`, `/api/storage/config` and `/api/session` return JSON
200 with `Cache-Control: no-store`. Session availability is false with reason
`configuration`, and its cookie is Secure/HttpOnly. The public config contains
only Supabase's publishable key and settings. `/api/auth/session`, `/.env` and
`/server.js` return 404. The live browser showed no console errors.

## Hosted pilot architecture and limits

The hosted service uses a **server-funded OpenAI API key**, with the model fixed
in `server/openai-inference.js`. Visitors do not supply API keys or connect a
ChatGPT subscription. Local ChatGPT sign-in is a separate development workflow;
it is not the hosted billing mechanism.

A guest can complete one Transform without signing up. A verified Landwise
account can complete three AI jobs per UTC month, shared between Transform,
Analyze and follow-up revisions. Guests need an account for Analyze and
follow-up revisions. Cloud libraries belong to the verified Supabase user.
Guest results are downloadable but are not automatically assigned a cloud
application folder.

| Limit | Enforced value in the implementation |
| --- | --- |
| Application AI budget | US$4 per UTC month, including active reservations |
| Worst-case reservation before each job | US$0.06 / 60,000 microUSD |
| Global AI attempts | 10 per UTC day; 100 per UTC month |
| AI attempts per trusted IP hash | 3 per UTC day |
| Global active AI jobs | 1 |
| Guest allowance | 1 successful Transform per guest-cookie identity, lifetime |
| Verified account allowance | 3 successful AI jobs per UTC month |
| Provider calls | At most 4 per job; no automatic provider retries |
| Provider input/output | 60,000 UTF-8 bytes per serialized request; 12,000 output tokens per call |
| Provider call deadline | 60 seconds |
| Route work deadline | Up to 240 seconds from route entry, including auth and reservation time |
| HTTP AI input | 60,000 UTF-8 bytes; resume 30,000 characters; JD 50–20,000 characters |
| Follow-up instruction | 2,000 characters |
| PDF parsing | 1 PDF, at most 2 MiB, 1–20 pages, 30,000 extracted characters |
| PDF processing | Credential-free worker; 10-second deadline; one worker per process; 128 MiB old-generation heap |
| PDF worker | 10-second deadline; at most 1 worker per server process |
| PDF upload attempts | 100 globally/day; 10 per IP/day; 10 per guest/day |
| Recovery result cache | 220,000 serialized UTF-8 bytes per job; 10 MiB globally |
| Recovery window | Up to 7 days, with earlier eviction when the cache is full |

PDF workers receive no environment credentials. Their V8 heap limits are
128 MiB old generation, 16 MiB young generation and 4 MiB stack. Process RSS
checks at 50 ms intervals stop parsing above 512 MiB total or 192 MiB growth.
RSS checks are best-effort pressure protection, not an OS sandbox or a hard
memory ceiling; native allocations can grow between samples.

Database transactions enforce shared allowances across workers before inference
starts. Failures preserve the success allowance but count against attempts and
spending. Verified provider usage settles the reservation; an uncertain sent
call receives a conservative cost estimate, and unknown job cost retains the
full reservation. A cost overrun is recorded rather than hidden. Spending and
attempts belong to the UTC reservation month; successful account jobs belong
to the UTC completion month. A successful draft still consumes its allowance
if saving it to the application library fails.

PDF workers are terminated on timeout or disconnect. A 50 ms RSS monitor stops
processing above 512 MiB total process memory or 192 MiB growth; this is best
effort pressure protection, not an OS memory ceiling. Build the native canvas
dependency on Vercel/Linux; do not deploy a macOS prebuilt server bundle.

The guest cookie is signed, HttpOnly, SameSite=Lax and Secure in production. It
identifies a browser history, **not one human**. Clearing cookies, incognito
mode, another browser or cookie expiry can create a new guest identity. IP
limits and global budgets bound that exposure; shared campus IPs can also share
a limit. Keep `LANDWISE_SESSION_SECRET` stable across deployments. Changing it
invalidates cookies and changes the quota identity hashes.

Request UUIDs are tied to the verified actor, operation and input hash. Repeating
the same request retrieves its completed cached result or reports its existing
state; it never starts another AI job. Reusing the UUID with different input is
rejected. Expired cached results are unavailable immediately but are deleted
only on a later status, reserve or successful complete operation. With no later
activity, expired rows can persist beyond seven days. Ledger and entitlement
records remain after cache eviction or application deletion.

## Applied application storage limits

Selected Supabase organization: **Personal / Free**. Project:
`supabase-amber-pebble` (`audfewrmqgsefeutappd`),
https://audfewrmqgsefeutappd.supabase.co.

| Limit | Enforced value |
| --- | --- |
| Applications per user | 50 |
| Versions per application | 10 |
| Serialized saved payload per user | 5 MiB |
| Serialized saved payload across all users | 100 MiB |
| History events per application | 100 |
| Notes per application | 12,000 characters |
| Practice tasks per application | 100; title at most 1,000 characters |
| Saved resume page target | 1–20 pages |

Database triggers enforce these caps for direct application RPC calls too.
Existing data is preserved, growth beyond a cap is rejected atomically, and
deletions or reductions reclaim space. Versions and history are not silently
discarded. Known errors return `409/storage_limit`. These are logical serialized
payload budgets, not PostgreSQL physical disk usage; indexes and other database
overhead are additional. The private AI recovery cache has its own 10 MiB cap.

The following migrations were applied through the SQL Editor, not CLI migration
history entries:

- `202610160001_landwise_foundation.sql`, SHA-256 `faf3a00d274d7343f382e0ce3cc96acbabd99840db07b8c56bbc7638aade0a9b`.
- `202610170001_landwise_storage_limits.sql`, SHA-256 `1e59e5ea6ca302335b9ab751e8ee62f6601d1e23de35715101110d6ccbd25634`.
- `202610170002_landwise_ai_budget.sql`, SHA-256 `8cc558ac4b008579daeb1e1a9458fcff402e7f2a9c67708a173f27ded9665c70`.

Verification immediately after migration002 found four quota triggers, zero
saved applications and zero saved payload bytes. No resumes were uploaded in
those checks. Anonymous application-list and legacy trial-reservation probes
returned HTTP 401 / PostgreSQL 42501. After migration003, live verification
found seven protected ledger tables, five server RPCs, zero browser-callable
RPCs, all five callable by the service role and zero AI jobs. No resumes or AI
jobs were created by the migration checks. The project remains on Free.

## Activation procedure

1. Establish and verify a **US$5 provider-side spending stop** for this pilot,
   leaving US$1 beyond the application's US$4 monthly gate. An alert-only budget
   is not a hard stop. Disable automatic top-ups/reloads. If an enforceable stop
   cannot be verified, keep AI disabled; this repository alone does not prove a
   provider billing ceiling. Recheck model prices and reservation math before
   activation or any model change.
2. All three migrations are already applied. Preserve their recorded hashes
   and role restrictions; do not rerun them. Run a separate-session contention
   check against staging before activation. Permission/count verification does
   not replace that check.
3. Configure server-only environment variables from [.env.example](../.env.example):
   `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `LANDWISE_SESSION_SECRET`, exact
   `LANDWISE_APP_ORIGIN`, `SUPABASE_URL` and the separate
   `SUPABASE_PUBLISHABLE_KEY`. Never prefix secrets with `VITE_`, commit them,
   return them from API routes or put them in browser code. Local account
   credentials are not required or permitted in the hosted runtime.
4. Keep both feature flags false for the initial configuration check. Build and
   inspect the hosted artifact, deploy it with AI unavailable, then verify
   origin/CSRF enforcement, guest identity, key isolation and database access.
   Enable `LANDWISE_HOSTED_AI_ENABLED=true` only after spending controls and
   one bounded end-to-end provider test are verified.
5. Keep `LANDWISE_ACCOUNT_SIGN_IN_ENABLED=false` until custom SMTP or a supported
   Google OAuth sign-in flow, exact production redirects and real sign-in have
   been configured and tested. Google OAuth is an alternative configuration
   task, not a claim that a Google button is already implemented. Then test two
   accounts for ownership isolation before exposing account sign-in. Guest AI
   can be enabled separately once its own activation checks pass.

There are no automatic credit purchases, billing fallbacks or retries. Vercel
and Supabase quotas can still limit availability. Review current provider plans
before commercial use or increasing limits.

## Interrupted-job reconciliation

Reservations **never expire automatically**. A crashed worker, lost reservation
response or unavailable settlement RPC can leave the global slot reserved and
block new AI work. A timeout alone does not prove remote work has stopped.
Disable admission while investigating and follow the manual
[reconciliation procedure](./SUPABASE.md#reconciling-an-interrupted-ai-job).
Never delete a job, reset entitlement counters or release a reservation while
the original job may still be running. The pilot requires operator monitoring;
there is no configured alert delivery service.

## Validation and deployment commands

Local automated coverage includes PostgreSQL-engine limits/permissions,
idempotency, costs, guest identity, API requests, provider failure handling and
UI states. Provider calls in these tests are mocked; they do not verify live
credentials, billing enforcement, email delivery or multi-session scheduling.

Latest local validation: 345 tests passed, lint passed, all three application
builds passed, Vercel production build passed, and dependency audit reported
zero vulnerabilities. Browser QA used simulated AI responses: one-page output,
fit report, guest entitlement exhaustion, disabled unconfigured sign-in, and a
390px viewport with no horizontal overflow. No paid provider request was made.
Live anonymous probes of all five budget/upload RPCs returned 401 / 42501.

```sh
npm run lint
npm test
npm run build
npm run build:public
npm run build:hosted
npm audit
```

An inspected production artifact can be prepared with
`vercel build --prod --scope personal-93a7`. Deploy from source on Vercel/Linux
through a linked Git push or `vercel --prod --scope personal-93a7`; do not upload
a macOS prebuilt native parser bundle. Linked Git pushes use
the current `vercel.json`; changing that file can change what the next push
deploys. The earlier preview's 404 API checks are historical evidence only,
not validation of the new hosted endpoints.

Keep `.env*` (except the example), `.vercel`, build output and local account files
out of Git. Never upload `~/.config/landwise/chatgpt.json`.

References: [Vercel Hobby](https://vercel.com/docs/plans/hobby),
[Supabase cost control](https://supabase.com/docs/guides/platform/cost-control),
[Supabase setup and recovery](./SUPABASE.md).
