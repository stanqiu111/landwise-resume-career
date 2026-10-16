# Landwise — Architecture & Workflow

## Account connection

The local app uses **Continue with ChatGPT** and an eligible user-authorized plan, without provider API keys. `server/chatgpt-auth.js` implements loopback OAuth, PKCE, verified identity, protected local registration storage, refresh, and sign-out. `server/chatgpt-inference.js` lists the account's models and reads Responses API streams with `store: false`; it returns only completed responses.

The API binds to `127.0.0.1`. AI requests require a local session, exact app origin and CSRF header. The browser explicitly starts inference when the user clicks Analyze or Transform. Typing and sign-in never start inference. Account switching, sign-out and Cancel abort ongoing work. A publicly hosted service needs a separately approved integration; see README.

## Input and results

Users paste text or upload a PDF to `POST /api/parse-pdf`. PDF parsing happens locally and returns text plus the original page count, without synthetic page-number markers. A PDF's page count becomes the default output limit. Pasted text is estimated using the standard export layout; the user can adjust the page limit. They add a job description, select an account model and click Transform.

The result has three tabs: Resume, Fit report and Evidence. The resume is copyable, expandable and downloadable as PDF or DOCX. Exports are generated in the browser. Fit report separates direct evidence present in the draft, transferable evidence to expand, and requirements to learn or substantiate; Evidence shows requirement coverage. Exact final-draft quotes are verified before being displayed as placement evidence.

## Transform pipeline

`POST /api/transform` accepts `{ resume, jobDescription, model, maxPages }`. Deterministic input checks reject short or non-text job descriptions and invalid page limits before provider calls.

`server/transform.js` normally makes three sequential AI calls:

1. **Combined extraction:** one call validates and analyzes the job description, extracts requirements and extracts resume facts with exact source quotations. Local grounding accepts only quotations present in the original resume; the job description never serves as candidate evidence.
2. **Matching:** matches job requirements to the verified claim bank. Local checks discard invented claim IDs and unsupported source quotations, and derive coverage from remaining valid matches.
3. **Targeted editing and coaching:** returns replacements for a limited set of existing bullet IDs and a next step for each requirement, using the full original resume, verified claims, job analysis and locally retrieved relevant sections. `server/resume-edits.js` applies only valid replacements to the original lines; all other lines remain unchanged. At most 35% of bullets rounded up may be edited (minimum one). Empty, multiline, duplicate, non-bullet or substantially expanded replacements are rejected. Metrics must remain in their own original bullet. The model cannot substitute a full rewrite.

Local final checks reject missing contact details, omitted education and invented numbers. Invalid output produces a visible error rather than an empty success response. Retrieval uses local TF-IDF and makes no external calls.

The writer receives the page limit and a source-based word budget. `src/resumeLayout.js` measures the actual wrapped text on Letter pages with 11 pt body text, or a compact 10.5 pt layout. If a draft exceeds the limit, one additional sequential editing call tightens it. The revised draft must pass the same factual and page checks; remaining overflow returns `resume_too_long`. Text is never truncated to fit. Results include the verified `pageCount` and `pageLimit`.

PDF export uses the exact same layout calculation as server validation and refuses overflow. DOCX uses the same wrapped lines, page size, margins, fixed line spacing and explicit page breaks. Its pagination is verified in LibreOffice for representative fixtures; changing fonts, editing content or opening it in another word processor can reflow it. The PDF is the fixed-pagination format.

The original resume is the only source of candidate facts. Job requirements guide emphasis and never establish candidate experience. Prompts preserve identifying history and prohibit invented skills, achievements and metrics.

## Fit report and application library

`server/tailoring-report.js` calculates a source-evidence score independently of the writer: must-have requirements have weight 2, preferred weight 1; exact evidence earns 1, semantic/transferable evidence 0.5, absent evidence 0. Evidence IDs must exist in the grounded claim bank. Placement quotes must occur in the final draft and have supporting source evidence. Unverified placement remains in the expand group. Coaching is generated in the existing writing request, with local fallback next steps when absent. Scores are not hiring predictions or validated ATS results.

`server/application-store.js` stores completed results under `~/Documents/Landwise/Applications`, one local OS-user library, separate from provider credentials. Application snapshots are committed with atomic rename and serialized mutations. Version subfolders contain readable source, JD, draft and report files. SHA-256 of the trimmed exact JD groups versions; an identical retry is idempotent. Metadata includes editable company/role, stage, notes, practice tasks and dated progress changes. Original version inputs and reports never change when progress is updated.

