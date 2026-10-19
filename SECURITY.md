# Security and repository privacy

Never include API keys, tokens, cookies, real resumes, screenshots with personal
data, or database exports in an issue, pull request, commit, or build artifact.
Use fictional people and generated credentials in tests.

## Where secrets belong

- Hosted `OPENAI_API_KEY`, Supabase service-role credentials and
  `LANDWISE_SESSION_SECRET`: Vercel **Production** environment secrets, server
  only. Keep them out of Preview environments, `VITE_*` values and GitHub code.
- Local environment: ignored `.env` files. `.env.example` contains placeholders.
- Local ChatGPT tokens: `~/.config/landwise`, outside this repository.
- Local applications: `~/Documents/Landwise/Applications`, outside Git.
- Private operator notes and exports: outside the checkout, or ignored
  `private/`, `backups/`, `uploads/` and `exports/` directories as temporary work.

The Supabase project URL and publishable/anon key are intentionally visible to
the browser. They are not service-role secrets. User privacy depends on verified
authentication, row-level security and server-side ownership checks. Making
source public does not expose Vercel's stored environment secret values.

## Checks before committing or pushing

After `npm ci`, run this once in **each clone**:

```sh
npm run security:setup
```

This enables the tracked `.githooks` using local Git configuration. The commit
hook scans the entire staged snapshot, including force-added ignored files; the
push hook scans all locally available Git history. A cleaned working copy does
not conceal a secret still staged for commit. Existing custom hooks are never
silently replaced. Git hooks are local and can be bypassed; they do not enforce
rules on another contributor's computer or GitHub's web editor.

```sh
npm run security:check    # tracked + non-ignored new source; used by the build
npm run security:history  # all locally available refs and commits
npm run check             # security scan, lint, tests, hosted and local builds
```

The runner downloads official Gitleaks **8.30.1**, verifies a pinned SHA-256,
caches the archive under `~/.cache/landwise-security`, and rechecks it before
execution. First use needs GitHub access; later scans can use the verified cache.
Supported systems: macOS/Linux arm64 or x64; use WSL on Windows. Updating the
scanner requires reviewing the version and all release checksums together.
Reports print locations and rule IDs only. Inline ignore comments and fingerprint
ignore files cannot silently bypass this runner. Do not add blanket exclusions
for tests or docs. The default rules plus Supabase/OpenAI key detection are not
a proof that every possible credential or personal detail will be recognized.

Private file paths (including credential stores, key files, PDF/DOCX exports and
database backups) are blocked separately from secret detection. A legitimate
new binary fixture needs an explicit policy review and synthetic contents. The
build checks source even when deployment has no `.git` directory; build outputs
and dependencies are excluded. Hosted browser assets have an additional check.
Vercel's build gate protects deployment **after** a push; it does not undo a Git
disclosure. Review `git diff --cached` before committing.

## Before changing visibility to public

1. Fetch all remote branches/tags and rerun the history scan. Audit PR refs,
   releases, artifacts and attachments separately if they exist. Read docs and
   images for personal data that a credential scanner cannot detect.
2. Review **commit author/committer emails and names**, including old commits.
   A GitHub noreply email protects future commits only. Deleting a file or
   changing author settings does not sanitize old history.
3. Enable GitHub secret scanning, push protection, dependency alerts and private
   vulnerability reporting where supported. Require reviewed changes to `main`
   and passing checks; the repository's CODEOWNERS file alone does not enforce
   approval. Current private-plan restrictions may require public visibility or
   a paid plan before some controls can be configured.
   A sole owner's own PR cannot receive that same owner's approval; arrange a
   second reviewer or a deliberate owner bypass before requiring owner reviews.
4. Keep production credentials out of fork/preview builds. Require authorization
   for fork deployments in Vercel. Never run unreviewed PR code with production
   credentials. Add GitHub CI with a read-only token and pinned action SHAs when
   a connection with workflow-file permission is available.
5. Choose a license if offering the project as open source. Public visibility
   by itself is not an open-source license.

No scanner guarantees that a repository is free of every secret or personal
detail. Publishing also exposes old commit metadata and documents unless
history is deliberately rewritten. Coordinate a rewrite with collaborators;
never force-push rewritten production history casually.

## Reporting a vulnerability

Do not post sensitive details in public issues. Use GitHub's private **Report a
vulnerability** option in the repository Security tab when enabled. If it is
unavailable, contact a maintainer privately and ask for a secure channel before
sharing credentials or user data. A public report is not a fallback.

If a real credential leaks, revoke/rotate it first, update deployment secrets,
redeploy, and verify service health. Removing the latest file is insufficient:
review history, cached views, forks, logs and artifacts. Coordinate history
cleanup only after containment. See [GitHub's sensitive-data removal guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
and [Gitleaks](https://github.com/gitleaks/gitleaks).
