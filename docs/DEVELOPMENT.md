# Developer guide

This guide is for people who run or change Landwise. The [README](../README.md)
describes the product.

Status reviewed October 19, 2026: guest AI tailoring is live. Public account
sign-in and account libraries are not yet enabled; email delivery still needs
setup and testing.

## Where to look

| You want to… | Read |
| --- | --- |
| Protect API keys and prepare the repository for public release | [Security guide](../SECURITY.md) |
| Maintain the live site, control costs, or recover from an outage | [Operations guide](OPERATIONS.md) |
| Check production settings, limits, and deployment status | [Deployment reference](DEPLOYMENT.md) |
| Run the local ChatGPT-connected studio | [Local development](LOCAL_DEVELOPMENT.md) |
| Understand ownership, migrations, and interrupted AI jobs | [Supabase guide](SUPABASE.md) |
| Change the pipeline or UI | [Architecture](../ARCHITECTURE.md) and [quality rules](../QUALITY.md) |

## Hosting and costs

| Service | Role |
| --- | --- |
| Vercel | React frontend and the hosted Express API in a Node.js function |
| Supabase | PostgreSQL spending/allowance ledger; account authentication and private application storage when enabled |
| OpenAI API | Server-funded generation using the fixed `gpt-6-luna` adapter |
| GitHub | Source and production deployments from `main` |

Visitors are not charged by Landwise. **Operating AI is not free for the owner.**
The application currently gates new work at US$4 per UTC month, 10 global
attempts/day, 100/month, 3/IP/day, and one active job globally. Each job reserves
US$0.06 before making provider calls. A guest gets one successful Transform per
signed browser-cookie identity, not per proven human. Clearing cookies or using
another browser can create another identity; the shared limits still apply.

Operators must separately verify a provider spending stop and keep auto-reload
OFF. The application gate does not configure the provider's billing settings.
Keep the app's lower gate and review both usage records. Failed calls
may cost money. Hard-limit enforcement can slightly overshoot while it
propagates. [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)

