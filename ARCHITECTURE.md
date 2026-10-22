# Landwise architecture

There are two server entrypoints and one shared React workspace. The retired
static coming-soon preview is no longer a third application mode.

## Runtime boundaries

| Concern | Hosted website | Local studio |
| --- | --- | --- |
| Entry | `api/index.js` → `server/hosted-app.js` | `server.js`, loopback only |
| Frontend | `npm run build:hosted`, `VITE_LANDWISE_HOSTED=true` | Vite dev / `npm run build` |
| AI | `server/openai-inference.js`, server-funded fixed model | `server/chatgpt-inference.js`, selected authorized ChatGPT model |
| Identity | Signed guest cookie or verified Supabase account | Local session + ChatGPT connection; optional Supabase account |
| Allowance/cost | Atomic Supabase private ledger | Local account admission/cooldown and provider plan limits |
| Application data | Supabase owner-scoped RPCs; no local fallback | Local folders by default; optional Supabase library |

`server/hosted-app.js` never imports local ChatGPT credentials or account-picker
routes. Hosted secrets are server-only. `scripts/build-hosted.mjs` scans the
browser artifact for private credential/local auth references before deployment.
`vercel.json` routes `/api/:path*` to the hosted entrypoint. The build flag selects
frontend behavior; it is not a security boundary. Server routes enforce access.

## Hosted request lifecycle

1. `hosted-security.js` checks exact origin, signed guest cookie, CSRF token,
   trusted Vercel IP information, and any supplied Supabase bearer token.
   An invalid account token never becomes an anonymous guest fallback.
2. Validate input before admission. `hosted-budget.js` uses the server-only
   Supabase credential for ledger RPCs. PostgreSQL serializes quota/cost/slot
   admission; the browser cannot supply its own price or identity.
3. Bind request UUID to actor, operation and input hash. A repeated admitted
   request returns cached completion or existing status without fresh inference.
4. Reserve cost and attempts, then run the shared pipeline under a deadline.
   Provider failures do not trigger automatic retries. Each sent call is charged
   conservatively until metered usage is known.
5. If the verified account has a library, attempt to save the result with its
   user token. A save failure adds a warning instead of discarding the draft.
6. Settle cost and success allowance before returning completion. Failures
   settle without consuming success allowance; attempts/cost are retained.
   Independent settlement is attempted even after browser cancellation.

