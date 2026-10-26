# Agent guide

Landwise tailors a resume to a job with small, checked edits to the bullets the
person already wrote. React 19 and Vite in `src/`, an Express API in `server/`
that runs two ways (a loopback studio using the person's ChatGPT plan, and a
hosted Vercel function), and Supabase for the spending ledger and accounts.
The truthfulness rules for resume edits are in [QUALITY.md](QUALITY.md).

## Rules

- **Never commit to `main`.** Pushing `main` deploys to production. Branch,
  verify, open a pull request and get it reviewed, as in
  [docs/SHIPPING.md](docs/SHIPPING.md). Agents do not merge unless the owner
  asks.
- **Never read, print or commit secrets or personal data**: `.env*` files,
  credentials, tokens, real resumes. Use synthetic people and the fixtures in
  `tests/fixtures`. See [SECURITY.md](SECURITY.md).
- **No real AI calls as tests or health checks.** Tests mock the provider.
- **Leave running dev servers alone.** `npm run dev` uses 127.0.0.1:5174 and
  3001; if they are already up, use other ports.
- **Commit messages**: a short summary line, then what changed and why. No AI
  attribution trailers.
- **Show results, not claims.** Run the checks below and put the evidence in
  the pull request.

## Checks you can run

| Command | When |
| --- | --- |
| `npm run check` | Before every pull request: secret scan, lint, all tests, hosted and local builds |
| `npm run lint`, `npm test` | Quick loop while working |
| `npm run screenshots` | After visible UI changes; rebuilds the README images |
| `npm run check:live` | After a deploy; read-only, no AI call |

## More

- [REVIEW.md](REVIEW.md): what reviewers look for and how to report findings.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): project structure, commands and
  where each topic is documented.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pipeline and the two server
  modes fit together.
