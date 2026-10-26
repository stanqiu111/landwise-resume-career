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
- **Every pull request gets an automated review**, and its findings must be
  fixed or answered before merging. Pure style comments are filtered out.
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
| UI | Open the changed screen at desktop and 390 px width, with reduced motion on; check hover, focus, active and disabled states. Hosted-only UI needs `VITE_LANDWISE_HOSTED=true`. |
| README images or visible UI shown in them | `npm run screenshots`, then look at every image |
| Resume pipeline (`server/transform.js`, `revise.js`, `resume-*.js`, `tailoring-report.js`, `prompts.js`, `schemas.js`) | A test with synthetic resumes in `tests/fixtures` for the rule you changed; the rules are in [QUALITY.md](../QUALITY.md) |
| Hosted API, limits, auth or storage | Tests in `tests/` for the new behavior, including the failure path |
| Dependencies | `npm audit`, release notes for behavior changes between the old and new versions, and `npm ci` accepting the lockfile |

Never use real resumes, real people or production AI calls as tests. Automated
tests mock the AI provider. If `npm run dev` servers are already running on
5174 and 3001, they belong to someone else: use other ports.

### 4. Review before the pull request

Have the diff reviewed with fresh context: a new agent session or subagent
given [REVIEW.md](../REVIEW.md) and the diff, or Claude Code's `/code-review`
and, for high-risk changes, `/security-review`. Fix what it confirms. Note
pre-existing problems separately instead of fixing them in this change.

### 5. Open the pull request

Push the branch and open a pull request against `main`. The template asks for:

- **What and why**, in a few sentences.
- **Risk tier** (below) and the reason.
- **Testing**: the commands you ran with their results, and screenshots for UI.
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

Every pull request gets a review recorded as a comment on it, in the format in
[REVIEW.md](../REVIEW.md): a verdict, a count, and each finding with severity,
`file:line`, what goes wrong, and a suggested fix.

- Verify findings before reporting them; drop the ones that do not hold up.
- Every finding is closed by a fix commit or by a short reason in the thread.
  Pre-existing findings do not block.
- High-risk changes also get a security-focused review.
- **Convergence:** at most three review rounds. After the first round, review
  only the new commits, name the class of bug so every instance gets fixed, and
  do not raise findings again that were fixed or answered. If round three
  still finds problems, rethink the approach instead of patching.

### 8. Approval, scaled by risk

The tier comes from what the change touches. When a change spans tiers, the
highest applies.

| Tier | Typical paths | Before merging |
| --- | --- | --- |
| **High** | Spending and abuse limits (`server/hosted-budget.js`, `openai-inference.js`, `ai-rate-limit.js`); identity and data access (`hosted-security.js`, `supabase-applications.js`, `cloud-storage.js`, `chatgpt-auth.js`, `src/cloudAccount.js`, `src/useLandwiseAccount.js`); request handling (`hosted-app.js`, `api/index.js`, `hosted-pdf*.js`, `request-deadline.js`); `supabase/`; build and guards (`vercel.json`, `scripts/build-hosted.mjs`, `scripts/secret-scan.mjs`, `.githooks/`, `.github/`); new dependencies or major versions; the resume pipeline's truth rules | The owner reads the diff and the evidence. Security review. A migration must be additive and work with the deployed server. |
| **Medium** | Frontend logic (`src/**/*.js`, `*.jsx`), the local server, other scripts, tests, minor or patch dependency updates, UI copy about limits, privacy or saving | Clean review, green checks, and the owner looks over the evidence. |
| **Low** | Docs, README, images, CSS-only styling, wording that makes no promises | Clean review and green checks. |

- An agent's approval never counts as the human approval.
- A review covers the commits it saw. New commits need the new diff reviewed.
- Agents do not merge. The owner merges, unless they ask for it in that
  conversation.

### 9. After merging

- Confirm the production deployment on Vercel reached Ready.
- Run `npm run check:live`. It is read-only and makes no AI call.
- Look at the changed page on the live site. Browsers cache icons hard, so use
  a hard refresh.
- Delete the merged branch.

### 10. When something goes wrong

Restore the last good deployment in Vercel, then revert the change through a
pull request so the code and the live site agree. A code revert does not undo
a Supabase migration or restore deleted data; see
[deployments and rollback](OPERATIONS.md#deployments-and-rollback). To stop AI
spending quickly, set `LANDWISE_HOSTED_AI_ENABLED=false` and redeploy.

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

These parts of the process need owner action outside the repository:

- **Branch protection on `main`** (repository settings, Rules): require a pull
  request, the Vercel check and the code owner's review from
  [CODEOWNERS](../.github/CODEOWNERS); dismiss approvals when new commits are
  pushed; require all conversations to be resolved; block force pushes. Until
  then these rules are conventions, not enforced.
- **Automated review in CI**, such as the Claude Code GitHub Action with
  security review. It needs a GitHub token with the `workflow` scope and an API
  key stored as a repository secret. The current GitHub connection cannot create
  workflow files, so reviews are run by the author's agent and posted as
  comments.
- **Merge queue, staged rollouts and broad feature flags** are not needed at
  current traffic. The hosted AI switch above is the one flag in use.
