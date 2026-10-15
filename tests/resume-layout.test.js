import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { Packer } from 'docx';
import { layoutResume, resumePDF, estimateResumePages, ResumeLengthError, PAGE } from '../src/resumeLayout.js';
import { resumeDOCX } from '../src/resumeDocx.js';
import { parseResumeLines } from '../src/resumeDocument.js';
import { studentResume, denseResume, twoPageResume, overflowingResume } from './fixtures/resumes.js';

test('one-page PDF stays one page and retains all source text', async () => {
  const doc = resumePDF(studentResume, 1);
  assert.equal(doc.getNumberOfPages(), 1);
  const parser = new PDFParse({ data: new Uint8Array(doc.output('arraybuffer')) });
  try {
    const text = await parser.getText({ pageJoiner: '' });
    assert.equal(text.total, 1);
    const normalized = text.text.replace(/\s+/g, ' ');
    for (const line of parseResumeLines(studentResume)) assert.ok(normalized.includes(line.text), line.text);
  } finally { await parser.destroy(); }
});

test('a dense draft uses readable compact layout before adding a page', () => {
  assert.ok(estimateResumePages(denseResume) > 1);
  const layout = layoutResume(denseResume, 1);
  assert.equal(layout.pageCount, 1);
  assert.equal(layout.style.id, 'compact');
  assert.ok(layout.pages.flat().every(block => block.fontSize >= 10.5));
});

test('two-page resumes preserve all content and respect physical page boundaries', async () => {
  const layout = layoutResume(twoPageResume, 2);
  assert.equal(layout.pageCount, 2);
  const output = resumePDF(twoPageResume, 2);
  assert.equal(output.getNumberOfPages(), 2);
  for (const page of layout.pages) {
    assert.notEqual(page.at(-1).type, 'section', 'headings stay with following content');
    for (const block of page) assert.ok(block.top + block.lines.length * block.lineHeight <= PAGE.height - layout.style.margin);
  }
  const parser = new PDFParse({ data: new Uint8Array(output.output('arraybuffer')) });
  try {
    const text = await parser.getText({ pageJoiner: '' });
    assert.equal(text.total, 2);
    assert.equal((text.text.match(/Collaborated with product designers/g) || []).length, 30);
  } finally { await parser.destroy(); }
  assert.ok((await Packer.toBuffer(resumeDOCX(twoPageResume, 2))).length > 1000);
});

test('PDF and DOCX reject oversized drafts instead of truncating or shrinking indefinitely', () => {
  for (const exportResume of [resumePDF, resumeDOCX]) assert.throws(() => exportResume(overflowingResume, 1), ResumeLengthError);
  for (const limit of [0, -1, 1.5, 21, '1', null]) assert.throws(() => layoutResume(studentResume, limit));
});

test('very long paragraphs split across pages without losing lines', () => {
  const text = `Alex Rivera\nEXPERIENCE\n${'Built accessible dashboards and documented component behavior. '.repeat(240)}`;
  const layout = layoutResume(text, 10);
  assert.ok(layout.pageCount > 1);
  assert.equal(layout.pages.flat().flatMap(block => block.lines).join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
  assert.ok(layout.pages.every(page => page.length));
});
