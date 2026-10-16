import { useEffect, useId, useRef, useState } from 'react';
import { resumePDF, estimateResumePages } from '../resumeLayout';
import { resumeDOCXBlob } from '../resumeDocx';
import ClaimCoverage from './ClaimCoverage';
import UnsupportedRequirements from './UnsupportedRequirements';
import TransformActivity from './TransformActivity';
import { parseResumeLines } from '../resumeDocument';
import './OutputPanel.css';

const TABS = [
  { id: 'resume', label: 'Resume' },
  { id: 'changes', label: 'Changes' },
  { id: 'evidence', label: 'Evidence' },
];

function ResumePreview({ text }) {
  return <article className="result-document" aria-label="Tailored resume preview">
    {parseResumeLines(text).map((line, index) => {
      if (line.type === 'name') return <h2 key={index}>{line.text}</h2>;
      if (line.type === 'section') return <h3 key={index}>{line.text}</h3>;
      if (line.type === 'bullet') return <p className="result-document-bullet" key={index}>{line.text}</p>;
      return <p className={line.type === 'contact' ? 'result-document-contact' : undefined} key={index}>{line.text}</p>;
    })}
  </article>;
}

function MatchScore({ score }) {
  const label = score >= 75 ? 'Strong match' : score >= 50 ? 'Moderate match' : 'Limited match';
  return <div className="result-match">
    <span className="result-match-number">{score}<small>/100</small></span>
    <div><strong>{label}</strong><span>Estimated keyword overlap</span></div>
  </div>;
}

function documentFilename(text) {
  const name = parseResumeLines(text).find(line => line.type === 'name')?.text || 'tailored';
  const slug = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70);
  return `${slug || 'tailored'}-resume`;
}

