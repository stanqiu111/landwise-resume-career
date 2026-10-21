# Deployment reference

Reviewed October 20, 2026. For routine checks, outages, backups and rollback,
use [OPERATIONS.md](OPERATIONS.md).

## Current service

| Setting | Current value |
| --- | --- |
| Public URL | https://landwise-resume.vercel.app |
| Vercel project | `landwise`, Hobby |
| Source / production branch | `stanqiu111/landwise-resume-career` / `main` |
| Node runtime | 24.x |
| Install | `npm ci` |
| Production build | `npm run verify:hosted` |
| Static output | `dist-hosted` |
| API entrypoint | `api/index.js`; `/api/:path*` rewrite in `vercel.json` |
| Function duration | Configured maximum 300 seconds |
| Supabase | Free PostgreSQL project; configured through server environment variables |
| Guest AI | Enabled; fixed API-funded `gpt-6-luna` |
| Account onboarding | Disabled; public email delivery not verified |

`vercel.json` is the source-controlled deployment configuration. Vercel must pass
the source secret scan, lint, all tests and the hosted credential-reference scan
before replacing the live alias. The former static coming-soon build has been removed. `npm run dev`
remains the separate local ChatGPT studio; never deploy `server.js` publicly.

## Environment variables

Store private values as Vercel Production Secrets, not frontend variables.
New values/flags take effect only after redeployment. `.env.example` is a safe
local/new-install template and intentionally defaults hosted feature flags off;
it does not describe the live values.

