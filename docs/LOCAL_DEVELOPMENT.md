# Local development

The local studio uses the user's authorized ChatGPT plan and a loopback server.
Production uses a different, API-funded server. Changes to one integration do
not establish that the other works.

<!-- Linked from the live site (LOCAL_SETUP_URL in src/hostedAccess.js) and the README. Keep this heading text. -->
## Run Landwise on your computer

Use this after your 15 free tailorings on the live site. It runs on your own
computer and uses your ChatGPT account instead of Landwise's credits.

1. Install [Node.js](https://nodejs.org/) 24 and [Git](https://git-scm.com/).
   Node 22 also works; Node 25 and newer aren't supported yet. `node --version`
   should print v24 or v22.
2. Download Landwise and install its packages:

   ```sh
   git clone https://github.com/stanqiu111/landwise-resume-career.git
   cd landwise-resume-career
   npm ci
   ```

3. Start it with `npm run dev`.
4. Open **http://127.0.0.1:5174** in your browser. Use exactly that address,
   not `localhost`: from any other address, Landwise refuses ChatGPT sign-in and
   tailoring.
5. Click **Continue with ChatGPT**, sign in, and choose a model. OpenAI decides
   which plans can sign in, and your plan's own usage limits apply.

Saved applications are stored in `Documents/Landwise/Applications`, and your
ChatGPT sign-in in `~/.config/landwise` (see Credentials and saved work below).
AI requests go to OpenAI through your ChatGPT account. Press `Ctrl+C` in the
terminal to stop Landwise. To update, stop it, run `git pull` and `npm ci`, then
`npm run dev` again. "Port 5174 is already in use" means Landwise is already
running in another terminal.

## Start and stop

Use Node 24 (`nvm use` if nvm is installed), then:

```sh
npm ci
npm run security:setup
npm run dev
```

`npm run security:setup` installs the commit and push secret checks. Contributors
need it; people who only run Landwise can skip it.

Open **http://127.0.0.1:5174**. `vite.config.js` proxies `/api` to
**127.0.0.1:3001**. Keep the exact host for the OAuth callback. `Ctrl+C` stops
the processes started by `npm run dev`. Do not expose `server.js` on a public
interface or run it as a shared hosting service.

Click **Continue with ChatGPT**, finish the provider's sign-in, choose an eligible
model, and explicitly start analysis or tailoring. Typing/sign-in does not
start AI. Eligibility and usage limits are controlled by OpenAI. Claude plan
sign-in is not implemented.

`server.js` loads `.env` through dotenv; `.env.local` is not a substitute for
that server configuration. Vite separately reads its supported environment
files, so never prefix private credentials with `VITE_`. Local defaults need
neither a provider API key nor an environment file. `.env.example` documents
optional settings; copy only what you need into your existing `.env`.

Changing the frontend port requires changing `LANDWISE_APP_ORIGIN` and
`vite.config.js` together. Changing the API port requires changing `PORT` and
the Vite proxy together.

## Credentials and saved work

- ChatGPT registrations and tokens: `~/.config/landwise`, or `LANDWISE_AUTH_DIR`.
  Files/directories use owner-only permissions. Only one server may use a
  credential directory at a time. Never upload these files to Vercel or Git.
- Default applications: `~/Documents/Landwise/Applications`. Each application
  contains metadata and version folders with original text, JD, draft and
  report. This is one OS user's library, independent of the selected ChatGPT
  account. It is not multi-user cloud isolation.
- Optional account library: `LANDWISE_APPLICATION_STORAGE=supabase` with
  `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. See [Supabase](SUPABASE.md).
  Existing local folders are not uploaded automatically. Local cloud mode
  requires a separate Landwise sign-in; the Supabase session persists in the
  browser, while ChatGPT credentials stay on the server.

Completed transforms and changed follow-up revisions auto-save when an
application store is available. Saving failure keeps the result exportable;
retrying Save application does not make another AI call. Deleting an application
in the app removes its versions/progress. Unsaved studio inputs and retry IDs
are only in memory and are lost on refresh.

## Shared behavior

Tailoring edits selected existing bullets rather than rewriting the entire
resume. The report shows direct evidence, experience to expand, and missing
requirements to learn. Follow-up requests use the original source and the
current result; unsupported new facts must first be added to the source.
Changed revisions create a version. No-change replies remain in the session
until a later changed revision saves the history; at most ten exchanges travel
with a draft.

The local provider adapter has a 120-second call deadline, a 240-second
Transform deadline, and no automatic provider retries. Browser Transform has
a 250-second fallback; follow-up has a 135-second browser fallback. Errors and
cancellation preserve current input/previous output in the tab.

## Builds and checks

Run `npm run security:setup` once per clone to enable commit/push guards.
See [repository security](../SECURITY.md) before adding fixtures or publishing.
Run `npm run check` before pushing. `npm run build` creates the local frontend;
`npm run build:hosted` creates the public frontend. Both are browser bundles,
not complete standalone servers. Vite preview does not reproduce Vercel API
routing, credentials, HTTPS cookies, or email delivery.

Use the automated hosted API/security/ledger tests for local hosted logic.
Use a protected staging deployment for real hosted credential/AI checks. Keep
production secrets out of local preview builds, and do not use production
Transform as an automated availability probe.

`npm run screenshots` recaptures the README images in `docs/images`. It runs
the hosted frontend against a stand-in API with the invented student and job in
`scripts/readme-demo.mjs`, so it makes no AI or account calls. It needs
Google Chrome or Chromium; set `CHROME_PATH` to use another browser binary, or
pass a folder (`npm run screenshots -- /tmp/shots`) to preview without
overwriting. Career events reflect today's date, so that image changes as
events pass.

`npm run clean` removes only known generated output/cache directories rooted in
this repository. It retains `.env`, `.env.local`, the Vercel project link and
pulled environment file, `node_modules`, credentials and application folders.
Retired `dist-public` output is also removed from older checkouts.
