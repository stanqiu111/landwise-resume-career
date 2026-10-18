import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { jsPDF } from 'jspdf';
import { createHostedPDFParser, HOSTED_PDF_LIMITS, parseHostedPDF } from '../server/hosted-pdf.js';

const MIB = 1024 * 1024;
const minimalInput = () => Buffer.from('%PDF-1.7\nprivate resume contents');
const matches = (code, status) => (error) => {
  assert.equal(error.code, code);
  if (status) assert.equal(error.status, status);
  assert.doesNotMatch(error.message, /private resume|sensitive internal|stack trace/);
  return true;
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function harness({ readRss = () => 50 * MIB, termination } = {}) {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.terminations = 0;
      this.stdout = { resume: () => { this.stdoutDrained = true; } };
      this.stderr = { resume: () => { this.stderrDrained = true; } };
      workers.push(this);
    }
    terminate() {
      this.terminations += 1;
      return termination || Promise.resolve(0);
    }
  }
  return { workers, parse: createHostedPDFParser({ WorkerClass: FakeWorker, readRss }) };
}

function documentBuffer({ pages = 1, text = 'Alex Rivera — Student\nBuilt an accessible student portal.' } = {}) {
  const doc = new jsPDF({ compress: true });
  for (let page = 0; page < pages; page += 1) {
    if (page) doc.addPage();
    doc.text(text, 10, 15);
  }
  return Buffer.from(doc.output('arraybuffer'));
}

test('real worker reads a PDF and preserves page text and input ownership', async () => {
  const buffer = documentBuffer({ pages: 2, text: 'Alex Rivera\nBuilt accessible student tools.' });
  const original = Buffer.from(buffer);
  const result = await parseHostedPDF(buffer);
  assert.equal(result.pageCount, 2);
  assert.equal((result.text.match(/Built accessible student tools/g) || []).length, 2);
  assert.deepEqual(buffer, original, 'the caller retains its upload buffer');
});

test('real worker rejects documents over 20 pages', async () => {
  await assert.rejects(parseHostedPDF(documentBuffer({ pages: 21 })), matches('pdf_page_limit', 400));
});

test('real worker stops on the cumulative 30,000-character limit', async () => {
  const doc = new jsPDF({ compress: true });
  doc.setFontSize(1);
  for (let line = 0; line < 205; line += 1) doc.text('A'.repeat(150), 2, 2 + line);
  await assert.rejects(createHostedPDFParser()(Buffer.from(doc.output('arraybuffer'))), matches('invalid_resume', 400));
});

test('real worker sanitizes invalid PDF diagnostics', async () => {
  await assert.rejects(createHostedPDFParser()(minimalInput()), matches('invalid_pdf', 400));
});

test('validation rejects oversized, non-PDF and pre-aborted input without a worker', async () => {
  const { parse, workers } = harness();
  await assert.rejects(parse(Buffer.from('private resume')), matches('invalid_pdf', 400));
  await assert.rejects(parse('%PDF-not bytes'), matches('invalid_pdf', 400));
  const large = Buffer.alloc(HOSTED_PDF_LIMITS.maxBytes + 1);
  large.write('%PDF-');
  await assert.rejects(parse(large), matches('input_too_large', 413));
  await assert.rejects(parse(minimalInput(), { signal: AbortSignal.abort(new Error('private resume')) }), matches('pdf_cancelled', 499));
  for (const timeoutMs of [0, -1, 10001, 1.5, '1']) await assert.rejects(parse(minimalInput(), { timeoutMs }), TypeError);
  assert.equal(workers.length, 0);
});

test('workers have bounded heaps, no inherited secrets or flags, and discarded diagnostics', async () => {
  const { parse, workers } = harness();
  const input = minimalInput();
  const pending = parse(input);
  const worker = workers[0];
  assert.match(worker.url.pathname, /\/server\/hosted-pdf-worker\.js$/);
  assert.deepEqual(worker.options.resourceLimits, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 });
  assert.deepEqual(worker.options.env, {});
  assert.deepEqual(worker.options.execArgv, []);
  assert.equal(worker.options.stdout, true);
  assert.equal(worker.options.stderr, true);
  assert.equal(worker.stdoutDrained, true);
  assert.equal(worker.stderrDrained, true);
  assert.notEqual(worker.options.workerData.data.buffer, input.buffer);
  assert.equal(worker.options.transferList[0], worker.options.workerData.data.buffer);
  worker.emit('message', { ok: true, result: { text: 'Student', pageCount: 1, internal: 'sensitive internal' } });
  assert.deepEqual(await pending, { text: 'Student', pageCount: 1 });
  assert.equal(worker.terminations, 1);
});

