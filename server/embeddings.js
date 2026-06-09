/**
 * Embedding provider: OpenAI text-embedding-3-small
 *
 * Why OpenAI and not Anthropic:
 *   Anthropic's API is generation-only — there is no embeddings endpoint in the
 *   current SDK. OpenAI's text-embedding-3-small is cheap ($0.02 / 1M tokens),
 *   fast, 1536-dimensional, and has strong semantic understanding for technical text.
 *
 * Swap guide:
 *   To use Voyage AI, Cohere, or a local model, replace embedBatch() with any
 *   function that accepts string[] and returns Promise<number[][] | null>.
 *   Nothing else in the codebase needs to change.
 *
 * Required env vars:
 *   OPENAI_API_KEY   — enables embedding-based RAG (falls back to TF-IDF without it)
 *   EMBEDDING_MODEL  — optional, defaults to text-embedding-3-small
 */

import OpenAI from 'openai';

const MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key });
  return _client;
}

/**
 * Generate embeddings for a batch of texts.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][] | null>} One vector per input text, or null if
 *   embeddings are unavailable (no API key or provider error).
 */
export async function embedBatch(texts) {
  if (!texts.length) return [];

  const client = getClient();
  if (!client) return null; // no key → caller falls back to TF-IDF

  try {
    const res = await client.embeddings.create({
      model: MODEL,
      input: texts,
      encoding_format: 'float',
    });
    // OpenAI returns results in any order when batched; sort by index to be safe
    return res.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  } catch (err) {
    console.warn('[embeddings] batch call failed:', err.message);
    return null;
  }
}
