# Deployment status

Updated October 16, 2026.

- Selected Supabase organization: Personal.
- Selected project: supabase-amber-pebble (`audfewrmqgsefeutappd`).
- Project URL: https://audfewrmqgsefeutappd.supabase.co
- Migration `202610160001_landwise_foundation.sql` applied successfully through the Supabase SQL Editor. This was a manual dashboard application, not a CLI migration-history entry.
- Applied SQL SHA-256: `faf3a00d274d7343f382e0ce3cc96acbabd99840db07b8c56bbc7638aade0a9b`.
- Live anonymous RPC probes returned HTTP 401 / PostgreSQL 42501 for both application listing and trial reservation, confirming those calls are denied.
- Existing public schema was empty before application. The migration adds application/version tables with owner policies and a private trial ledger. No existing resumes were uploaded.
- Local ignored `.env` contains the selected project's public connection settings. Storage mode remains `local` until the email redirect/delivery setup is verified.
- Initial hosting preference: Vercel default URL, with a custom domain possible later. No Vercel project/domain has been provisioned by this change.
- Hosted ChatGPT usage and sponsorship approval was confirmed by the owner. The approved client ID and registered callback have not yet been supplied.

## Remaining activation work

Configure the Landwise email sign-in redirect and verify email delivery, then test two real accounts against Supabase before enabling cloud mode. Provision the Vercel deployment URL and register the exact hosted OpenAI callback against the approved client. Replace the loopback-only provider credential/session host with user-owned hosted connections and a separate server-only sponsor connection. Connect the tested trial ledger to durable generation jobs, saved results, idempotent recovery and shared provider limits.

The current app continues to run locally at http://127.0.0.1:5174. The sponsored first transform is not enabled. See [Supabase setup](./SUPABASE.md) for the schema and storage contract.
