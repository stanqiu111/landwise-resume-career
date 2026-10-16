// Keep every source entry and its order. The model can only replace selected
// existing bullets; it cannot regenerate or silently drop entire experiences.
export function editableResumeLines(resume) {
  let section = '';
  let context = '';
  return resume.split(/\r?\n/).flatMap((text, index) => {
    if (/^[A-Z][A-Z /&]{2,}:?$/.test(text.trim())) section = text.trim();
    if (!/^\s*[-•*]\s+/.test(text)) { if (text.trim()) context = text.trim(); return []; }
    return [{ id: `line-${index}`, text, section, context }];
  });
}

export function applyResumeEdits(resume, edits = []) {
  if (!Array.isArray(edits)) throw new Error('Invalid resume edits.');
  const lines = resume.split(/\r?\n/);
  const editable = editableResumeLines(resume);
  if (edits.length > Math.max(1, Math.ceil(editable.length * 0.35))) throw new Error('Too many resume edits.');
  const seen = new Set();
  for (const edit of edits) {
    const source = editable.find(line => line.id === edit.lineId);
    if (!source || seen.has(edit.lineId) || typeof edit.replacement !== 'string') throw new Error('Invalid edit target.');
    const replacement = edit.replacement.trim().replace(/^[-•*]\s+/, '');
    if (!replacement || /[\r\n]/.test(replacement)) throw new Error('An edit must preserve one existing bullet.');
    // Keep edits small and prevent an oversized new narrative under a real role.
    if (replacement.split(/\s+/).length > source.text.split(/\s+/).length + 8) throw new Error('An edit expands the original experience too far.');
    const beforeNumbers = source.text.match(/\d+(?:[.,]\d+)?[%+]?/g) || [];
    const afterNumbers = replacement.match(/\d+(?:[.,]\d+)?[%+]?/g) || [];
    if (beforeNumbers.some(n => !afterNumbers.includes(n)) || afterNumbers.some(n => !beforeNumbers.includes(n))) throw new Error('An edit changes source metrics.');
    seen.add(edit.lineId);
    lines[Number(edit.lineId.slice(5))] = source.text.match(/^\s*[-•*]\s+/)[0] + replacement;
  }
  return lines.join('\n');
}

export function rejectUnsupportedAdditions(original, draft, requirements, matches) {
  const contains = (text, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
  };
  for (const requirement of requirements) {
    const match = matches.find(item => item.requirement_id === requirement.id);
    if (match?.claim_ids.length) continue;
    for (const keyword of requirement.keywords || []) {
      if (keyword.trim().length > 1 && !contains(original, keyword) && contains(draft, keyword)) {
        throw new Error('An edit adds an unsupported job keyword.');
      }
    }
  }
}