export default function OutputPanel({ result, loading, progress, error, retryIn = 0, stale = false }) {
  const [copyState, setCopyState] = useState('');
  const [tab, setTab] = useState('resume');
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const dialogRef = useRef(null);
  const copyTimer = useRef(null);
  const id = useId();
  const resumeText = result?.transformedResume || '';
  const hasResult = Boolean(resumeText);
  const filename = documentFilename(resumeText);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !dialog) return;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  async function handleCopy() {
    clearTimeout(copyTimer.current);
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(resumeText);
      setCopyState('copied');
      copyTimer.current = setTimeout(() => setCopyState(''), 2500);
    } catch {
      setCopyState('failed');
    }
  }

  function handleDownloadPDF() {
    try {
      setExportError('');
      resumePDF(resumeText, result.pageLimit ?? estimateResumePages(resumeText)).save(`${filename}.pdf`);
    } catch (downloadError) {
      setExportError(downloadError.message || 'The PDF could not be created. Please try again.');
    }
  }

  async function handleDownloadDOCX() {
    try {
      setExportError('');
      setExporting(true);
      const blob = await resumeDOCXBlob(resumeText, result.pageLimit ?? estimateResumePages(resumeText));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filename}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (downloadError) {
      setExportError(downloadError.message || 'The Word document could not be created. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  function handleTabKey(event) {
    const index = TABS.findIndex(item => item.id === tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].id);
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  }

  const caption = loading ? 'Working with your experience. Follow the progress below.'
    : hasResult ? 'Your tailored draft is ready. Review, then download.'
      : 'Your experience, shaped for the role you want.';

  return <section className="output-panel landwise-output" aria-labelledby={`${id}-title`}>
    <header className="result-card-header">
      <div>
        <p className="result-eyebrow">03 / Your result</p>
        <h2 id={`${id}-title`}>Your tailored resume</h2>
        <p className="result-caption">{caption}</p>
      </div>
      <span className={`result-status${loading ? ' is-working' : ''}`}>
        {loading ? 'In progress' : stale && hasResult ? 'Inputs changed' : hasResult ? 'Draft ready' : 'Ready when you are'}
      </span>
    </header>

    {!loading && error && <div className="result-notice result-error" role="alert">
      <strong>Tailoring didn’t finish</strong>
      <p>{error.message}</p>
      {retryIn > 0 && <p>Retry available in {retryIn}s. Your resume and job description are still here.</p>}
      {error.manageUsage && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage <span aria-hidden="true">↗</span></a>}
    </div>}

    {hasResult && <div className="result-toolbar">
      <div className="result-tabs" role="tablist" aria-label="Tailored resume views">
        {TABS.map(item => <button
          key={item.id}
          type="button"
          role="tab"
          id={`${id}-tab-${item.id}`}
          aria-controls={`${id}-panel-${item.id}`}
          aria-selected={tab === item.id}
          tabIndex={tab === item.id ? 0 : -1}
          className={tab === item.id ? 'is-active' : undefined}
          disabled={loading}
          onClick={() => setTab(item.id)}
          onKeyDown={handleTabKey}
        >{item.label}</button>)}
      </div>
      <div className="result-action-row">
        <span className="result-filename" title={filename}>{filename}</span>
        <div className="result-actions">
          <button type="button" onClick={() => setExpanded(true)} disabled={loading}>Full screen</button>
          <button type="button" onClick={handleCopy} disabled={loading || copyState === 'copying'}>{copyState === 'copied' ? 'Copied' : copyState === 'copying' ? 'Copying…' : 'Copy text'}</button>
          <button type="button" className="result-export" onClick={handleDownloadPDF} disabled={loading || exporting}>PDF</button>
          <button type="button" className="result-export" onClick={handleDownloadDOCX} disabled={loading || exporting} title="Editable Word document. Fonts and later edits can change pagination.">{exporting ? 'Saving…' : 'DOCX'}</button>
        </div>
      </div>
      {!loading && (result.pageCount || progress?.complete) && <p className="result-meta">
        {result.pageCount ? `${result.pageCount} ${result.pageCount === 1 ? 'page' : 'pages'}${result.pageLimit ? ` · Within your ${result.pageLimit}-page limit` : ''}` : ''}
        {result.pageCount && progress?.complete ? ' · ' : ''}
        {progress?.complete ? `Ready in ${Math.round(progress.elapsedMs / 1000)} seconds` : ''}
      </p>}
      <span className="result-sr-only" role="status">{copyState === 'copied' ? 'Resume copied to clipboard.' : ''}</span>
      {copyState === 'failed' && <p className="result-inline-error" role="alert">Copy wasn’t available. Open Full screen to select the text, or download your resume.</p>}
      {exportError && <p className="result-inline-error" role="alert">{exportError}</p>}
    </div>}

    {!loading && stale && hasResult && <p className="result-notice result-stale" role="status">Your inputs have changed. Tailor again to update this draft.</p>}

    <div className={`result-canvas${loading ? ' is-loading' : ''}${hasResult && tab !== 'resume' ? ' is-details' : ''}`} aria-busy={loading}>
      {loading && <TransformActivity progress={progress} />}

      {!loading && !hasResult && <div className="result-empty">
        <div className="result-empty-paper" aria-hidden="true"><span /><span /><span /><span /><span /></div>
        <h3>{error ? 'Your details are still here.' : 'A clearer resume starts here.'}</h3>
        <p>{error ? 'Review the message above, then try tailoring again.' : 'Add your resume and a job description. Your tailored draft will appear here.'}</p>
        <span>Review your draft before applying.</span>
      </div>}

      {!loading && hasResult && <div id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="result-tabpanel">
        {tab === 'resume' && <ResumePreview text={resumeText} />}
        {tab === 'changes' && <div className="analysis-content result-details">
          {result.matchScore != null && <MatchScore score={result.matchScore} />}
          {result.keywordsAdded?.length > 0 && <div className="analysis-section">
            <h3 className="analysis-title">Keywords added</h3>
            <div className="chip-group">{result.keywordsAdded.map((keyword, index) => <span key={index} className="chip chip-success">{keyword}</span>)}</div>
          </div>}
          {result.missingSkills?.length > 0 && <div className="analysis-section">
            <h3 className="analysis-title">Skills gap</h3>
            <div className="chip-group">{result.missingSkills.map((keyword, index) => <span key={index} className="chip chip-warn">{keyword}</span>)}</div>
            <p className="analysis-note">Required by the job but not in your resume. Consider these for a cover letter or learning plan.</p>
          </div>}
          {result.improvements?.length > 0 && <div className="analysis-section">
            <h3 className="analysis-title">Changes made</h3>
            <ul className="improvements-list">{result.improvements.map((improvement, index) => <li key={index}>{improvement}</li>)}</ul>
          </div>}
          {result.matchScore == null && !result.keywordsAdded?.length && !result.missingSkills?.length && !result.improvements?.length && <p className="result-details-empty">No change summary was provided for this draft.</p>}
        </div>}
        {tab === 'evidence' && <div className="claims-content result-details">
          {result.claim_coverage != null && <ClaimCoverage coverage={result.claim_coverage} />}
          {Array.isArray(result.unsupported_requirements) ? <UnsupportedRequirements items={result.unsupported_requirements} /> : <p className="result-details-empty">No requirement evidence was provided for this draft. Review every claim against your original resume.</p>}
        </div>}
      </div>}
    </div>

    <dialog className="result-dialog" ref={dialogRef} aria-labelledby={`${id}-dialog-title`} onClose={() => setExpanded(false)} onCancel={() => setExpanded(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setExpanded(false);
    }}>
      <header className="result-dialog-header">
        <div><span className="result-eyebrow">Review your draft</span><h2 id={`${id}-dialog-title`}>Your tailored resume</h2></div>
        <button type="button" onClick={() => setExpanded(false)} autoFocus>Close <span aria-hidden="true">×</span></button>
      </header>
      <div className="result-dialog-canvas">{hasResult && <ResumePreview text={resumeText} />}</div>
    </dialog>
  </section>;
}
