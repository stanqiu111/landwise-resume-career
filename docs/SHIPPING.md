# Shipping changes

How a change gets from an idea to the live site. This guide is written for
coding agents as much as for people: follow it step by step. The short version
is in [AGENTS.md](../AGENTS.md), and reviewers work from [REVIEW.md](../REVIEW.md).

## Where this comes from

The process is adapted from Addy Osmani's
[How the Claude Code team does code review](https://x.com/addyosmani/article/2114604912520921136)
(October 2026). Read the original for the full reasoning. The ideas we use, in
our own words:

- **Layers, not one gate.** No single check catches everything. Several
  cheaper layers (verification, automated review, CI, human judgment, rollback)
  together let very little through.
- **Most review happens before the pull request.** The author, human or agent,
  proves the change works by running something (tests, a build, a screenshot)
  and has the diff reviewed with fresh context before asking anyone else.
- **An agent reviews every pull request before a person does**, and every
  finding is fixed or answered before merging. Here the author's agent runs
  that review; see [not yet set up](#not-yet-set-up).
- **Human attention is scaled by risk.** The change, not the author, sets the
  tier. Agent approvals never stand in for a required human approval.
- **Review must converge.** An agent author and an agent reviewer can loop
  forever, so rounds are limited and later rounds look only at new commits.
- **Mistakes must be cheap to undo**, and every escaped bug teaches the
  reviewer something (a test, a lint rule, a line in REVIEW.md).
- **You land it, you own it.** Whoever runs the agent answers for what it ships.

## The pipeline

### 1. Decide, then start small

- Ask whether the change should be built at all. Closing a pull request early
  is cheap; a blocking comment on a finished one is not.
- Keep changes small and single-purpose so they are easy to review and revert.
  Unrelated fixes go in separate pull requests.
- If the area is unfamiliar, have an agent write a short explainer of that
  slice of the code before changing it.

### 2. Branch

Never commit to `main`; pushing `main` deploys to production. Create a branch
named for the change, such as `fix/upload-error-message` or
`docs/shipping-pipeline`.

### 3. Verify, and show the result

Run the checks that prove the change works, and keep the evidence for the pull
request. "Done" without evidence is not done.

| Change touches | Run and show |
| --- | --- |
| Anything | `npm run check`: secret scan, lint, all tests, hosted build, local build |
| UI | Look at each changed screen at desktop and 390 px width with reduced motion on, and check hover, focus, active and disabled states together. Hosted screens after the input form (progress, result, fit report) cannot be reached locally without a real AI call; `npm run screenshots -- <folder>` renders them with a stand-in API, so check those images. |
| README images | `npm run screenshots`, then look at every image |
| Resume pipeline: `server/transform.js`, `revise.js`, `resume-edits.js`, `resume-quality.js`, `tailoring-report.js`, `text-match.js`, `rag.js`, `prompts.js`, `schemas.js` | A test with synthetic resumes from `tests/fixtures` for the rule you changed; the rules are in [QUALITY.md](../QUALITY.md) |
| Export or page layout: `src/resumeLayout.js`, `src/resumeDocx.js`, PDF export | Render a PDF and a DOCX from a synthetic resume; check both page counts and legibility |
| Hosted API, limits, auth or storage | Tests in `tests/` for the new behavior, including the failure path |
| Dependencies | `npm audit`, release notes for behavior changes between the old and new versions, and `npm ci` accepting the lockfile |

If you could not check something, say so in the pull request's Testing
section: which screen or case, and why.

Never use real resumes, real people or production AI calls as tests. Automated
tests mock the AI provider.

If the owner's `npm run dev` servers are already running on 5174 and 3001,
do not stop or restart them. A second copy needs a different Vite port and API
port changed together (see
[local development](LOCAL_DEVELOPMENT.md#start-and-stop)); if
that is not set up, ask the owner instead of editing `vite.config.js`.

### 4. Review before the pull request

Have the diff reviewed with fresh context: a new agent session or subagent
given [REVIEW.md](../REVIEW.md) and the diff, or Claude Code's `/code-review`
and, for high-risk changes, `/security-review`. Fix what it confirms. Note
pre-existing problems separately instead of fixing them in this change.

### 5. Open the pull request

Push the branch and open a pull request against `main`. The template asks for:

- **What and why**, in a few sentences.
- **Risk tier** (below) and the reason.
- **Testing**: the commands you ran with their results, screenshots for UI,
  and anything you could not check.
- **How to revert**, including anything a code revert does not undo, such as a
  database migration.

Agents write this too, but the person running the agent is responsible for it
being true.

### 6. Automated checks

Vercel builds every pushed branch with `npm ci` and `npm run verify:hosted`
(secret scan, lint, tests, hosted build and credential scan) and reports the
result on the pull request. Do not merge with a failing check. The same build
gates production: a failing `main` build never replaces the live site.

### 7. Code review on the pull request

Every pull request gets a review posted as a comment on it, following
[REVIEW.md](../REVIEW.md) for what to look for and how to report it.

- Verify findings before reporting them; drop the ones that do not hold up.
- Every finding is closed by a fix commit or by a short reason in the thread.
  Pre-existing findings do not block.
- High-risk changes also get a security-focused review.
- Review rounds are limited (REVIEW.md). If the third round still finds
  problems, rethink the approach instead of patching.

### 8. Approval, scaled by risk

The tier comes from what the change touches; when a change spans tiers, the
highest applies.

**High**: the owner reads the diff and the evidence, and a security review runs.

- Spending and abuse limits: `server/hosted-budget.js`, `openai-inference.js`,
  `ai-rate-limit.js`.
- Identity, sessions and stored data: `server/hosted-security.js`,
  `supabase-applications.js`, `cloud-storage.js`, `application-store.js`,
  `chatgpt-auth.js`, `src/cloudAccount.js`, `src/useLandwiseAccount.js`.
- Request handling and network binding: `server/hosted-app.js`, `api/index.js`,
  `server.js`, `server/hosted-pdf.js`, `hosted-pdf-worker.js`,
  `request-deadline.js`, `vite.config.js`.
- The database: everything in `supabase/`. A migration must be additive and
  work with the deployed server.
- Build, deploy and guards: `vercel.json` (including the CSP), the `scripts`
  in `package.json`, `scripts/build-hosted.mjs`, `scripts/secret-scan.mjs`,
  `.gitleaks.toml`, `.githooks/`, `.github/`.
- New dependencies or new major versions.
- The resume pipeline and export files listed in step 3.

Any other file in `server/` or `api/` is Medium, or High if it handles
requests, money, identity or stored data.

**Medium**: a clean review, green checks, and the owner looks over the evidence.

- Frontend logic (`src/**/*.js`, `*.jsx`), other scripts, tests, minor or patch
  dependency updates.
- Any docs or UI copy that states limits, prices, privacy, what is saved, or
  timings.

**Low**: a clean review and green checks.

- Other docs, README images, CSS-only styling, wording that makes no promises.

Approval rules:

- An agent's approval never counts as the human approval.
- A review covers the commits it saw; new commits need the new diff reviewed.
- Agents do not merge. The owner merges, unless they ask for it in that
  conversation.

### 9. After merging

- Run the checks in
  [after every deployment](OPERATIONS.md#regular-checks): the commit is Ready
  on Vercel, `npm run check:live`, the studio and career events at desktop and
  phone width, Vercel logs, and a synthetic resume after generation or export
  changes. Browsers cache icons hard, so use a hard refresh.
- Merging does not apply a database migration. Follow
  [migration and account setup](SUPABASE.md#migration-and-account-setup) for
  the order (some migrations need the new server deployed first), the check
  queries, and recording the file's SHA-256 in
  [DEPLOYMENT.md](DEPLOYMENT.md#applied-migrations).
- Delete the merged branch.

### 10. When something goes wrong

Follow [deployments and rollback](OPERATIONS.md#deployments-and-rollback). Its
cautions matter: restore the last tested hosted deployment and check its flags
and configuration, and never restore one from before a migration it cannot
work with (the guest-trial migration needs its down script first). A code
revert does not undo a migration or restore deleted data. To stop new AI work
quickly, set `LANDWISE_HOSTED_AI_ENABLED=false` and redeploy.

The person who landed the change usually fixes it, because they have the most
context. Then ask which layer should have caught it, and add a regression test,
a lint rule or a line under "Lessons from escaped bugs" in
[REVIEW.md](../REVIEW.md).

## What people still decide

Agents do most of the reading. The owner still decides whether something
should be built and how it should feel, reviews high-risk changes and
architecture choices, checks that the evidence proves what it claims, and
answers for everything that ships.

## Not yet set up

These parts of the process need owner action outside the repository. Until
then, the rules above are conventions, not enforced.

- **Branch protection on `main`** (repository settings, Rules): require a pull
  request before merging, the Vercel status check, resolved conversations, and
  block force pushes and deletion. Leave required approvals at 0 or give the
  owner a bypass: GitHub does not let the only owner approve their own pull
  request, so the owner's review stays a convention until there is a second
  reviewer (see [SECURITY.md](../SECURITY.md)).
- **Automated review in CI**, such as the Claude Code GitHub Action with
  security review. Adding the workflow file needs a GitHub connection with the
  `workflow` scope, which the current one lacks, and the Action needs an API key
  stored as a repository secret. Follow SECURITY.md: a read-only token and
  pinned action SHAs. The repository is public, so never run pull request code
  from forks with secrets.
- **Merge queue, staged rollouts and broad feature flags** are not needed at
  current traffic. The hosted flags in use are listed in
  [DEPLOYMENT.md](DEPLOYMENT.md): `LANDWISE_HOSTED_AI_ENABLED` and
  `LANDWISE_ACCOUNT_SIGN_IN_ENABLED`.
