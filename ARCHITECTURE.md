# Landwise — Architecture & Workflow

## User Flow

```
Upload / paste resume  →  Paste job description  →  Click Transform  →  View results
```

---

## Technical Flow

### 1. Resume Input (`InputPanel.jsx`)

Two paths:

**PDF upload** — user drops or clicks a file. The browser posts the raw binary to `POST /api/parse-pdf`. The server uses `pdf-parse` (`PDFParse` class) to extract plain text from the buffer, and sends `{ text }` back. The extracted text fills the editable textarea.

**Paste** — user types or pastes directly into the textarea. No server call needed.

---

### 2. Click Transform (`App.jsx → server.js`)

`handleTransform` in `App.jsx` validates both fields aren't empty, starts a `setInterval` that cycles through five loading phase labels every 3.5s (for UI feedback), then fires:

```
POST /api/transform  { resume, jobDescription }
```

The backend runs a **5-phase AI pipeline**:

---

### Phase 0 — Deterministic Pre-check (free, instant)

Before touching the LLM, the server rejects obviously bad input:
- JD shorter than 50 chars
- JD is only digits
- JD is less than 40% alphabetic characters

---

### Phase 0.5 — LLM Semantic Validation (Claude Haiku)

Sends the job description to Haiku with a yes/no prompt:
*"Is this a real job description?"*
Returns `{ valid: true }` or `{ valid: false, reason: "…" }`.
If invalid → 400 error back to the user immediately, no further API calls.

---

### Phase 1 — JD Structured Analysis (Claude Sonnet)

Extracts structured data from the job description:

```json
{
  "roleTitle": "Senior Python Engineer",
  "roleLevel": "senior",
  "requiredSkills": ["Python", "AWS", "microservices"],
  "niceToHaveSkills": ["Kafka", "Scala"],
  "mustHaveKeywords": ["Python", "backend", "cloud"]
}
```

Output guardrail: if `requiredSkills` is empty and `roleTitle` is blank, the JD wasn't parseable — returns a 400.

---

### Phase 1.25 — Embedding RAG (in-memory vector retrieval)

After the JD is parsed, the resume is chunked and the most relevant sections are retrieved before any LLM call touches the resume text.

**How it works:**

1. `chunkResume(text)` splits the resume on recognised section headers (Summary, Experience, Skills, Education, Projects, …). Falls back to paragraph-level chunks if no headers are detected.
2. `buildRetrievalIndex(chunks)` embeds every chunk with **OpenAI `text-embedding-3-small`** and builds an in-memory `VectorIndex` (an array of `{chunk, embedding: number[]}` entries).
3. All JD requirement strings (roleTitle, requiredSkills, niceToHaveSkills, mustHaveKeywords) are embedded in a **single batched call**.
4. For each query embedding, cosine similarity against all chunk embeddings returns the top-K chunks. Results are de-duplicated across all queries.
5. Only the retrieved chunks are passed to Phases 1.5 and 2 — Claude never sees irrelevant resume sections.

**Why embeddings over TF-IDF:**
TF-IDF requires exact or near-exact word overlap. Embeddings capture semantic meaning, so "React developer" retrieves chunks mentioning "frontend engineering", "component architecture", or "UI work" even if "React" isn't in those sections. This produces better claim coverage on semantically rich JDs.

**Fallback behaviour:**
If `OPENAI_API_KEY` is not set, or if the embedding API call fails at runtime, `buildRetrievalIndex` automatically falls back to the original TF-IDF index. The transform flow continues uninterrupted — the only difference is retrieval quality. The `index.type` field (`'embedding'` or `'tfidf'`) is logged at startup so the active strategy is always visible.

**Swap guide:**
To replace OpenAI with Voyage AI, Cohere, or a local model, edit `server/embeddings.js` only — change the `embedBatch` implementation. Nothing in `server/rag.js` or `server.js` needs to change. To add a persistent vector database (Qdrant, Pinecone, Chroma, Supabase pgvector), implement `VectorIndex` with the same `.query(embedding, topK)` interface backed by the DB client.

### Phase 1.5 — Claim Extraction & Matching (Claude Haiku × 3, 2 in parallel)

This is the hallucination-prevention layer. Two calls run in parallel:

**Call A** — Resume claim extraction:
Every verifiable fact in the resume becomes a typed claim:
```json
{ "id": "c1", "text": "Reduced latency by 40%", "type": "metric", "raw_phrase": "..." }
```

**Call B** — JD requirement extraction:
Every requirement from the JD becomes a structured requirement:
```json
{ "id": "req1", "text": "5+ years Python", "type": "skill", "priority": "must_have", "keywords": ["Python"] }
```