Unknown reservation/settlement state is logged and fails closed. Reserved jobs
do not expire automatically. A crashed worker can block the single global slot
until an operator reconciles it. See [recovery](docs/SUPABASE.md#reconciling-an-interrupted-ai-job).
The limits themselves are documented in [DEPLOYMENT.md](docs/DEPLOYMENT.md);
change the SQL, adapter constants, tests and docs together when changing policy.

## Shared tailoring pipeline

`server/transform.js` normally makes three sequential AI calls:

1. Read the resume/job and extract exact quoted claims plus job requirements.
2. Match requirements against the grounded claim bank. Discard invented IDs or
   unsupported quotations; the job description is never candidate evidence.
3. Request small replacements for existing bullet IDs and coaching for each
   requirement. The full original source and local TF-IDF retrieval provide
   context without a separate embedding service.

`resume-edits.js` applies valid replacements to original lines, preserving all
other structure. At most 35% of recognized bullets, rounded up with a minimum
allowance of one, may change. `screenResumeEdits` checks each replacement on
its own and drops, with a reason code only, any that targets a non-bullet or
repeated line, is empty or multiline, grows more than 8 words, changes a source
number, removes an email or link, adds a key term of an unsupported requirement,
adds a named tool, technology, standard or credential of a requirement with only
related evidence, adds a supported term to a bullet that does not hold that
requirement's evidence, or exceeds the cap; the valid edits still apply. A
replacement identical to its bullet is not counted as an edit. When an edit is
dropped, "Edits made" is written by code from the kept edits. `text-match.js`
compares quotes and terms as whole words with curly quotes and dashes folded, so
"Java" is never found inside "JavaScript". Claims keep any type label, so a fact
the model labels "education" is never dropped. Text without recognized bullet
markers stays unchanged.
`resume-quality.js` checks contact/education retention, numeric claims and other
constraints; these checks do not prove every sentence's semantic truth.

`src/resumeLayout.js` measures the actual wrapped output on Letter pages with
readable 10.5–11 pt body text. If too long, Transform permits one additional
shortening call and checks again; oversized output is rejected, not truncated.
The hosted adapter caps all calls/job at four. PDF uses the same layout;
`resumeDocx.js` applies corresponding wrapping and explicit breaks, but Word can
reflow after edits/font substitution.

`tailoring-report.js` derives the score from valid source evidence: must-have
weight 2, nice-to-have weight 1; direct credit 1, related credit 0.5, absent 0.
Placement quotations must occur in the final draft; an edited evidence bullet is
quoted from the draft line that replaced it (original and draft compared line by
line) only while it still states the quoted fact. Included, expand and learn
groups distinguish documented evidence from a skill the user may need to build.
The score is not an ATS rating or hiring forecast.

## Revisions and analysis

`server/revise.js` re-grounds the original source and current draft, validates
their relationship, and makes one editorial request. Limited replacements must
preserve source structure/facts and the page target. It regenerates the fit
report; no automatic shortening/retry pass follows a revision. A changed result
can save a new version; a no-change result retains the prior saved version.
The draft carries at most ten recent follow-up exchanges.

The UI disables conflicting AI/input actions and preserves the previous result
and typed follow-up on error. Changing studio source inputs requires a new
Transform before refining the old draft. Guest Analyze and follow-up are rejected
by the hosted server, independently of the UI. Authenticated allowance is shared
across Transform, Analyze and revisions.

## Storage and user boundaries

- `application-store.js`: local folders under the OS user's Documents directory,
  atomic rename and serialized mutations, owner-only permissions.
- `cloud-storage.js`: verifies Supabase identity and constructs the correct store.
- `supabase-applications.js`: application RPCs use the verified **end-user token**,
  not the service-role credential. Ownership comes from `auth.uid()`; RLS and
  RPC checks prevent cross-account access. Storage triggers enforce growth caps.
- The private AI ledger uses the **service-role key**, separately from library
  CRUD. Cached results may contain sensitive resume/evidence text.

Applications group versions by the trimmed exact JD hash. Company/role labels
and progress can be edited without changing old version snapshots. Guest drafts
are not automatically placed in a cloud library. Account switches remount the
workspace and cancel work; same-account token refresh preserves the workspace.
Supabase SDK sessions persist in browser storage; ChatGPT tokens stay local to
the loopback server. The account-sign-in feature flag controls public onboarding.

All migrations are applied history, including unused original sponsorship
functions. Keep them immutable; use a new migration for a future removal.
See [SUPABASE.md](docs/SUPABASE.md) for table/RPC permissions and retention.

## Frontend and progress

`App.jsx` coordinates state with `useLandwiseAccount`, `useHostedConnection`,
`useAIConnection` and `useAICooldown`. Components own colocated CSS; shared UI
font tokens live in `index.css` and workspace rules in `App.css`. The resume
preview/export has separate typography so UI tuning does not change PDF layout.

`transform-progress.js` emits real stage events through NDJSON.
`transformResponse.js` assembles and validates a nonempty result; truncated
streams are errors. `TransformActivity` maps stages to Read/Match/Build/Check;
decoration does not advance completion. A light ready sound only runs after
success, subject to browser audio permission.

Uncertain connection failures retain a payload-bound retry ID in memory so an
unchanged request can recover without duplicate inference. Confirmed terminal
failure allows a fresh request, subject to attempt limits. Refresh loses unsaved
state and retry IDs; cached server output alone does not provide a recovery UI.

Hosted provider calls have a 60-second deadline; route work has up to 240 seconds
inside the 300-second Vercel function limit. Local provider calls have a
120-second deadline. Browser fallback is 250 seconds for Transform and
135 seconds for revision. Deadlines are upper bounds, not latency promises.

## PDF isolation and events

Hosted PDF uploads use a credential-free worker with heap/RSS pressure checks,
shared upload admission, and a 10-second deadline. Originals are not stored.
Local parsing has a different loopback-only path. See deployment caps before
changing parser limits; native memory checks are not an OS sandbox.

`src/data/careerEvents.js` is a curated static directory. Filtering, saved IDs,
and approximate city-distance sorting run in the browser. Browser geolocation
is optional; rounded coordinates stay in memory. There is no Maps API key,
external geocoding request or automatic event scraper.

## Maintenance checks

`npm run check` runs lint, mocked-provider/PGlite regression tests and both
builds. Vercel runs the hosted subset on Node 24/Linux before promoting a
deployment. Run the full check locally before pushing; a separate GitHub Actions
workflow is not configured. Tests cover permissions, allowances, replay, failure handling,
source preservation, revisions and pagination. PGlite is single-connection;
production contention, real credentials, billing controls and email delivery
need separate bounded checks. Keep synthetic examples out of real user accounts.
