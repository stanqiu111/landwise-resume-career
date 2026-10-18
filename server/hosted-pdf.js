import { Worker } from 'node:worker_threads';

const MIB = 1024 * 1024;
export const HOSTED_PDF_LIMITS = Object.freeze({
  maxBytes: 2 * MIB,
  maxPages: 20,
  maxCharacters: 30000,
  timeoutMs: 10000,
  maxProcessRssBytes: 512 * MIB,
  maxRssGrowthBytes: 192 * MIB,
  memoryPollMs: 50,
  resourceLimits: Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }),
});

const errors = Object.freeze({
  invalid_pdf: [400, 'Could not read this PDF. Try a different file or paste the text.'],
  pdf_page_limit: [400, 'Choose a resume with 1–20 pages.'],
  invalid_resume: [400, 'This PDF contains more than 30,000 characters. Upload a shorter resume.'],
  input_too_large: [413, 'Choose a PDF under 2 MB or paste your resume text.'],
  pdf_timeout: [408, 'This PDF took too long to read. Try a simpler PDF or paste the text.'],
  pdf_cancelled: [499, 'PDF processing was cancelled.'],
  pdf_resource_limit: [413, 'This PDF needs too many resources to read. Try a simpler PDF or paste the text.'],
  pdf_busy: [429, 'Another PDF is being read. Please try again shortly, or paste your resume text.'],
  pdf_unavailable: [503, 'PDF reading is temporarily unavailable. Please paste your resume text.'],
});
const fail = (code) => Object.assign(new Error(errors[code][1]), { status: errors[code][0], code });
const workerErrorCodes = new Set(['invalid_pdf', 'pdf_page_limit', 'invalid_resume']);

function validPDF(data) {
  return data instanceof Uint8Array && data.length >= 5
    && data[0] === 37 && data[1] === 80 && data[2] === 68 && data[3] === 70 && data[4] === 45;
}

/**
 * A fresh, credential-free worker parses each PDF; at most one worker runs per
 * server process. Heap limits do not cover ArrayBuffer/native allocations. The
 * RSS checks are best-effort process-pressure protection, not an OS sandbox or
 * a hard memory ceiling: an allocation can grow between the 50 ms samples.
 * WorkerClass/readRss are server-only dependencies for deterministic tests.
 */
export function createHostedPDFParser({ WorkerClass = Worker, readRss = () => process.memoryUsage.rss() } = {}) {
  if (typeof WorkerClass !== 'function' || typeof readRss !== 'function') throw new TypeError('Invalid PDF parser configuration.');
  let active = false;

  return async function parseHostedPDF(buffer, { signal, timeoutMs = HOSTED_PDF_LIMITS.timeoutMs } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HOSTED_PDF_LIMITS.timeoutMs) {
      throw new TypeError('The PDF deadline must be between 1 and 10000 milliseconds.');
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('An AbortSignal is required.');
    if (!(buffer instanceof Uint8Array) || !validPDF(buffer)) throw fail('invalid_pdf');
    if (buffer.byteLength > HOSTED_PDF_LIMITS.maxBytes) throw fail('input_too_large');
    if (signal?.aborted) throw fail('pdf_cancelled');
    if (active) throw fail('pdf_busy');

    let initialRss;
    try { initialRss = readRss(); } catch { throw fail('pdf_unavailable'); }
    if (!Number.isSafeInteger(initialRss) || initialRss < 0 || initialRss > HOSTED_PDF_LIMITS.maxProcessRssBytes) throw fail('pdf_unavailable');
    active = true;

    // Do not transfer a caller-owned Buffer pool or detach the upload buffer.
    const data = new Uint8Array(buffer);
    let worker;
    try {
      // Keep this static URL: Vercel's Node file tracing can discover the worker.
      worker = new WorkerClass(new URL('./hosted-pdf-worker.js', import.meta.url), {
        workerData: { data }, transferList: [data.buffer],
        resourceLimits: { ...HOSTED_PDF_LIMITS.resourceLimits },
        env: {}, execArgv: [], stdout: true, stderr: true,
      });
    } catch {
      active = false;
      throw fail('pdf_unavailable');
    }
    // Library warnings may contain document data. Drain them without logging.
    worker.stdout?.resume();
    worker.stderr?.resume();

    return new Promise((resolve, reject) => {
      let settled = false;
      let released = false;
      let timer;
      let memoryTimer;
      const release = () => { if (!released) { released = true; active = false; } };
      const cancel = () => finish(fail('pdf_cancelled'));
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(memoryTimer);
        signal?.removeEventListener('abort', cancel);
        // Reject promptly on timeout/abort, but keep the slot occupied until
        // termination completes so a slow teardown cannot multiply workers.
        let termination;
        try { termination = worker.terminate(); }
        catch { if (error) reject(error); else reject(fail('pdf_unavailable')); return; }
        const stopped = Promise.resolve(termination).then(release);
        if (error) {
          stopped.catch(() => {});
          reject(error);
        } else {
          stopped.then(() => resolve(result), () => reject(fail('pdf_unavailable')));
        }
      }
      worker.on('message', (message) => {
        if (message?.ok === false) return finish(fail(workerErrorCodes.has(message.code) ? message.code : 'invalid_pdf'));
        const result = message?.result;
        if (message?.ok !== true || !result || typeof result.text !== 'string'
          || result.text.length > HOSTED_PDF_LIMITS.maxCharacters || !Number.isInteger(result.pageCount)
          || result.pageCount < 1 || result.pageCount > HOSTED_PDF_LIMITS.maxPages) return finish(fail('invalid_pdf'));
        finish(null, { text: result.text, pageCount: result.pageCount });
      });
      worker.on('error', (error) => finish(fail(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'pdf_resource_limit' : 'invalid_pdf')));
      worker.on('messageerror', () => finish(fail('invalid_pdf')));
      worker.once('exit', () => { release(); if (!settled) finish(fail('invalid_pdf')); });
      timer = setTimeout(() => finish(fail('pdf_timeout')), timeoutMs);
      memoryTimer = setInterval(() => {
        let rss;
        try { rss = readRss(); } catch { return finish(fail('pdf_unavailable')); }
        if (!Number.isSafeInteger(rss) || rss < 0) return finish(fail('pdf_unavailable'));
        if (rss > HOSTED_PDF_LIMITS.maxProcessRssBytes || rss - initialRss > HOSTED_PDF_LIMITS.maxRssGrowthBytes) {
          finish(fail('pdf_resource_limit'));
        }
      }, HOSTED_PDF_LIMITS.memoryPollMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  };
}

export const parseHostedPDF = createHostedPDFParser();
