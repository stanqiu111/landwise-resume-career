# Deployment status

Updated October 17, 2026.

## Public site

Live URL: **https://landwise-nu.vercel.app**. The default Vercel domain can be replaced later.

The Vercel project `personal-93a7/landwise` is on **Hobby** and connected to `stanqiu111/landwise`, production branch `main`. The public deployment is a **static preview**: career events work; resume tailoring is clearly marked coming soon. No signup is required to browse.

`vercel.json` always builds `npm run build:public` into `dist-public`. This build resolves a separate entry point and checks that its output contains no local AI/account routes or Supabase configuration. The local studio remains available through `npm run dev` and `npm run build`.

No server functions, cron jobs, AI credentials, paid add-ons, or paid plan upgrades are deployed. Strict response headers restrict scripts and connections to the site's own origin; unknown API paths return 404. Vercel's free quotas may suspend availability rather than provide unlimited capacity. Hobby is for personal, non-commercial use; review the plan if Landwise becomes commercial. The owner's existing ChatGPT subscription remains a separate cost.

## Applied database limits

Selected Supabase organization: **Personal / Free**. Project: `supabase-amber-pebble` (`audfewrmqgsefeutappd`), https://audfewrmqgsefeutappd.supabase.co.

| Limit | Enforced value |
| --- | --- |
| Applications per user | 50 |
| Versions per application | 10 |
| Serialized saved payload per user | 5 MiB |
| Serialized saved payload across all users | 100 MiB |
| History events per application | 100 |

Database triggers enforce these limits inside the transaction, including requests made directly to the database RPCs. Existing data is preserved. Rejected writes roll back completely; deletion and reductions reclaim space. Known quota errors become fixed `409/storage_limit` responses. Payload budgets exclude PostgreSQL indexes, metadata, and other physical disk overhead; they are not the provider's database disk meter.

Both migrations were applied through the Supabase SQL Editor, not CLI migration-history entries:

- `202610160001_landwise_foundation.sql`, SHA-256 `faf3a00d274d7343f382e0ce3cc96acbabd99840db07b8c56bbc7638aade0a9b`.
- `202610170001_landwise_storage_limits.sql`, SHA-256 `1e59e5ea6ca302335b9ab751e8ee62f6601d1e23de35715101110d6ccbd25634`.

Live verification after migration002 found four quota triggers, zero saved applications, and zero saved payload bytes. No resumes were uploaded. The foundation's live anonymous list/reservation probes returned HTTP 401 / PostgreSQL 42501. Local storage mode remains `local`; the public preview does not connect to Supabase.

## AI activation still required

The owner confirmed approval for hosted ChatGPT usage and sponsorship. The approved hosted OAuth client ID and registered callback have not yet been supplied. Local filesystem credentials and local account-picker routes are not safe for hosting and are excluded from this deployment.

Before activating AI, implement a server-only sponsor connection, user-owned hosted connections, and a no-signup first-use identity. The current account-based trial ledger is groundwork, not a functioning guest allowance. Connect it to durable generation jobs, shared rate limits, idempotent recovery and saved results. Proposed limits still to implement: one concurrent sponsored job, 10 sponsored attempts/day, 100/month, four provider calls/job, and a 240-second deadline; failures preserve the first-success allowance but still count against request budgets. Do not enable automatic credit reloads, API billing fallbacks, or unlimited retries.

Cloud application accounts also need working email delivery, exact sign-in redirect URLs, and live two-user isolation tests before activation. No public sign-in is advertised in this preview. Once enabled, the intended UX remains: Landwise is free, first tailoring requires no signup, subsequent AI use connects the visitor's own eligible ChatGPT plan, and sponsor identity never reaches browser responses.

## Validation and redeployment

- `npm run lint`
- `npm test` — 255 tests, including database quota boundaries and isolation.
- `npm run build` — local studio build.
- `npm run build:public` — public artifact and leakage checks.
- `npm audit` — zero known vulnerabilities after compatible security updates.
- Live unauthenticated HTTP checks: `/` returns 200; `/api/auth/session`,
  `/api/transform`, `/api/storage/config`, `/server.js`, and `/.env` return 404.
  The configured CSP and permissions headers are present.
- Live browser checks: Canada/US filters, saved-event persistence after reload,
  coming-soon navigation, and 390px mobile layout pass with no horizontal overflow
  or browser errors. Actual location permission was not granted during testing;
  location/error handling is covered by the automated suite.
- `vercel build --prod --scope personal-93a7` and `vercel deploy --prebuilt --prod --scope personal-93a7` for an inspected local artifact; linked Git pushes also use `vercel.json`.

Keep `.env*`, `.vercel`, `dist`, `dist-public`, and local account files out of Git. Never upload `~/.config/landwise/chatgpt.json` or reuse its local client registration as the hosted client.

References: [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase cost control](https://supabase.com/docs/guides/platform/cost-control), [Supabase setup](./SUPABASE.md).
