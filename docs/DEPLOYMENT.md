# Deployment status

Updated October 19, 2026.

## Live site and activation status

Current URL: **https://landwise-nu.vercel.app**. Vercel project
`personal-93a7/landwise` is on Hobby, connected to `stanqiu111/landwise`, production
branch `main`.

**Guest resume tailoring is live. Public account sign-in remains disabled.**
On October 19, protected staged deployment
`dpl_FZPywr9biHpuHJvBLdpKk9ALRaEQ` passed a real synthetic Transform and its
replay/allowance checks, then was promoted to the public domain. The production
AI flag is true; the account sign-in flag stays false. Subsequent Git deployments
inherit these flags.

| Item | Verified state |
| --- | --- |
| Hosted studio and career events | Deployed at the URL above |
| Hosted API and guest identity | Guest AI enabled; live configuration and secure cookie verified |
| Shared spending ledger | Live reservation contention, settlement, replay and allowance checks pass |
| Foundation and application storage-limit migrations | Applied to the selected Supabase project |
| AI budget migration, `202610170002_landwise_ai_budget.sql` (migration003) | Applied remotely; permissions/counts verified |
| Hosted OpenAI API key | Production Secret `OPENAI_API_KEY`; three-call live Transform succeeded |
| Hosted Supabase service-role key | Saved as Production Secret `Supabase_Key`; protected runtime budget-status RPC succeeded |
| Provider-side US$5 spending stop | Owner confirmed hard limit enabled and auto-reload OFF on October 19; no independent dashboard verification |
| Public account email delivery | Custom SMTP was OFF at the October 17 check; delivery is not verified |
| Public account sign-in | Keep `LANDWISE_ACCOUNT_SIGN_IN_ENABLED=false` |

The new source configuration builds `npm run build:hosted` into `dist-hosted`
and rewrites `/api/:path*` to the `api/index.js` entrypoint, with a 300-second
Vercel function limit. `npm run build:public` still produces the separate static preview.
`npm run dev` and `npm run build` retain the local studio. Local ChatGPT account
files and account-picker routes are excluded from the hosted runtime.

Both private credentials remain in Vercel as Production Secrets. `Supabase_Key`
uses the server-only compatibility alias described below; values were never
downloaded or printed. Provider pricing was rechecked against official OpenAI
documentation on October 19. Dashboard access was unavailable, so the provider
hard-limit and auto-reload settings are owner-confirmed rather than independently
observed. Application limits below are enforced independently in PostgreSQL.

The first live test completed extraction but its matching request was rejected.
Its failed reservation settled and preserved the guest allowance. Adding the
explicit JSON instruction to actual input messages resolved the matching-style
regression and the second live test. The original provider error detail was not
available, so input-only JSON validation remains the likely, not proven, cause.

The successful synthetic one-page resume finished in 27 seconds, preserved both
experiences and their purposes, made one small bullet edit, and returned an 88
evidence-match score. Unsupported Kubernetes experience stayed out of the resume
and appeared in the learning report. The ledger settled 1,754 microUSD
(US$0.001754); an identical request returned the exact cached result and the same
charge with no processing steps. Changed input with the same ID returned 409;
a new ID for the used guest returned 429. The used guest had zero remaining
trials; a fresh guest was available, confirming the global reservation cleared.
The earlier failed job conservatively settled 14,150 microUSD, including its
uncertain rejected call. These are application ledger amounts, not a billing
dashboard reconciliation.

A temporary protected harness raced two distinct reservation RPCs while holding
the winner: exactly one was admitted and the other returned `hosted_ai_busy`.
Its guard and winner both settled failed at known cost zero, with no provider
calls. Repeating the harness skipped the race. Attempt counters were preserved.
This exercised real concurrent RPC admission, not every possible database
schedule. The temporary deployment was removed and was never published.

Public API checks return JSON with `Cache-Control: no-store`; health is
`configured:true`, fresh guest availability is true, and the cookie is
Secure/HttpOnly. Public configuration includes only the publishable Supabase
settings and `signInEnabled:false`. Owner auth and temporary probe routes are
absent. Browser visual checks were unavailable on October 19; prior October 17
browser QA showed no console errors.

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
   and role restrictions; do not rerun them. The October 19 protected harness
   verified concurrent admission through real RPC requests. Repeat equivalent
   bounded staging checks if changing ledger admission behavior; permission/count
   verification alone does not replace contention testing.
3. Configure server-only environment variables from [.env.example](../.env.example):
   `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `LANDWISE_SESSION_SECRET`, exact
   `LANDWISE_APP_ORIGIN`, `SUPABASE_URL` and the separate
   `SUPABASE_PUBLISHABLE_KEY`. Never prefix secrets with `VITE_`, commit them,
   return them from API routes or put them in browser code. Local account
   credentials are not required or permitted in the hosted runtime.
   For deployment compatibility, the exact-case secret name `Supabase_Key` is
   accepted server-side only when `SUPABASE_SERVICE_ROLE_KEY` is absent. A
   supplied canonical value always takes precedence, including an invalid or
   empty value; the same secret/service-role key validation applies to both.
   Existing write-only secrets under the alias need not be re-entered. Neither
   name is exposed through public configuration or accepted as the publishable key.
4. Keep public AI and account sign-in flags false. Build and inspect the hosted
   artifact, then create a **Vercel-protected, unpromoted staged production
   deployment** with AI disabled. Verify origin/CSRF enforcement, guest identity,
   key isolation and database access. Once the spending controls are verified,
   enable `LANDWISE_HOSTED_AI_ENABLED=true` only on that protected staged
   deployment for a bounded end-to-end provider test. Promote it to the public
   domain only after the controls and test pass. The public deployment's AI
   flag must remain false until that promotion; do not enable public AI merely
   to perform the activation test.
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

October 19 validation: 359 tests passed, lint passed, and the Vercel/Linux hosted
build passed. Live provider, ledger and replay results are recorded above.
October 17 validation also covered all three application builds and an audit
with zero vulnerabilities. That browser QA used simulated AI responses: one-page
output, fit report, exhausted guest trial, unavailable account sign-in, and a
390px viewport with no horizontal overflow. Anonymous probes of all five
budget/upload RPCs returned 401 / 42501.

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
