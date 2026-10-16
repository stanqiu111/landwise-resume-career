# Landwise

**Land the job, wisely.**

Landwise is a local resume tailoring app with career-event discovery. Connect an eligible ChatGPT Plus or Pro plan, paste your resume and a job description, and choose when to run AI feedback or tailoring. No provider API key is needed.

---

## Features

- **Light resume tailoring** — edits a small portion of existing bullets while preserving every role, project, heading, date and original purpose
- **Claim-based evidence checks** — extracts quoted claims from your resume and matches them to job requirements before rewriting
- **Local retrieval** — uses TF-IDF to retrieve relevant resume sections without a separate embedding service or API key
- **Continue with ChatGPT** — OAuth sign-in, account switching, model selection, and usage management using the user’s eligible plan
- **Resume analysis** — on-demand feedback on resume quality, section scores, and suggested LLM/AI skills to add
- **Match score & fit report** — weighted source evidence, separating direct matches, transferable experience to expand, and requirements to learn or substantiate
- **Follow-up revisions** — after tailoring, ask for small wording changes in Refine this draft; keep the current preview while AI works, review the reply and before/after edits, and save changed drafts as new versions
- **My applications** — local folders containing the original resume, JD, tailored versions and reports; track applications, interviews, notes and learning/coding practice
- **Skills gap** — surfaces JD requirements your resume can't support, instead of inventing them
- **Length-aware PDF & DOCX export** — default to the original PDF page count, check the rendered layout and keep exported content within the selected limit
- **PDF upload** — drag-and-drop your existing resume as a PDF
- **Readable output** — clear section hierarchy and bullets in the preview, PDF, and DOCX
- **Focused workspace** — a white, gray, black, and blue two-column layout, collapsible account settings, and separate Resume, Fit report, and Evidence views
- **Career events** — student-oriented career fairs and organizer calendars across Canada and the United States, with original sources, dates, and eligibility
- **Event discovery** — search and filter by country, location, school, and access; save resources in your browser or copy an organizer’s link
- **Nearby events** — request browser location when Career events first opens, sort by approximate distance, or switch to soonest first

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8 |
| Backend | Node.js, Express 5 |
| AI — generation | OpenAI Responses with user-authorized ChatGPT plan access |
| Retrieval | Local TF-IDF |
| Sign-in | OAuth Authorization Code + PKCE, verified OpenID Connect identity |
| PDF parse | `pdf-parse` |
| PDF export | `jsPDF` |
| DOCX export | `docx` |
| Schema validation | Zod |

---

## Using Landwise

1. Open **http://127.0.0.1:5174** and click **Continue with ChatGPT**.
2. Complete ChatGPT’s own sign-in and approve plan usage for Landwise. Eligible plans and usage limits are controlled by OpenAI.
3. Return to Landwise, choose a model from your account’s catalog, and upload or paste your resume. PDF uploads set the output page limit automatically; for pasted text, review the estimated limit and adjust it if needed.
4. Click **Analyze my resume** for feedback, or add a job description and click **Tailor my resume**. Review the **Resume**, **Fit report**, and **Evidence** tabs, then use **Full screen**, **Copy text**, **PDF**, or **DOCX**. Account and model settings are available beneath the inputs or from the header's connection link.

Completed transforms are automatically saved in **My applications**, grouped by the exact job description. Company and role are extracted from the job posting; you can correct their labels. New drafts for the same posting keep earlier versions. Open a saved version to review its original input, JD, draft and report, export it, or restore the original inputs to the studio. Track Resume ready → Applied → Interview → Offer/Closed and save notes and learning/coding-practice tasks. A checklist is seeded from the first report's gaps; you control later updates.

Use **Refine draft** to jump to the follow-up section below a completed resume. Ask for a shorter bullet, more natural wording, or a clearer explanation of the original project purpose. Example prompts fill the box; only **Update my resume** starts AI. Revisions make one request, use the current draft while checking against the original source, preserve the page limit, and refresh the fit report. Cancel, connection errors and rate limits leave the previous draft and your typed request intact. Unsupported factual additions require updating the original source and tailoring again. If your studio inputs change, tailor again before refining the old result. Saved versions can be reopened with **Refine this saved draft**.

Changed revisions save a new application version with the follow-up request and reply. A no-change response keeps the existing saved version; that response stays in the current session until a later changed revision saves the recent history. The current draft carries up to ten recent follow-up exchanges.

Files live in `~/Documents/Landwise/Applications`, outside the repository, with private folder/file permissions. Each folder holds `application.json` plus version folders with the original resume, JD, tailored text and report. This is the local operating-system user's library, accessible in the local app independently of which ChatGPT account is selected. It is **not** cloud storage, a separate Landwise account, or cross-device sync. Deleting a folder in the app deletes its local versions and progress. If saving fails, the finished draft remains available for export and **Save application** retries saving without another AI call.

The editor can replace only selected existing bullet lines (at most 35% rounded up, with a minimum allowance of one). It cannot replace the full resume, remove an experience or add a new role. Facts must stay with their original role/project. Before/after bullets are available in the fit report. Text without recognized bullet markers stays unchanged. The score uses extracted requirements: must-haves weigh twice as much, direct evidence earns full credit, related evidence half, and absent evidence zero. It is a source-evidence estimate, not an ATS score or a hiring prediction. Missing evidence is not proof that you lack a skill.

Typing and signing in do not start AI generation. An explicit analysis or transform sends the required resume/job text to OpenAI and uses your plan allowance. A transform normally makes three sequential requests to read the sources, match requirements and write the draft. If the draft exceeds the page limit, it makes at most one additional request to tighten the wording. Provider failures are not retried automatically. **Manage usage** opens ChatGPT’s controls. Career events and local PDF parsing work without sign-in.