`POST /api/applications/{list,get,save,update,remove}` requires the exact local origin and session CSRF token, including reads. Reading/saving progress requires no selected provider or AI call. The server auto-saves a completed transform before returning its result. A storage failure returns the finished draft plus a save warning; the UI provides retry/export. Folder IDs are validated before path access, files use mode 0600 and created folders use 0700. This is local persistence, not multi-user cloud account isolation or synchronization.

## Follow-up revisions

`POST /api/revise` accepts `{ resume, jobDescription, result, instruction, maxPages, model }`. The original source and job are the inputs captured for that completed draft, not newly typed studio fields. The server validates their relationship to the current result, re-grounds its claim bank, and makes one editorial AI request. It applies small bullet edits against the current draft, checks them against the original evidence and immutable structure, validates page count, and rebuilds the fit report. There is no automatic retry or extra shortening request. Errors and overflow leave the prior draft untouched.

Revision requests share the existing account lock, cooldown, origin/CSRF checks, abort signal and streamed progress. The server deadline is at most 120 seconds; the browser fallback is 135 seconds. The UI keeps the existing preview visible and disables conflicting AI/input actions. Saved versions restore the original input and current draft together. Successful changed revisions auto-save through the existing application store; no-change replies retain the previous save metadata. `revision` contains the request, reply, timestamp and changed flag; `revisionHistory` retains at most ten recent exchanges.

## Progress, cancellation and diagnosis

The UI requests `Accept: application/x-ndjson`. `server/transform-progress.js` streams actual running/completed/failed stages, elapsed time and five-second heartbeats, followed by one terminal result or error. Other clients can continue receiving a regular JSON response. `src/transformResponse.js` handles fragmented updates, connection interruption and empty results.

The UI does not simulate progress. Analyze and Transform are mutually exclusive. A server guard also prevents overlapping actions from different tabs using the same authenticated account. It displays a Cancel control and persistent errors. A failed retry keeps the previous result and inputs. Expired session errors refresh the connection without reloading the form.

`server/request-deadline.js` bounds the full operation, including response-body streaming:

- Each provider inference call: 120 seconds.
- Entire Transform, including connection and all calls: 240 seconds.
- Browser fallback deadline: 250 seconds.

Deadlines and browser disconnects abort provider work. Provider failures are not retried automatically. The optional length-editing pass stays within the overall deadline. Temporary HTTP or streamed rate limits preserve Retry-After guidance and pause new requests for that account, with a 60-second fallback pause if no delay is supplied. The browser displays a cooldown countdown; it does not retry automatically. Plan allowance exhaustion remains separate and links to ChatGPT Manage usage. These are maximum waits, not promised generation times.

Server logs contain only `transform_step`, `transform_complete` or `transform_failed` events with a request ID, step/status or error code, and elapsed milliseconds. They never contain prompts, resume text, provider output or credentials. The timers cover model discovery, combined extraction, matching, writing, optional shortening and final checks. The animated Read, Match, Build and Check cards follow these events; decorative animation never advances completion.

## Local services and source map

- React/Vite: `http://127.0.0.1:5174`; proxies `/api` to Express on port 3001.
- `server.js`: API routes, input validation and request lifecycle.
- `server/chatgpt-auth.js`: account connection and protected credentials.
- `server/chatgpt-inference.js`: model discovery and complete response streams.
- `server/resume-edits.js`, `server/tailoring-report.js`: limited edits and evidence-derived fit feedback.
- `server/application-store.js`, `src/components/Applications.jsx`: local folders, versions and application progress.
- `server/transform.js`: sequential extraction, matching and tailoring.
- `server/transform-progress.js`: stage timing and progress response.
- `server/request-deadline.js`: cancellation and full-operation deadlines.
- `server/rag.js`: local resume retrieval.
- `server/schemas.js`, `server/resume-quality.js`, `server/prompts.js`: evidence and output rules.
- `src/App.jsx`, `src/transformResponse.js`: request state, progress, cancellation and errors.
- `src/components/InputPanel.jsx`, `OutputPanel.jsx`: input, preview and exports.
- `src/resumeLayout.js`, `src/resumeDocx.js`: shared pagination, PDF and Word exports.

## Verification

`npm test` covers authentication, stream assembly, stalled streams after headers, deadline cancellation, sequential extraction, streamed progress, terminal errors, evidence preservation, PDF upload counts, one- and two-page exports, content retention and bounded overflow recovery. `npm run lint` and `npm run build` check the source and browser bundle. Live timing checks use a synthetic resume to avoid retaining personal input in diagnostics.
