# Landwise

**Land the job, wisely.**

Landwise is an AI-powered resume tailoring app. Paste your resume and a job description — Landwise rewrites your resume to match the role, surfaces your most relevant experience, and tells you exactly what's missing.

---

## Features

- **AI resume tailoring** — rewrites your resume around experience supported by your source text
- **Claim-based evidence checks** — extracts quoted claims from your resume and matches them to job requirements before rewriting
- **Embedding RAG** — uses semantic vector search to retrieve the most relevant resume sections per job requirement (falls back to TF-IDF if no OpenAI key)
- **Resume analysis** — instant feedback on resume quality, section scores, and suggested LLM/AI skills to add
- **Match score** — estimated keyword overlap after tailoring
- **Skills gap** — surfaces JD requirements your resume can't support, instead of inventing them
- **PDF & DOCX export** — download your tailored resume in either format
- **PDF upload** — drag-and-drop your existing resume as a PDF
- **Readable output** — clear section hierarchy and bullets in the preview, PDF, and DOCX

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8 |
| Backend | Node.js, Express 5 |
| AI — generation | Anthropic Claude (Haiku + Sonnet) |
| AI — embeddings | OpenAI `text-embedding-3-small` (optional) |
| PDF parse | `pdf-parse` |
| PDF export | `jsPDF` |
| DOCX export | `docx` |
| Schema validation | Zod |

---

## Using Landwise

No sign-up. No API keys. Just open the app and start tailoring.

1. Upload your resume (PDF) or paste it as text
2. Paste the job description
3. Click **Transform**

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

### 3. Set up environment variables

```bash
cp .env.example .env
```

Add your own API keys to `.env` — these stay on your server and are never exposed to users:

```env
# Required — https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-...

# Optional — enables semantic embedding retrieval (falls back to TF-IDF without it)
# https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-...
```

### 4. Run

```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## How It Works

Landwise runs a multi-phase AI pipeline on every transform:

```
Upload resume  →  Paste job description  →  Click Transform
                                                    │
                                   ┌────────────────▼──────────────────┐
                                   │  Phase 0    Deterministic guards   │
                                   │  Phase 0.5  LLM JD validation      │
                                   │  Phase 1    JD structured analysis │
                                   │  Phase 1.25 Embedding RAG          │
                                   │  Phase 1.5  Claim extraction       │
                                   │             + requirement matching  │
                                   │  Phase 2    Evidence-grounded      │
                                   │             resume rewrite          │
                                   └───────────────────────────────────┘
```

**Evidence-first tailoring:** the writer is instructed to use only source resume facts. Requirements the resume cannot support are surfaced as a skills gap.

The app uses prompt and validation improvements rather than model fine-tuning. The writer receives the complete original resume, while retrieval identifies evidence to emphasize. Claimed evidence must quote source text, and the finished draft is checked for contact details, education, and new numeric claims. Review the result before submitting it; these checks cannot prove every sentence is accurate.

Run `npm test`, `npm run lint`, and `npm run build` when changing the pipeline. See [QUALITY.md](./QUALITY.md) for writing rules, evaluation cases, and the GitHub projects that informed the approach.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical breakdown.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Powers all LLM calls (Claude Haiku + Sonnet) |
| `OPENAI_API_KEY` | No | Enables embedding-based RAG retrieval |
| `EMBEDDING_MODEL` | No | Override embedding model (default: `text-embedding-3-small`) |

---

## Project Structure

```
landwise/
├── server.js              # Express API + full AI pipeline
├── server/
│   ├── embeddings.js      # OpenAI embeddings client
│   ├── rag.js             # Chunking, VectorIndex, TF-IDF fallback
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