test('timeout terminates a stuck worker and rejects promptly', async () => {
  const { parse, workers } = harness();
  await assert.rejects(parse(minimalInput(), { timeoutMs: 5 }), matches('pdf_timeout', 408));
  assert.equal(workers[0].terminations, 1);
});

test('abort terminates parsing without reflecting its reason', async () => {
  const { parse, workers } = harness();
  const controller = new AbortController();
  const pending = parse(minimalInput(), { signal: controller.signal });
  controller.abort(new Error('private resume stack trace'));
  await assert.rejects(pending, matches('pdf_cancelled', 499));
  assert.equal(workers[0].terminations, 1);
});

test('a process admits one parser and retains the slot until termination finishes', async () => {
  let terminated;
  const termination = new Promise(resolve => { terminated = resolve; });
  const { parse, workers } = harness({ termination });
  const first = parse(minimalInput());
  await assert.rejects(parse(minimalInput()), matches('pdf_busy', 429));
  workers[0].emit('error', new Error('sensitive internal stack trace'));
  await assert.rejects(first, matches('invalid_pdf', 400));
  await assert.rejects(parse(minimalInput()), matches('pdf_busy', 429));
  terminated(0);
  await nextTurn();
  const next = parse(minimalInput());
  workers[1].emit('message', { ok: true, result: { text: 'Second resume', pageCount: 1 } });
  assert.equal((await next).text, 'Second resume');
  assert.equal(workers.length, 2, 'each request uses a fresh worker');
});

test('late termination notifications cannot free a newer worker slot', async () => {
  const { parse, workers } = harness();
  const first = parse(minimalInput());
  workers[0].emit('exit', 1);
  const next = parse(minimalInput());
  await assert.rejects(first, matches('invalid_pdf', 400));
  await nextTurn();
  await assert.rejects(parse(minimalInput()), matches('pdf_busy', 429));
  workers[1].emit('message', { ok: true, result: { text: 'Still owned', pageCount: 1 } });
  assert.equal((await next).text, 'Still owned');
});

test('worker failures, invalid messages and out-of-memory events are sanitized', async () => {
  const cases = [
    ['error', new Error('sensitive internal stack trace'), 'invalid_pdf'],
    ['error', Object.assign(new Error('private resume'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }), 'pdf_resource_limit'],
    ['messageerror', new Error('private resume'), 'invalid_pdf'],
    ['exit', 0, 'invalid_pdf'],
    ['message', { ok: false, code: 'sensitive internal' }, 'invalid_pdf'],
    ['message', { ok: true, result: { text: 'A'.repeat(30001), pageCount: 1 } }, 'invalid_pdf'],
    ['message', { ok: true, result: { text: '', pageCount: 21 } }, 'invalid_pdf'],
  ];
  for (const [event, payload, code] of cases) {
    const { parse, workers } = harness();
    const pending = parse(minimalInput());
    workers[0].emit(event, payload);
    await assert.rejects(pending, matches(code));
  }
});

test('RSS monitor terminates expansion and absolute process pressure', async () => {
  for (const [baseline, pressure] of [[50 * MIB, 250 * MIB], [400 * MIB, 513 * MIB]]) {
    let readings = 0;
    const { parse, workers } = harness({ readRss: () => readings++ ? pressure : baseline });
    await assert.rejects(parse(minimalInput()), matches('pdf_resource_limit', 413));
    assert.equal(workers[0].terminations, 1);
  }
});

test('memory pressure or missing measurement prevents spawning a worker', async () => {
  for (const reading of [513 * MIB, NaN, -1, undefined]) {
    const { parse, workers } = harness({ readRss: () => reading });
    await assert.rejects(parse(minimalInput()), matches('pdf_unavailable', 503));
    assert.equal(workers.length, 0);
  }
});

test('real worker startup is interruptible without parsing on the main thread', async () => {
  await assert.rejects(createHostedPDFParser()(documentBuffer(), { timeoutMs: 1 }), matches('pdf_timeout', 408));
});
