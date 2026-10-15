const SECTION_TITLES = new Set([
  'SUMMARY', 'PROFILE', 'PROFESSIONAL SUMMARY', 'SKILLS', 'TECHNICAL SKILLS',
  'EXPERIENCE', 'WORK EXPERIENCE', 'PROFESSIONAL EXPERIENCE', 'PROJECTS',
  'EDUCATION', 'CERTIFICATIONS', 'CERTIFICATES', 'AWARDS', 'PUBLICATIONS',
  'VOLUNTEER EXPERIENCE', 'LANGUAGES',
  'ADDITIONAL EXPERIENCE', 'RELEVANT EXPERIENCE', 'RESEARCH EXPERIENCE',
]);

export function parseResumeLines(text) {
  let started = false;
  let inHeader = true;
  return text.split(/\r?\n/).map(raw => raw.trim()).filter(Boolean).map(line => {
    if (!started) {
      started = true;
      return { type: 'name', text: line };
    }
    const title = line.replace(/:$/, '').toUpperCase();
    if (SECTION_TITLES.has(title)) {
      inHeader = false;
      return { type: 'section', text: title };
    }
    if (/^[-•*]\s+/.test(line)) return { type: 'bullet', text: line.replace(/^[-•*]\s+/, '') };
    return { type: inHeader ? 'contact' : 'body', text: line };
  });
}
