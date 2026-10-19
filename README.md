# Landwise

**Your resume. A better fit.**

Landwise is an **AI resume tailoring and job-search app for students**. Improve
your resume for a job using your real experience, understand skill gaps with a
fit report, and find career fairs and job opportunities in Canada and the
United States.

[![Hosted on Vercel](https://img.shields.io/badge/Hosted%20on-Vercel-000000?logo=vercel&logoColor=white)](https://landwise-nu.vercel.app) **Live site: https://landwise-nu.vercel.app**

Status reviewed October 19, 2026: guest AI tailoring is live. Public account
sign-in and account libraries are not yet enabled; email delivery still needs
setup and testing.

## Why Landwise

- **The AI edits bullets; it can't rewrite your resume.** The model returns
  edits to existing bullet lines, and server code applies them to your original
  text. Lines without a bullet marker, such as your name, contact details,
  headings, and role and date lines, are copied unchanged, and no line is
  added, removed or reordered. At most 35% of bullets change per run (rounded
  up, minimum one). A draft that breaks any rule is rejected whole, never
  partly applied.
- **Evidence comes from your own words.** A fact counts as evidence only if its
  quote is found in your original resume. Anything else, including wording
  that appears only in the job description, is discarded in code, and
  requirements with no verified evidence are listed as gaps to work on.
- **Your numbers stay yours.** Each edited bullet must keep the same numbers it
  started with, and a draft containing any number that isn't in your original
  resume is rejected.
- **The page count is real.** The app and the PDF download use the same layout
  code, so the page count you see is the PDF's page count. Text never goes
  below 10.5 pt: a draft that can't fit your page limit gets an error, not
  smaller text or cut lines. Word files can reflow after you edit them.
- **A score rewording can't inflate.** The match score is calculated by code
  from verified evidence, not written by the model, so rewording bullets can't
  raise it. The report calls it an estimate, not an ATS score.
- **Free to try, nothing to set up.** On the live site, your first tailoring
  needs no account, email or API key, and a failed or cancelled run doesn't use
  it up. PDF and DOCX files are built in your browser, with no watermark.

These checks compare text, not meaning. A short quote can match inside a longer
word ("Java" inside "JavaScript"), and only digits are locked, not their units
("$1.5M" changed to "$1.5B" would pass). Read every draft before you send it.

## Start here

| You want to… | Read |
| --- | --- |
| Protect API keys and prepare the repository for public release | [Security guide](SECURITY.md) |
| Maintain the live site, control costs, or recover from an outage | [Operations guide](docs/OPERATIONS.md) |
| Check production settings, limits, and deployment status | [Deployment reference](docs/DEPLOYMENT.md) |
| Run the local ChatGPT-connected studio | [Local development](docs/LOCAL_DEVELOPMENT.md) |
| Understand ownership, migrations, and interrupted AI jobs | [Supabase guide](docs/SUPABASE.md) |
| Change the pipeline or UI | [Architecture](ARCHITECTURE.md) and [quality rules](QUALITY.md) |

## What works today

- **A free first tailoring without signup.** Upload a PDF or paste a resume and
  job description. The server pays for OpenAI API usage; the public site does
  not use your personal ChatGPT subscription or ask visitors for API keys.
- **A match estimate and fit report.** Separate evidence already in the resume,
  related experience to expand, and requirements to learn or substantiate.
  This is not an ATS score or a hiring prediction.
- **Length-aware PDF and DOCX downloads.** Uploaded PDF pages set the initial
  limit; pasted text uses an estimate the user can adjust. Oversized output is
  rejected instead of silently truncated. PDF has fixed pagination; Word can
  reflow after edits or font substitution.
- **Visible progress and failure handling.** Read, Match, Build, and Check follow
  server stages. Inputs and the previous draft stay in the current tab after
  errors. A confirmed generation failure preserves the success allowance, but
  attempts and any incurred provider cost still count.
- **Career-event discovery.** Curated organizer links, eligibility, dates,
  filters, and optional browser location sorting. Saved event IDs stay in
  browser local storage. Rounded location stays in memory and is not sent to
  the server or a geocoding service.

The code also supports signed-in resume analysis, follow-up revisions, and
private application libraries with versions, notes, and interview/practice
tracking. **These require a Landwise account on the hosted site and are not
publicly available while account sign-in is disabled.** The local studio has
its own working account/storage flow; see the local guide.

Download guest drafts before closing or refreshing the tab. Unsaved inputs,
results, and retry IDs are held in memory. A bounded server recovery cache is
not a user-accessible application library or a backup.

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
[operating limits and outstanding work](docs/OPERATIONS.md#before-a-wider-launch)
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
local workflow. See [local setup and credentials](docs/LOCAL_DEVELOPMENT.md).

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
replace it. See [SECURITY.md](SECURITY.md) for history audits and the controls
to enable before changing repository visibility.
Keep migrations even when they contain legacy trial groundwork: they are
applied database history, not disposable files.

There is no `LICENSE` file yet. Without one, a public repository can be viewed
but not reused; add a license before distributing it as open source.
