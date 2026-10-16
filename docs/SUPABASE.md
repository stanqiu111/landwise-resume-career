# Landwise accounts and application storage

Optional Supabase mode gives every signed-in Landwise account its own application
library. It stores the original resume text, job description, tailored versions,
fit reports, follow-up history, notes and practice progress. PDF and DOCX exports
are regenerated in the browser; original PDF binaries are not uploaded to
Supabase.

The default is still local storage. Existing folders are not automatically
uploaded or reassigned to an account. Switching ChatGPT accounts does not switch
the Landwise library: the Supabase account owns it.

## Setup

1. Apply `supabase/migrations/202610160001_landwise_foundation.sql` once to the
   selected project. The migration is additive and transactional, with only
   `landwise_*` tables/functions and the `landwise_private` schema. Do not rerun a
   successful migration; record it in your normal migration history.
2. In Supabase Authentication, enable email sign-in and configure an appropriate
   email delivery service for public use. Add the exact Landwise origin to the
   allowed redirect URLs. Local testing uses `http://127.0.0.1:5174/`; production
   must use its own HTTPS origin.
3. Set these server variables in an ignored `.env` file or deployment settings:

   ```dotenv
   LANDWISE_APPLICATION_STORAGE=supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

   Use only a publishable key (or legacy `anon` key). The configuration endpoint
   intentionally sends that public key to the browser. Secret/service-role keys
   are rejected and are not needed for application storage.
4. Restart the API and sign in to the Landwise account using its email link.
   Cloud mode requires that account for application operations, AI and PDF
   uploads. The separate ChatGPT connection still authorizes AI usage.
5. Verify two test accounts before public launch: save the same JD in each,
   confirm separate libraries, and confirm one account cannot fetch or modify
   the other account's application ID. Account switches clear the studio and
   library and cancel in-flight work. Token refresh for the same account does
   not clear the studio.

The API verifies the bearer token with Supabase Auth before work begins. All
database calls then use that same end-user token. No owner ID from browser input
is trusted. Supabase row-level security restricts direct reads, and owner-scoped
RPCs validate and serialize writes. Auth/storage outages fail closed; they never
fall back to another user's local library. A completed AI draft remains
exportable if a later cloud save fails.

## Sponsored first transform

The migration prepares a private lifetime trial ledger. Only the backend service
role can call `landwise_trial_reserve`, `landwise_trial_complete` and
`landwise_trial_release`; browser users cannot grant or reset trials.

- Reserve one request ID atomically before invoking the sponsor's AI account.
- Repeat reservation of that same request is idempotent; a different active
  request is rejected.
- Complete only after a validated result has been durably saved to an application
  version owned by that user. A repeat completion returns the recorded result.
- Release a failed reservation only with its matching request ID. Completed
  usage cannot be released, including after the application is removed.
- Reservations have no automatic timeout reset. A future job worker must
  reconcile interrupted jobs before releasing them, so a still-running request
  cannot consume the sponsor's plan twice.

**Sponsorship is not enabled by this migration or storage mode.** The owner has
confirmed approval for hosted sponsorship. Activation still requires the public
Landwise URL and registered hosted OAuth client/callback, server-side sponsor
credential isolation, durable job/idempotency handling, and provider admission
limits shared across workers. The existing ChatGPT OAuth host remains restricted
to loopback; Supabase storage alone does not make this runtime ready for a public
multi-user deployment. No visitor is billed to the owner's plan by this change.

## Validation

`npm test` includes PostgreSQL-engine tests using PGlite for the migration, RLS,
RPC permissions, ownership, version retention and trial transitions. It also
tests server identity verification and HTTP adapter isolation/error handling.
PGlite uses one connection; these tests do not replace multi-session contention
tests or a real email sign-in test against a hosted staging project.

Relevant Supabase documentation:
[Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser),
[row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security),
[redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
