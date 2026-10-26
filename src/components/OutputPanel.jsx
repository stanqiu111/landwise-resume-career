import { useEffect, useId, useRef, useState } from 'react';
import { resumePDF, estimateResumePages } from '../resumeLayout';
import { resumeDOCXBlob } from '../resumeDocx';
import ClaimCoverage from './ClaimCoverage';
import FitReport from './FitReport';
import UnsupportedRequirements from './UnsupportedRequirements';
import TransformActivity from './TransformActivity';
import FlapText from './FlapText';
import { parseResumeLines } from '../resumeDocument';
import './OutputPanel.css';

const TABS = [
  { id: 'resume', label: 'Resume' },
  { id: 'report', label: 'Fit report' },
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

function documentFilename(text, job) {
  const name = [job?.company, job?.roleTitle].filter(Boolean).join(' ') || parseResumeLines(text).find(line => line.type === 'name')?.text || 'tailored';
  const slug = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70);
  return `${slug || 'tailored'}-resume`;
}

export default function OutputPanel({ result, loading, progress, error, retryIn = 0, stale = false, onSave, saving = false, revising = false, storage = 'local', hosted = false, children }) {
  const [copyState, setCopyState] = useState('');
  const [tab, setTab] = useState('resume');
  const [expanded, setExpanded] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const dialogRef = useRef(null);
  const followUpRef = useRef(null);
  const copyTimer = useRef(null);
  const id = useId();
  const resumeText = result?.transformedResume || '';
  const hasResult = Boolean(resumeText);
  const filename = documentFilename(resumeText, result?.job);

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

  const caption = revising ? 'Refining your draft. Your current version stays available below.' : loading ? 'Working with your experience. Follow the progress below.'
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
        {revising ? 'Refining draft' : loading ? 'In progress' : stale && hasResult ? 'Inputs changed' : hasResult ? 'Draft ready' : 'Ready when you are'}
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
          {children && <button type="button" disabled={loading} onClick={() => { followUpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); followUpRef.current?.querySelector('textarea')?.focus({ preventScroll: true }); }}>Refine draft ↓</button>}
          <button type="button" onClick={() => setExpanded(true)} disabled={loading}>Full screen</button>
          <button type="button" onClick={handleCopy} disabled={loading || revising || copyState === 'copying'}>{copyState === 'copied' ? 'Copied' : copyState === 'copying' ? 'Copying…' : 'Copy text'}</button>
          <button type="button" className="result-export" onClick={handleDownloadPDF} disabled={loading || revising || exporting}>PDF</button>
          <button type="button" className="result-export" onClick={handleDownloadDOCX} disabled={loading || revising || exporting} title="Editable Word document. Fonts and later edits can change pagination.">{exporting ? 'Saving…' : 'DOCX'}</button>
        </div>
      </div>
      {!loading && (result.pageCount || progress?.complete) && <p className="result-meta">
        {result.pageCount ? `${result.pageCount} ${result.pageCount === 1 ? 'page' : 'pages'}${result.pageLimit ? ` · Within your ${result.pageLimit}-page limit` : ''}` : ''}
        {result.pageCount && progress?.complete ? ' · ' : ''}
        {progress?.complete ? `Ready in ${Math.round(progress.elapsedMs / 1000)} seconds` : ''}
      </p>}
      <div className="result-save">
        {result.savedApplication ? <><span>{storage === 'supabase' || result.savedApplication.storage === 'supabase' ? 'Saved in your Landwise application library.' : 'Saved in your local application folder.'}</span><a href={`#applications/${result.savedApplication.id}`}>View application ↗</a></>
          : <><span>{result.saveError || 'Keep this draft, its job description and fit report together.'}</span>{onSave && <button onClick={onSave} disabled={loading || revising || saving}>{saving ? 'Saving…' : 'Save application'}</button>}</>}
      </div>
      <span className="result-sr-only" role="status">{copyState === 'copied' ? 'Resume copied to clipboard.' : ''}</span>
      {copyState === 'failed' && <p className="result-inline-error" role="alert">Copy wasn’t available. Open Full screen to select the text, or download your resume.</p>}
      {exportError && <p className="result-inline-error" role="alert">{exportError}</p>}
    </div>}

    {!loading && stale && hasResult && <p className="result-notice result-stale" role="status">Your inputs have changed. Tailor again to update this draft.</p>}

    <div className={`result-canvas${loading ? ' is-loading' : ''}${hasResult && tab !== 'resume' ? ' is-details' : ''}`} aria-busy={loading}>
      {loading && <TransformActivity progress={progress} hosted={hosted} />}

      {!loading && !hasResult && <div className="result-empty">
        <div className="result-empty-board" aria-hidden="true">
          <FlapText text={error ? 'Delayed' : 'Next: your draft'} key={error ? 'delayed' : 'next'} />
          <div className="result-empty-route"><span>RESUME</span><i /><span>THE ROLE</span></div>
        </div>
        <h3>{error ? 'Your details are still here.' : 'A clearer resume starts here.'}</h3>
        <p>{error ? 'Review the message above, then try tailoring again.' : 'Add your resume and a job description. Your tailored draft will appear here.'}</p>
        <span>Review your draft before applying.</span>
      </div>}

      {!loading && hasResult && <div id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="result-tabpanel">
        {tab === 'resume' && <ResumePreview text={resumeText} />}
        {tab === 'report' && <FitReport result={result} />}
        {tab === 'evidence' && <div className="claims-content result-details">
          {result.claim_coverage != null && <ClaimCoverage coverage={result.claim_coverage} />}
          {Array.isArray(result.unsupported_requirements) ? <UnsupportedRequirements items={result.unsupported_requirements} /> : <p className="result-details-empty">No requirement evidence was provided for this draft. Review every claim against your original resume.</p>}
        </div>}
      </div>}
    </div>

    {!loading && hasResult && children && <div className="result-follow-up" ref={followUpRef}>{children}</div>}

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