**Call C** (after A+B complete) — Matching:
Links each requirement to the best-matching resume claims:
```json
{
  "matches": [{ "requirement_id": "req1", "claim_ids": ["c3"], "match_type": "exact", "confidence": 0.9 }],
  "unsupported_requirements": ["Blockchain experience"]
}
```

Coverage score:
```
claim_coverage = covered_requirements / total_requirements × 100
```

---

### Phase 2 — Resume Tailoring (Claude Sonnet)

The final rewrite call receives:
- The structured JD analysis (Phase 1)
- The full claim analysis (Phase 1.5) — what the resume has vs. what the JD needs
- The original resume text

The system prompt explicitly forbids fabrication — *"rewrite ONLY using facts from the claim bank"*. Returns:

```json
{
  "transformedResume": "...full rewritten text...",
  "matchScore": 82,
  "keywordsAdded": ["microservices", "CI/CD"],
  "missingSkills": ["Java", "Spring Boot"],
  "improvements": ["Quantified AWS experience", "Added STAR format to leadership bullet"]
}
```

The server merges `claim_coverage`, `unsupported_requirements`, and the claim/match arrays into this result and sends everything back.

---

### 3. Display (`OutputPanel.jsx`)

The result renders across three tabs:

| Tab | Content |
|-----|---------|
| **Resume** | Full tailored resume as plain text — copyable, expandable, downloadable as PDF or DOCX |
| **Analysis** | Match score ring, keywords added (green chips), skills gap (yellow chips), list of changes made |
| **Claims** | Requirement coverage % with bar, list of JD requirements not backed by the resume |

**PDF export** — rendered client-side with `jsPDF`, paged manually by tracking `y` position.

**DOCX export** — built client-side with the `docx` library, each line becomes a `Paragraph`, packed to blob and downloaded.

---

## Architecture Diagram

```
Browser (React/Vite :5175)
   │
   ├── POST /api/parse-pdf  ──►  pdf-parse (Node)  ──►  plain text
   │
   └── POST /api/transform  ──►  Express (:3001)
                                   │
                                   ├── Phase 0:    deterministic guards (instant)
                                   ├── Phase 0.5:  Haiku  — is this a real JD?
                                   ├── Phase 1:    Sonnet — parse JD structure
                                   ├── Phase 1.25: Embedding RAG
                                   │               ├── chunkResume → section chunks
                                   │               ├── embedBatch(chunks)   → OpenAI (or TF-IDF fallback)
                                   │               ├── embedBatch(queries)  → OpenAI (or TF-IDF fallback)
                                   │               └── cosine similarity → relevant chunks
                                   ├── Phase 1.5:  Haiku×2 parallel — extract resume claims + JD requirements
                                   │               Haiku×1 serial   — match claims → requirements
                                   └── Phase 2:    Sonnet — rewrite resume using claim bank
```

---

## File Map

```
resume-transformer/
├── server.js              # Express API — all AI pipeline logic lives here
├── server/
│   ├── embeddings.js      # OpenAI embeddings client (swap here to change provider)
│   ├── rag.js             # chunkResume, VectorIndex, buildRetrievalIndex, TF-IDF fallback
│   └── schemas.js         # Zod schemas: ClaimSchema, JDRequirementSchema, ClaimMatchSchema
├── src/
│   ├── App.jsx            # Root component, state, handleTransform
│   ├── App.css            # All styles
│   ├── index.css          # #root base only
│   ├── main.jsx           # React entry point
│   └── components/
│       ├── InputPanel.jsx           # Resume upload + JD textarea
│       ├── OutputPanel.jsx          # Tabs, export buttons, result display
│       ├── ClaimCoverage.jsx        # Coverage % card + bar
│       └── UnsupportedRequirements.jsx  # Skills gap list
├── index.html
├── vite.config.js         # Vite dev server, proxies /api → :3001
└── package.json
```

---

## Key Design Decisions

**Why multiple phases instead of one big prompt?**
A single prompt asking Haiku/Sonnet to validate, parse, extract claims, match, and rewrite all at once produces lower-quality output and is harder to guard against hallucination. Breaking it into discrete steps lets each model call do one thing well, and lets the claim-matching step act as a factual constraint on the final rewrite.

**Why Haiku for claim extraction and Sonnet for tailoring?**
Claim extraction and matching are mechanical tasks — fast and cheap on Haiku. The final resume rewrite requires nuance, tone, and STAR-format reasoning, so Sonnet is used there and for the structured JD analysis.

**Why are the claim + JD extraction calls parallelized?**
They take completely independent inputs (resume vs. job description) so there is no reason to run them sequentially. Running both at once with `Promise.all` cuts roughly one full Haiku round-trip off the total latency.

**Why validate the JD before the heavy calls?**
The deterministic pre-check (Phase 0) catches garbage input with zero latency and zero API cost. The Haiku semantic check (Phase 0.5) catches plausible-looking non-JD text cheaply before Sonnet is invoked.
