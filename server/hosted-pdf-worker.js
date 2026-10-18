import { parentPort, workerData } from 'node:worker_threads';
// PDF.js loads this native dependency through createRequire at runtime. Keep a
// static edge so serverless tracing includes the platform-specific package.
import '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';
// PDF.js normally loads this via a dynamic workerSrc. A static import makes the
// dependency visible to serverless file tracing and uses the same worker heap.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

if (!parentPort) throw new Error('PDF parsing requires a worker.');

let parser;
try {
  const data = workerData?.data;
  if (!(data instanceof Uint8Array) || data.byteLength < 5 || data.byteLength > 2 * 1024 * 1024
    || data[0] !== 37 || data[1] !== 80 || data[2] !== 68 || data[3] !== 70 || data[4] !== 45) throw new Error('invalid_pdf');
  parser = new PDFParse({
    data, verbosity: 0, stopAtErrors: true, isEvalSupported: false,
    useWorkerFetch: false, useSystemFonts: false, useWasm: false,
    disableFontFace: true, disableAutoFetch: true, disableStream: true,
    disableRange: true, enableXfa: false, maxImageSize: 0,
  });
  const info = await parser.getInfo();
  if (!Number.isInteger(info.total) || info.total < 1 || info.total > 20) throw new Error('pdf_page_limit');
  let text = '';
  for (let page = 1; page <= info.total; page += 1) {
    const result = await parser.getText({ partial: [page], pageJoiner: '', parseHyperlinks: false });
    if (typeof result.text !== 'string') throw new Error('invalid_pdf');
    if (text.length + result.text.length > 30000) throw new Error('invalid_resume');
    text += result.text;
  }
  await parser.destroy();
  parser = null;
  parentPort.postMessage({ ok: true, result: { text, pageCount: info.total } });
} catch (error) {
  const code = ['pdf_page_limit', 'invalid_resume'].includes(error?.message) ? error.message : 'invalid_pdf';
  parentPort.postMessage({ ok: false, code });
} finally {
  try { await parser?.destroy(); } catch { /* Never expose parser diagnostics. */ }
  parentPort.close();
}
