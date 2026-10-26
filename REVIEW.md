# Review guide

For anyone reviewing a Landwise change, person or agent. The process around the
review is in [docs/SHIPPING.md](docs/SHIPPING.md).

## What counts as a failure here

Look for these first. They matter far more than style.

- **The resume pipeline invents or loses facts.** Any break of the rules in
  [QUALITY.md](QUALITY.md): claims without a source quote, changed numbers,
  dropped contact details or education, edits past the cap, silent truncation,
  a score that does not follow the evidence.
- **Secrets or personal data can leak** into the browser bundle, logs, Git, a
  pull request or a screenshot. Server logs hold metadata only. See
  [SECURITY.md](SECURITY.md).
- **Spending or abuse limits can be bypassed or weakened**: the budget ledger,
  guest allowance, per-IP and daily limits, provider deadlines, or the hosted AI
  switch.
- **Auth, CSRF, origin or ownership checks get weaker**, including Supabase
  row-level security and the server-side owner checks.
- **The hosted build or CSP loosens**: code, fonts or connections from new
  origins, or the build stops scanning for credentials.
- **Docs or UI copy promise something the code does not do**: limits, privacy,
  what is saved and where, timings.
- **One mode breaks the other**: a hosted fix that breaks the local
  ChatGPT-connected studio, or the reverse.
- **Accessibility regresses**: lost labels, roles or live regions, focus that
  disappears or gets trapped, motion that ignores `prefers-reduced-motion`,
  states (hover, focus, active, disabled) that override each other.
- **A migration is not additive** or cannot run alongside the deployed server.

## Do not report

- Style preferences, naming, or formatting that lint accepts.
- Generated or binary paths: `dist/`, `dist-hosted/`, `node_modules/`,
  `docs/images/`, `docs/reports/`. In `package-lock.json`, review only which
  packages and versions changed and where they come from.
- Problems that existed before the change, as blocking. Report them once,
  labelled Pre-existing.

## How to report

- Open with a verdict and a count, for example "Approve with nits: 2
  findings". When there is nothing, say "No issues found" plainly.
- For each finding give the severity (**Important**, **Nit** or
  **Pre-existing**), the `file:line`, the concrete situation that goes wrong,
  and a suggested fix.
- Verify before you report. Never guess file names or line numbers.
- Group findings by class of bug so the author can fix every instance at once.
- At most three rounds per pull request. After the first round, review only the
  new commits, and do not raise findings again that were fixed or answered.

## Lessons from escaped bugs

Each entry is a bug that got past review. Check new changes for the same
pattern.

- **2026-10-26, failed production deploy.** The restyle added self-hosted font
  files, and the hosted build check only allowed HTML, JS, CSS and SVG, so the
  Vercel build failed. Only `npm run build` had been run locally. Run
  `npm run check`, which includes the hosted build, before every pull request.
- **2026-10-26, active tab lost its highlight on hover.** A
  `:hover:not(:disabled)` rule outranked `.is-active`, so the selected result
  tab turned grey under the pointer. When restyling, check every interactive
  state together.
