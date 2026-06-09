/**
 * Resume chunking + retrieval
 *
 * Public API consumed by server.js:
 *   chunkResume(text)           → Chunk[]
 *   buildRetrievalIndex(chunks) → Promise<RetrievalIndex>
 *
 * A RetrievalIndex exposes:
 *   index.type                              → 'embedding' | 'tfidf'
 *   index.retrieve(queries, topKPerQuery)   → Promise<Chunk[]>
 *
 * Strategy selection (automatic):
 *   1. Embedding-based (OpenAI) — if OPENAI_API_KEY is present and the call succeeds
 *   2. TF-IDF fallback          — if the key is absent or any embedding call fails
 *
 * The TF-IDF functions are kept as named exports so they remain usable in tests
 * and as an explicit fallback path.
 */

import { embedBatch } from './embeddings.js';

// ─── Chunking ────────────────────────────────────────────────────────────────

const SECTION_RE = /^(summary|objective|profile|about|experience|work history|professional experience|employment|education|skills|technical skills|core competencies|projects|certifications|certificates|achievements|awards|publications|languages|volunteer|highlights)[:\s]*/i;

export function chunkResume(text) {
  const lines = text.split('\n');
  const chunks = [];
  let current = { title: 'Header', lines: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length < 60 && SECTION_RE.test(trimmed)) {
      if (current.lines.some(l => l.trim())) {
        chunks.push({ title: current.title, content: current.lines.join('\n').trim() });
      }
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.lines.some(l => l.trim())) {
    chunks.push({ title: current.title, content: current.lines.join('\n').trim() });
  }

  if (chunks.length <= 1) return splitByParagraph(text);
  return chunks.filter(c => c.content.length > 20);
}

function splitByParagraph(text) {
  return text
    .split(/\n{2,}/)
    .map((para, i) => ({ title: `Block ${i + 1}`, content: para.trim() }))
    .filter(c => c.content.length > 20);
}

// ─── TF-IDF (fallback + standalone) ──────────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

export function buildTfidf(chunks) {
  const docTokens = chunks.map(c => tokenize(`${c.title} ${c.content}`));
  const N = docTokens.length;

  const df = {};
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) {
      df[token] = (df[token] || 0) + 1;
    }
  }

  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }

  const vectors = docTokens.map(tokens => {
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    const vec = {};
    for (const [term, count] of Object.entries(tf)) {
      vec[term] = (count / tokens.length) * (idf[term] || 1);
    }
    return vec;
  });

  return { vectors, idf };
}

function cosineTfidf(a, b) {
  let dot = 0, na = 0, nb = 0;
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of all) {
    const va = a[k] || 0, vb = b[k] || 0;
    dot += va * vb; na += va * va; nb += vb * vb;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function queryVector(text, idf) {
  const tokens = tokenize(text);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const vec = {};
  for (const [term, count] of Object.entries(tf)) {
    vec[term] = (count / tokens.length) * (idf[term] || 0.5);
  }
  return vec;
}

export function retrieveChunks(query, chunks, tfidf, topK = 4) {
  const qVec = queryVector(query, tfidf.idf);
  return chunks
    .map((chunk, i) => ({ chunk, score: cosineTfidf(qVec, tfidf.vectors[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(s => s.score > 0)
    .map(s => s.chunk);
}

export function retrieveForRequirements(requirements, chunks, tfidf, topKPerReq = 3) {
  const seen = new Set();
  const result = [];
  for (const req of requirements) {
    for (const chunk of retrieveChunks(req, chunks, tfidf, topKPerReq)) {
      if (!seen.has(chunk.title + chunk.content)) {
        seen.add(chunk.title + chunk.content);
        result.push(chunk);
      }
    }
  }
  return result;
}

// ─── Embedding-based vector index ────────────────────────────────────────────

function cosineEmbed(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

class VectorIndex {
  constructor(chunks, embeddings) {
    this._entries = chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] }));
  }

  /** Returns top-K chunks most similar to queryEmbedding (number[]). */
  query(queryEmbedding, topK = 4) {
    return this._entries
      .map(({ chunk, embedding }) => ({ chunk, score: cosineEmbed(queryEmbedding, embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(e => e.chunk);
  }
}

// ─── Public retrieval API ─────────────────────────────────────────────────────

/**
 * Build a retrieval index over the given resume chunks.
 * Attempts embedding-based indexing first; silently falls back to TF-IDF.
 *
 * Usage in server.js:
 *   const index = await buildRetrievalIndex(chunks);
 *   const relevant = await index.retrieve(queries, 3);
 *
 * @param {Array<{title: string, content: string}>} chunks
 * @returns {Promise<{type: string, retrieve: Function}>}
 */
export async function buildRetrievalIndex(chunks) {
  const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
  const chunkEmbeddings = await embedBatch(chunkTexts);

  if (chunkEmbeddings && chunkEmbeddings.length === chunks.length) {
    const vecIndex = new VectorIndex(chunks, chunkEmbeddings);

    return {
      type: 'embedding',

      async retrieve(queries, topKPerQuery = 3) {
        if (!queries.length) return chunks;

        const queryEmbeddings = await embedBatch(queries);
        if (!queryEmbeddings) {
          // Embedding call failed mid-flight — fall back to TF-IDF for this request
          console.warn('[rag] Query embedding failed; falling back to TF-IDF');
          const tfidf = buildTfidf(chunks);
          return retrieveForRequirements(queries, chunks, tfidf, topKPerQuery);
        }

        const seen = new Set();
        const result = [];
        for (const qEmb of queryEmbeddings) {
          for (const chunk of vecIndex.query(qEmb, topKPerQuery)) {
            const key = `${chunk.title}\0${chunk.content}`;
            if (!seen.has(key)) {
              seen.add(key);
              result.push(chunk);
            }
          }
        }
        return result.length ? result : chunks;
      },
    };
  }

  // OPENAI_API_KEY absent or embedBatch returned null/wrong-length
  if (chunkEmbeddings === null) {
    console.log('[rag] OPENAI_API_KEY not set — using TF-IDF retrieval');
  } else {
    console.warn('[rag] Embedding count mismatch — using TF-IDF retrieval');
  }

  const tfidf = buildTfidf(chunks);
  return {
    type: 'tfidf',

    async retrieve(queries, topKPerQuery = 3) {
      return queries.length
        ? retrieveForRequirements(queries, chunks, tfidf, topKPerQuery)
        : chunks;
    },
  };
}
