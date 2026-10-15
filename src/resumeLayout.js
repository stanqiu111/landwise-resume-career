import { jsPDF } from 'jspdf';
import { parseResumeLines } from './resumeDocument.js';

export const PAGE = { width: 612, height: 792 };
const STYLES = [
  { id: 'standard', margin: 45, bodySize: 11, lineHeight: 14, paragraphGap: 3, sectionGap: 10, nameSize: 17 },
  { id: 'compact', margin: 36, bodySize: 10.5, lineHeight: 13, paragraphGap: 2, sectionGap: 7, nameSize: 16 },
];

export class ResumeLengthError extends Error {
  constructor(maxPages, actualPages) {
    super(`This draft needs ${actualPages} pages. It must fit within ${maxPages} ${maxPages === 1 ? 'page' : 'pages'} without removing details or making the text too small.`);
    this.code = 'resume_too_long';
    this.maxPages = maxPages;
    this.actualPages = actualPages;
  }
}

export function validPageLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 20;
}

// This is the single layout used by server validation, PDF and DOCX exports.
// Word gets these same wrapped lines, fixed spacing and explicit page breaks.
function measure(text, style) {
  const metrics = new jsPDF({ unit: 'pt', format: 'letter' });
  const paragraphs = parseResumeLines(text).map(line => {
    const bold = line.type === 'name' || line.type === 'section';
    const fontSize = line.type === 'name' ? style.nameSize : style.bodySize;
    const lineHeight = line.type === 'name' ? style.nameSize + 5 : style.lineHeight;
    const indent = line.type === 'bullet' ? 12 : 0;
    metrics.setFont('helvetica', bold ? 'bold' : 'normal');
    metrics.setFontSize(fontSize);
    // Leave a little room for Arial/Helvetica metric differences in Word.
    const lines = metrics.splitTextToSize(line.text, PAGE.width - 2 * style.margin - indent - 12);
    return { ...line, bold, fontSize, lineHeight, indent, lines };
  });
  const pages = [[]];
  let y = style.margin;
  const bottom = PAGE.height - style.margin - 8;
  function nextPage() { pages.push([]); y = style.margin; }
  paragraphs.forEach((paragraph, index) => {
    let before = pages.at(-1).length ? (paragraph.type === 'section' ? style.sectionGap : style.paragraphGap) : 0;
    const height = paragraph.lines.length * paragraph.lineHeight;
    const following = paragraph.type === 'section' && paragraphs[index + 1]
      ? style.paragraphGap + Math.min(2, paragraphs[index + 1].lines.length) * paragraphs[index + 1].lineHeight : 0;
    if (pages.at(-1).length && y + before + height + following > bottom) {
      nextPage(); before = 0;
    }
    let offset = 0;
    while (offset < paragraph.lines.length) {
      const available = Math.floor((bottom - y - before) / paragraph.lineHeight);
      if (available < 1) { nextPage(); before = 0; continue; }
      const lines = paragraph.lines.slice(offset, offset + available);
      pages.at(-1).push({ ...paragraph, lines, continuation: offset > 0, before, top: y + before });
      y += before + lines.length * paragraph.lineHeight;
      offset += lines.length;
      if (offset < paragraph.lines.length) { nextPage(); before = 0; }
    }
  });
  return { pages, style, pageCount: pages.length };
}

export function estimateResumePages(text) {
  return measure(text, STYLES[0]).pageCount;
}

export function layoutResume(text, maxPages) {
  if (!validPageLimit(maxPages)) throw new Error('Choose a page limit between 1 and 20.');
  let layout;
  for (const style of STYLES) {
    layout = measure(text, style);
    if (layout.pageCount <= maxPages) return layout;
  }
  throw new ResumeLengthError(maxPages, layout.pageCount);
}

export function resumePDF(text, maxPages) {
  const layout = layoutResume(text, maxPages);
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  layout.pages.forEach((blocks, pageIndex) => {
    if (pageIndex) doc.addPage();
    blocks.forEach(block => {
      doc.setFont('helvetica', block.bold ? 'bold' : 'normal');
      doc.setFontSize(block.fontSize);
      block.lines.forEach((line, index) => {
        const y = block.top + block.fontSize + index * block.lineHeight;
        if (block.type === 'bullet' && !block.continuation && index === 0) doc.text('•', layout.style.margin + 2, y);
        doc.text(line, layout.style.margin + block.indent, y);
      });
    });
  });
  return doc;
}