Free hosting tiers do not promise uninterrupted availability. Read the
[operating limits and outstanding work](OPERATIONS.md#before-a-wider-launch)
before promoting the site more widely.

## Development and validation

Use Node **24.x** (the production runtime and `.nvmrc` recommendation).
The package also supports Node 22.12+; dependencies are locked in
`package-lock.json`.

```sh
npm ci
npm run security:setup
npm run dev
```

Local studio: **http://127.0.0.1:5174**, API: **127.0.0.1:3001**.
This command starts the loopback ChatGPT integration, **not** the Vercel hosted
API. Keep the exact `127.0.0.1` host for OAuth. No API key is needed for that
local workflow. See [local setup and credentials](LOCAL_DEVELOPMENT.md).

| Command | Purpose |
| --- | --- |
| `npm run check` | Secret scan, lint, all automated tests, hosted artifact checks, and local build |
| `npm run security:setup` | Install commit/push secret guards in this clone |
| `npm run security:history` | Scan all locally available Git history for secrets |
| `npm run verify:hosted` | The checks Vercel must pass before a new production deployment |
| `npm run build:hosted` | Hosted browser bundle in `dist-hosted`; checks for private credential references |
| `npm run build` | Local studio browser bundle in `dist` |
| `npm run preview:hosted` | Static hosted-bundle preview only; no API or server secrets |
| `npm run check:live` | Hosted health, session/ledger, and public storage configuration checks; no AI generation |
| `npm run clean` | Remove generated builds and Vercel build caches; preserve configuration, credentials, dependencies, and saved applications |

Automated tests use mocked provider calls and a local PGlite PostgreSQL engine;
they do not spend OpenAI credits. They do not prove live email delivery,
provider billing controls, or all concurrent production schedules. A real AI
smoke test spends allowance/credit and should be deliberate, not a health probe.

## Project structure

```text
api/index.js                    Vercel entrypoint; imports only the hosted server
server.js                       Loopback-only local entrypoint
server/
  hosted-app.js                 Hosted routes, admission, save and settlement
  hosted-security.js            Guest cookies, CSRF, origin and verified user identity
  hosted-budget.js              Service-only Supabase ledger RPC adapter
  openai-inference.js           Fixed hosted model, call/time/cost bounds
  ai-rate-limit.js              Provider rate-limit errors and retry delays
  request-deadline.js           Whole-operation deadlines, including streamed bodies
  hosted-pdf*.js                Isolated hosted PDF parsing worker
  chatgpt-*.js                  Local-only ChatGPT authorization and inference
  transform.js, revise.js       Shared tailoring and follow-up pipelines
  transform-progress.js         Stage progress events; logs metadata only
  resume-*.js, tailoring-report.js, rag.js, schemas.js, prompts.js
                                Evidence, limited edits, retrieval and validation
  application-store.js          Local files
  cloud-storage.js, supabase-applications.js
                                Verified per-user cloud libraries
src/
  App.jsx, use*.js              Workspace state and connection hooks
  components/                   UI components and colocated styles
  index.css, App.css            Shared typography tokens and workspace layout
  resume*.js                    Preview structure and PDF/DOCX pagination/export
  hostedAccess.js, cloudAccount.js, applicationApi.js
                                Hosted access rules, account config and library requests
  careerEvents.js, careerLocation.js
                                Event filtering, distance sorting and in-memory location
  data/careerEvents.js          Curated source-linked event directory
supabase/migrations/            Immutable, already-applied database history
scripts/                        Security, build, cleanup and live-check commands
.githooks/                      Local commit and push guards (enable with security:setup)
tests/                          Synthetic fixtures and automated regression tests
docs/                           Deployment, operations, local setup and database guides
docs/images/                    README screenshots (invented demo data only)
```

Keep provider-specific code in its adapter, enforce quotas on the server/database,
and share evidence/layout logic rather than duplicating it in new routes. UI
font sizes live in `src/index.css`; component styles should use those tokens.
Resume export typography is separate from the interface type scale.

## Maintaining career events

Edit `src/data/careerEvents.js`. Check the original organizer's date, location,
registration and eligibility before updating `verifiedOn`. Use `kind: 'event'`
for confirmed dates and `kind: 'calendar'` for ongoing organizer calendars.
Expired dated events stop appearing after their final day in the visitor's local
date. Listings are not fetched automatically; review them regularly.

## README screenshots

The images in `docs/images/` were captured with a local harness (not in this
repository) that served the hosted interface with a scripted model and an
in-memory budget, so no provider call, allowance or database was used. The
resume, school, employer and job are invented, and the email uses the reserved
`example.com` domain. If you retake them, use invented data and a setup with no
production credentials. Never capture the live site, a real resume or account
data for the README.

## Repository hygiene

Generated outputs, `.vercel`, `.env*` except `.env.example`, and
`node_modules` stay out of Git. Do not put resume samples, logs containing
personal data, database backups, or account credentials in the repository.

`npm run security:setup` turns on two local Git hooks. Before each commit, the
staged files are scanned with a pinned Gitleaks release, and private files are
refused: `.env*`, credential and key files, PDF/DOCX, database files (`.db`,
`.sqlite`, `.dump`, `.bak`), and anything under folders such as `private/`,
`backups/` or `uploads/`. Plain `.sql` files are not refused, so keep SQL dumps
out of the repository. Before each push, all local Git history is scanned the
same way. Findings show only file, line and rule, never the value.
Hooks can be bypassed with `--no-verify`, so they support review rather than
replace it. See [SECURITY.md](../SECURITY.md) for history audits and the
controls to enable before changing repository visibility.
Keep migrations even when they contain legacy trial groundwork: they are
applied database history, not disposable files.

Landwise is released under the [MIT License](../LICENSE). Keep that file and
its copyright notice in place.