Saved registrations can be selected after restarting. **Sign out** attempts to revoke the renewable session, clears local credentials, and retains the account/client mapping for reconnecting. If remote revocation cannot be confirmed, Landwise tells you to disconnect it in ChatGPT settings.

**Availability:** This integration follows OpenAI’s [locally hosted app flow](https://developers.openai.com/siwc/token-sharing-open-source). Paid or remotely hosted services need approval before offering ChatGPT plan usage; this local runtime is not a public multi-user authentication service. Claude does not generally authorize third-party products to use subscription login/rate limits without prior approval ([Claude Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview)), so Landwise does not present a nonfunctional Claude sign-in button.

Use **Career events** to find places to meet employers, check the organizer’s registration requirements, and return to **Resume studio** with a job description from a role you discover. Switching sections preserves your current resume and results.

The first visit to **Career events** requests browser location permission. If allowed, the closest cities appear first within the event and calendar groups. Distances are approximate straight-line distances to city centers, not venues or driving distances. Choose **Soonest first** to sort by date, or use the **Location** filter if location access is declined or unavailable. Returning to the tab does not request location again during the same visit; **Use my location** or **Update location** retries explicitly.

Location uses the browser's Geolocation API and needs HTTPS in production (localhost works for development). No Google Maps API key is required. Landwise rounds coordinates to two decimal places and keeps them only in memory for the current visit; it does not send them to the server or an external geocoding service.

### Maintaining the career directory

Listings are curated in `src/data/careerEvents.js`, not fetched automatically. Each record links to an original organizer website and includes the date its source was checked. Recheck dates, eligibility, venue, and registration on the source before updating `verifiedOn`. Add confirmed dates as `kind: 'event'`; use `kind: 'calendar'` for ongoing organizer resources without a confirmed date. Dated events leave the directory after their final day, using the visitor’s local date. Calendars remain available and should be reviewed periodically.

The directory runs without API credentials. Saved resource IDs stay in browser local storage; they do not sync across devices. The original organizer handles event registration.

---

## Self-Hosting / Development

If you want to run your own instance:

### 1. Clone the repo

```bash
git clone https://github.com/stanqiu111/landwise.git
cd landwise
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run locally

```bash
npm run dev
```

Open **http://127.0.0.1:5174** (use this exact host, not `localhost`, for the loopback OAuth callback). The API listens only on **127.0.0.1:3001**. No `.env` or provider API keys are required. Do not expose this runtime to other machines or host it as a shared service.

Optional configuration is shown in `.env.example`. If you change the frontend port, update Vite and `LANDWISE_APP_ORIGIN` together. If you change `PORT`, update Vite’s API proxy too.

ChatGPT credentials are stored outside the checkout under `~/.config/landwise` by default, with owner-only directory/file permissions. Set `LANDWISE_AUTH_DIR` to use another private directory. The stable host identifier and registrations are reused; only one Landwise process may use a credential directory at a time. Tokens never enter browser storage or application logs. Browser cookies identify local sessions; state, nonce, PKCE, signature verification, origin checks, and CSRF protection guard sign-in and AI requests.


---

## How It Works

Landwise runs a multi-phase AI pipeline on every transform:

```
Upload resume or paste text → Set page limit → Add job description
                                                ↓
                           Read sources → Match evidence → Write draft
                                                ↓
                          Check facts, completeness and rendered pages
                                                ↓
                   If too long: one concise edit, then check again
                                                ↓
                              Preview → Download PDF or DOCX
```

**Evidence-first tailoring:** the writer is instructed to use only source resume facts. Requirements the resume cannot support are surfaced as a skills gap.

PDF exports use the same page measurement as validation, with readable 10.5–11 pt body text. Oversized drafts are rejected instead of cut off or exported with extra pages. Word exports use matching wrapping and explicit page breaks, but fonts and later edits can change Word pagination; use PDF when the exact page count matters.

The app uses prompt and validation improvements rather than model fine-tuning. The writer receives the complete original resume, while retrieval identifies evidence to emphasize. Claimed evidence must quote source text, and limited bullet replacements are checked before being applied to the original text. Bullet edits cannot change source metrics. The finished draft is checked for contact details, education, new numeric claims and page count. Review the result before submitting it; these checks cannot prove every sentence is accurate.

Run `npm test`, `npm run lint`, and `npm run build` when changing the pipeline. See [QUALITY.md](./QUALITY.md) for writing rules, evaluation cases, and the GitHub projects that informed the approach.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical breakdown.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Loopback API port; default `3001` |
| `LANDWISE_APP_ORIGIN` | No | Exact local frontend origin; default `http://127.0.0.1:5174` |
| `LANDWISE_AUTH_DIR` | No | Private credential directory; default `~/.config/landwise` |

Provider API-key variables are not used for the resume workflow.

---

## Project Structure

```
landwise/
├── server.js              # Express API + full AI pipeline
├── server/
│   ├── chatgpt-auth.js    # Local OAuth, protected accounts, refresh and revocation
│   ├── chatgpt-inference.js # Authorized model catalog and Responses streaming
│   ├── rag.js             # Local chunking and TF-IDF retrieval
│   └── schemas.js         # Zod validation schemas
├── src/
│   ├── App.jsx            # Root component + state
│   ├── App.css            # All styles
│   └── components/
│       ├── InputPanel.jsx           # Resume upload + JD input
│       ├── OutputPanel.jsx          # Results, tabs, export
│       ├── ResumeAnalysis.jsx       # Resume quality analysis
│       ├── ClaimCoverage.jsx        # Requirement coverage bar
│       └── UnsupportedRequirements.jsx
├── .env.example           # Environment variable template
└── ARCHITECTURE.md        # Full technical architecture
```

---

## License

MIT
