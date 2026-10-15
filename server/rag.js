/** Resume retrieval runs locally and does not consume API or ChatGPT usage. */

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

// Use local TF-IDF retrieval; ChatGPT plan access covers Responses, not embeddings.
export async function buildRetrievalIndex(chunks) {
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
