# Landwise — Architecture & Workflow

## Account connection

The local app uses **Continue with ChatGPT** and an eligible user-authorized plan, without provider API keys. `server/chatgpt-auth.js` implements loopback OAuth, PKCE, verified identity, protected local registration storage, refresh, and sign-out. `server/chatgpt-inference.js` lists the account's models and reads Responses API streams with `store: false`; it returns only completed responses.

The API binds to `127.0.0.1`. AI requests require a local session, exact app origin and CSRF header. The browser explicitly starts inference when the user clicks Analyze or Transform. Typing and sign-in never start inference. Account switching, sign-out and Cancel abort ongoing work. A publicly hosted service needs a separately approved integration; see README.

## Input and results

Users paste text or upload a PDF to `POST /api/parse-pdf`. PDF parsing happens locally and returns text plus the original page count, without synthetic page-number markers. A PDF's page count becomes the default output limit. Pasted text is estimated using the standard export layout; the user can adjust the page limit. They add a job description, select an account model and click Transform.

The result has three tabs: Resume, Analysis and Claims. The resume is copyable, expandable and downloadable as PDF or DOCX. Exports are generated in the browser. Analysis shows supported keywords, skill gaps and changes; Claims shows evidence coverage.

## Transform pipeline

`POST /api/transform` accepts `{ resume, jobDescription, model, maxPages }`. Deterministic input checks reject short or non-text job descriptions and invalid page limits before provider calls.

`server/transform.js` normally makes three sequential AI calls:

1. **Combined extraction:** one call validates and analyzes the job description, extracts requirements and extracts resume facts with exact source quotations. Local grounding accepts only quotations present in the original resume; the job description never serves as candidate evidence.
2. **Matching:** matches job requirements to the verified claim bank. Local checks discard invented claim IDs and unsupported source quotations, and derive coverage from remaining valid matches.
3. **Writing:** generates the complete tailored resume using the full original resume, verified claims, job analysis and locally retrieved relevant sections.

Local final checks reject missing contact details, omitted education and invented numbers. Invalid output produces a visible error rather than an empty success response. Retrieval uses local TF-IDF and makes no external calls.

The writer receives the page limit and a source-based word budget. `src/resumeLayout.js` measures the actual wrapped text on Letter pages with 11 pt body text, or a compact 10.5 pt layout. If a draft exceeds the limit, one additional sequential editing call tightens it. The revised draft must pass the same factual and page checks; remaining overflow returns `resume_too_long`. Text is never truncated to fit. Results include the verified `pageCount` and `pageLimit`.

PDF export uses the exact same layout calculation as server validation and refuses overflow. DOCX uses the same wrapped lines, page size, margins, fixed line spacing and explicit page breaks. Its pagination is verified in LibreOffice for representative fixtures; changing fonts, editing content or opening it in another word processor can reflow it. The PDF is the fixed-pagination format.

The original resume is the only source of candidate facts. Job requirements guide emphasis and never establish candidate experience. Prompts preserve identifying history and prohibit invented skills, achievements and metrics.

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
