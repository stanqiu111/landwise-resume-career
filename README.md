# Landwise

**Your resume. A better fit.**

Landwise helps students tailor a resume using their real experience, understand
job requirements, and find career events in Canada and the United States.

**Live site: https://landwise-nu.vercel.app**

Status reviewed October 19, 2026: guest AI tailoring is live. Public account
sign-in and account libraries are not yet enabled; email delivery still needs
setup and testing.

## Start here

| You want to… | Read |
| --- | --- |
| Maintain the live site, control costs, or recover from an outage | [Operations guide](docs/OPERATIONS.md) |
| Check production settings, limits, and deployment status | [Deployment reference](docs/DEPLOYMENT.md) |
| Run the local ChatGPT-connected studio | [Local development](docs/LOCAL_DEVELOPMENT.md) |
| Understand ownership, migrations, and interrupted AI jobs | [Supabase guide](docs/SUPABASE.md) |
| Change the pipeline or UI | [Architecture](ARCHITECTURE.md) and [quality rules](QUALITY.md) |

## What works today

- **A free first tailoring without signup.** Upload a PDF or paste a resume and
  job description. The server pays for OpenAI API usage; the public site does
  not use your personal ChatGPT subscription or ask visitors for API keys.
- **Small, evidence-based edits.** Preserve roles, projects, dates, purposes,
  and source metrics. Edit at most 35% of existing bullets, rounded up with a
  minimum allowance of one. Unsupported experience is not added as fact.
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

The owner confirmed a separate OpenAI US$5 monthly hard limit and auto-reload
OFF on October 19; those dashboard settings have not been independently
verified. Keep the app's lower gate and review both usage records. Failed calls
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
npm run dev
```

Local studio: **http://127.0.0.1:5174**, API: **127.0.0.1:3001**.
This command starts the loopback ChatGPT integration, **not** the Vercel hosted
API. Keep the exact `127.0.0.1` host for OAuth. No API key is needed for that
local workflow. See [local setup and credentials](docs/LOCAL_DEVELOPMENT.md).

| Command | Purpose |
| --- | --- |
| `npm run check` | Lint, all automated tests, hosted artifact checks, and local build |
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
api/index.js                   Vercel entrypoint; imports only the hosted server
server.js                      Loopback-only local entrypoint
server/
  hosted-app.js                Hosted routes, admission, save and settlement
  hosted-security.js          Guest cookies, CSRF, origin and verified user identity
  hosted-budget.js            Service-only Supabase ledger RPC adapter
  openai-inference.js         Fixed hosted model, call/time/cost bounds
  hosted-pdf*.js              Isolated hosted PDF parsing worker
  chatgpt-*.js                Local-only ChatGPT authorization and inference
  transform.js, revise.js     Shared tailoring and follow-up pipelines
  resume-*.js, tailoring-report.js, rag.js, schemas.js, prompts.js
                              Evidence, limited edits, retrieval and validation
  application-store.js        Local files
  cloud-storage.js, supabase-applications.js
                              Verified per-user cloud libraries
src/
  App.jsx, use*.js             Workspace state and connection hooks
  components/                 UI components and colocated styles
  index.css, App.css          Shared typography tokens and workspace layout
  resume*.js                 Preview structure and PDF/DOCX pagination/export
  data/careerEvents.js        Curated source-linked event directory
supabase/migrations/           Immutable, already-applied database history
scripts/                      Build, cleanup and live-check commands
tests/                       Synthetic fixtures and automated regression tests
docs/                         Deployment, operations, local setup and database guides
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

The unused coming-soon preview was retired; there are now only hosted and local
builds. Generated outputs, `.vercel`, `.env*` except `.env.example`, and
`node_modules` stay out of Git. Do not put resume samples, logs containing
personal data, database backups, or account credentials in the repository.
Keep migrations even when they contain legacy trial groundwork: they are
applied database history, not disposable files.

This checkout has no `LICENSE` file. Choose and add a license before distributing
it as an open-source project; the old README's standalone MIT label did not
include license terms.