| Variable | Hosted purpose |
| --- | --- |
| `LANDWISE_APP_ORIGIN` | Exact HTTPS origin, currently `https://landwise-resume.vercel.app`, no trailing slash |
| `LANDWISE_HOSTED_AI_ENABLED` | Live value `true`; turn off and redeploy to stop new AI admission |
| `LANDWISE_ACCOUNT_SIGN_IN_ENABLED` | Live value `false`; enable only after auth delivery and two-user isolation checks |
| `LANDWISE_SESSION_SECRET` | Stable random server-only secret, at least 32 bytes |
| `SUPABASE_URL` | Your project URL, `https://<project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Browser-safe project key; never a secret/service-role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only ledger credential; canonical name for new setups |
| `Supabase_Key` | Existing production secret's exact-case compatibility alias, used only when the canonical variable is absent |
| `OPENAI_API_KEY` | Dedicated server-funded project key |

A supplied canonical service-role variable always wins, even if empty/invalid.
Do not set both without understanding that precedence. No `VITE_*` variable may
contain a secret. The hosted server never needs local ChatGPT account files.
The public storage-config response intentionally includes the publishable key.

The hosted service uses operator-funded API credits. Verify a provider spending
stop and disable auto-reload in the provider dashboard; those settings are not
configured by this repository. The app separately gates admission at US$10/month;
keep the provider spending stop at least US$1 higher (US$11 or more).
Keep these distinct; failed requests can still incur cost and provider enforcement is not instantaneous.
[Spend-limit behavior](https://developers.openai.com/api/docs/guides/spend-limits)

## Hosted limits

| Limit | Value |
| --- | --- |
| Monthly application AI budget | US$10 per UTC month, including active reservations |
| Reservation/job | US$0.06 (60,000 microUSD) |
| Global attempts | 300 per UTC day; 3,000 per UTC month |
| Attempts/trusted IP hash | 60 per UTC day (shared campus and dorm networks) |
| Global active jobs | 1 |
| Guest allowance | 15 successful Transforms per cookie identity, for life; then the app links to the local version |
| Verified-account allowance | 3 successful AI actions per UTC month, across Transform/Analyze/revise |
| Provider calls | At most 4/job; no automatic retries |
| Provider request/output | 60,000 UTF-8 bytes serialized input; 12,000 output tokens/call |
| Provider deadline | 60 seconds/call |
| Route work deadline | Up to 240 seconds from entry, including auth/reservation time |
| HTTP AI payload | 60,000 UTF-8 bytes; resume up to 30,000 chars; JD 50–20,000 chars |
| Follow-up instruction | Up to 2,000 chars |
| Hosted PDF | One file up to 2 MiB, 1–20 pages, up to 30,000 extracted chars |
| PDF upload admission | 300/day globally; 60/IP/day; 15/guest/day |
| PDF worker | Credential-free; 10-second deadline; one worker/process |
| Recovery cache | 220,000 serialized UTF-8 bytes/job; 10 MiB total; up to 7 days, earlier eviction when full |

The PDF worker has 128 MiB old-generation heap, 16 MiB young generation and
4 MiB stack limits. RSS is sampled every 50 ms and stops processing above
512 MiB total or 192 MiB growth. This is best-effort pressure protection, not an
OS sandbox/hard memory ceiling. Native allocations can grow between samples.

Shared limits are database-enforced across workers. Failure preserves success
allowance but retains attempts and known/conservative cost. Cost/attempts use
the UTC reservation month; successful account allowance uses the UTC completion
month. Successful generation still counts if a library save or browser delivery
fails. Changing a cookie, origin or session secret can change guest identity;
this is not verified per-person enforcement.

A request UUID binds actor, operation and input. Replays never start new
inference. Cached results may expire/be evicted, and browser retry IDs are not
persisted across refresh. Expired cache rows are physically removed on later
ledger activity, not by a scheduled erasure job. Cost/entitlement history remains.
Reserved jobs never automatically expire; see the [manual recovery procedure](SUPABASE.md#reconciling-an-interrupted-ai-job).

## Application storage caps

| Limit | Value |
| --- | --- |
| Applications/user | 50 |
| Versions/application | 10 |
| Serialized payload/user | 5 MiB |
| Serialized payload/all users | 100 MiB |
| History events/application | 100 |
| Notes/application | 12,000 characters |
| Practice tasks/application | 100; 1,000-character titles |
| Saved page target | 1–20 pages |

Triggers also enforce limits for direct RPC writes. Growth beyond a cap is
rejected; old versions/history are not silently discarded. Deletion/reduction
reclaims payload quota. These are serialized-data caps, not physical disk
limits; indexes, auth and ledger tables use additional space. The private
recovery cache is separate from application payload accounting.

## Applied migrations

These files were applied through the SQL Editor, not recorded in CLI migration
history. Do not rerun them or use `supabase db push` until that history is
reconciled. Add new migrations for changes, including removal of legacy trial
functions. Keep the existing files unchanged.

| File | Applied SHA-256 |
| --- | --- |
| `202610160001_landwise_foundation.sql` | `faf3a00d274d7343f382e0ce3cc96acbabd99840db07b8c56bbc7638aade0a9b` |
| `202610170001_landwise_storage_limits.sql` | `1e59e5ea6ca302335b9ab751e8ee62f6601d1e23de35715101110d6ccbd25634` |
| `202610170002_landwise_ai_budget.sql` | `8cc558ac4b008579daeb1e1a9458fcff402e7f2a9c67708a173f27ded9665c70` |
| `202610200001_landwise_guest_trials.sql` | `b0b03de0a9fe9968e7d18474116e21d7df7d544757b29bd7288fc2025ba1f71a` |

Application CRUD uses a verified user's token, never the service-role credential.
The seven private AI/upload ledger tables and five server-only RPCs are not
browser-accessible. [Database permissions and setup](SUPABASE.md)

## Activation procedure

For a new project, major billing change or reactivation after an incident:

1. Verify the dedicated provider spending stop, auto-reload OFF, model pricing
   and reservation math. An alert-only budget is insufficient. Keep public AI
   disabled until those controls are established.
2. Verify migrations, service-role access, browser denial and identity/CSRF
   checks. Production concurrency needs real concurrent RPC verification if
   admission logic changes; single-connection PGlite tests do not replace it.
3. Create a Vercel-protected, unpromoted staged deployment from source on Linux,
   initially with AI disabled. Configure its exact origin appropriately.
4. Enable AI only on that protected stage for a deliberately bounded synthetic
   end-to-end request. Check output, failed-job settlement, replay without a
   second model call, guest allowance and remaining budget. Paid tests consume
   attempts and credit; do not reset counters to hide them.
5. Promote only after checks pass. Recheck the public URL and exact production
   origin. Keep account sign-in disabled until SMTP/redirects, real sign-in,
   and two-account ownership isolation pass separately.

## Verification history and limits of evidence

October 19 activation: 359 automated tests passed. A real synthetic one-page
Transform completed in approximately 27 seconds, preserving both experiences
and their purposes, with one targeted edit and an 88 evidence-match estimate.
Unsupported Kubernetes experience stayed in the learning report. Committed
ledger cost was US$0.001754; exact replay returned the same result/cost without
new inference. Changed-input reuse returned 409; a new request from the used
guest returned 429. An earlier failed request preserved the guest allowance
and settled conservatively at US$0.014150. These are ledger amounts, not a
billing-dashboard reconciliation or a cost-per-resume guarantee.

A protected temporary concurrency harness admitted one of two competing jobs,
rejected the other as busy, and settled its test reservations at known zero
provider cost. It was removed; test attempts remained counted. This is evidence
for the tested race, not every possible database schedule.

October 20 guest-trial rollout: 375 automated tests passed, including an
upgrade test that applies the migration twice to a ledger holding existing
jobs and allowances, then rolls it back. The server that accepts 15 remaining
was deployed first and returned `"limit":15`; the migration was then applied in
the SQL Editor. The [SUPABASE.md](SUPABASE.md) verification query returned the
expected values for all three functions, and `npm run check:live` reported 15
remaining for a new guest. No AI request was made for these checks.

October 19 typography verification checked 24 UI states across 320, 390, 768
and 1440px widths using mocked AI results, with no overflow/runtime errors.
Live desktop/mobile typography and API health were also verified. The build
still reports a large frontend chunk; code splitting is a future performance
improvement, not a build failure.

`npm run check:live` does not call OpenAI or test email. Live credentials,
provider billing settings, email delivery and backup restoration require
separate checks. See [operations](OPERATIONS.md) for outstanding work.
