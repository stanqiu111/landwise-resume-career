import { Document, Packer, Paragraph, TextRun, HeadingLevel, LineRuleType } from 'docx';
import { layoutResume, PAGE } from './resumeLayout.js';

export function resumeDOCX(text, maxPages) {
  const layout = layoutResume(text, maxPages);
  const children = layout.pages.flatMap((blocks, pageIndex) => blocks.map((block, blockIndex) => new Paragraph({
    heading: block.type === 'section' ? HeadingLevel.HEADING_2 : undefined,
    pageBreakBefore: pageIndex > 0 && blockIndex === 0,
    widowControl: false,
    keepNext: false,
    keepLines: true,
    indent: { left: block.indent * 20, hanging: block.type === 'bullet' && !block.continuation ? 12 * 20 : 0 },
    spacing: { before: block.before * 20, after: 0, line: block.lineHeight * 20, lineRule: LineRuleType.EXACT },
    children: block.lines.map((line, index) => new TextRun({
      text: `${block.type === 'bullet' && !block.continuation && index === 0 ? '•   ' : ''}${line}`,
      break: index > 0 ? 1 : 0,
      font: 'Arial', size: block.fontSize * 2, bold: block.bold, color: '000000',
    })),
  })));
  return new Document({
    styles: { default: { document: { run: { font: 'Arial', size: layout.style.bodySize * 2, color: '000000' }, paragraph: { spacing: { after: 0 } } } } },
    sections: [{ properties: { page: {
      size: { width: PAGE.width * 20, height: PAGE.height * 20 },
      margin: { top: layout.style.margin * 20, bottom: layout.style.margin * 20, left: layout.style.margin * 20, right: layout.style.margin * 20 },
    } }, children }],
  });
}

export const resumeDOCXBlob = (text, maxPages) => Packer.toBlob(resumeDOCX(text, maxPages));
