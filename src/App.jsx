import { useState, useEffect, useRef, useMemo } from 'react';
import InputPanel from './components/InputPanel';
import Applications from './components/Applications';
import { applicationRequest } from './applicationApi';
import OutputPanel from './components/OutputPanel';
import ResumeFollowUp from './components/ResumeFollowUp';
import CareerEvents from './components/CareerEvents';
import AIConnection from './components/AIConnection';
import useAIConnection from './useAIConnection';
import { readTransformResponse } from './transformResponse';
import useAICooldown from './useAICooldown';
import { estimateResumePages } from './resumeLayout';
import './App.css';

function currentPage() { return window.location.hash.startsWith('#applications') ? 'applications' : window.location.hash === '#career-events' ? 'events' : 'resume'; }

function revealConnection() {
  requestAnimationFrame(() => {
    const section = document.getElementById('ai-connection');
    const disclosure = section?.closest('details');
    if (disclosure) disclosure.open = true;
    section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

export default function App() {
  const [page, setPage] = useState(currentPage);
  const [applicationId, setApplicationId] = useState(() => window.location.hash.startsWith('#applications/') ? window.location.hash.slice(14) : '');
  const [saving, setSaving] = useState(false);
  const [inputUploading, setInputUploading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [revisionError, setRevisionError] = useState(null);
  const [revisionProgress, setRevisionProgress] = useState(null);
  const [followUpKey, setFollowUpKey] = useState(0);
  const [resume, setResumeRaw] = useState('');
  const [sourcePages, setSourcePages] = useState(null);
  const [pageLimitOverride, setPageLimitOverride] = useState(null);
  const estimatedPages = useMemo(() => estimateResumePages(resume), [resume]);
  const maxPages = pageLimitOverride ?? sourcePages ?? estimatedPages;
  const [jobDescription, setJobDescription] = useState('');
  const [result, setResult] = useState(null);
  const [resultInputs, setResultInputs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [transformError, setTransformError] = useState(null);
  const [toast, setToast] = useState('');
  const [toastUsage, setToastUsage] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const connection = useAIConnection();
  const cooldown = useAICooldown(connection.session?.account?.id);
  const aiReady = Boolean(connection.session?.connected && connection.session?.sharing && connection.selectedModel && !connection.busy && !connection.connecting);
  const generationRef = useRef(0);
  const analysisRequestRef = useRef(null);
  const transformRequestRef = useRef(null);
  const revisionRequestRef = useRef(null);
  const staleResult = Boolean(resultInputs && (resultInputs.resume !== resume || resultInputs.jobDescription !== jobDescription || resultInputs.maxPages !== maxPages));
  const resumePageRef = useRef(null);
  const eventsPageRef = useRef(null);
  const applicationsPageRef = useRef(null);

  useEffect(() => {
    function followLocation() {
      setPage(currentPage());
      setApplicationId(window.location.hash.startsWith('#applications/') ? window.location.hash.slice(14) : '');
      if (window.location.hash === '#ai-connection') revealConnection();
    }
    window.addEventListener('hashchange', followLocation);
    return () => window.removeEventListener('hashchange', followLocation);
  }, []);

  useEffect(() => {
    const section = page === 'events' ? eventsPageRef.current : page === 'applications' ? applicationsPageRef.current : resumePageRef.current;
    section?.focus({ preventScroll: true });
    if (window.location.hash === '#ai-connection') {
      revealConnection();
    } else window.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);

  // Editing invalidates feedback; an explicit click starts the next AI check.
  function setResume(text, source) {
    revisionRequestRef.current?.abort();
    setResumeRaw(text);
    if (source || !text) {
      setSourcePages(source?.pageCount || null);
      setPageLimitOverride(null);
    }
    generationRef.current += 1;
    analysisRequestRef.current?.abort();
    setAnalyzing(false);
    setAnalysis(null);
  }

  useEffect(() => () => {
    analysisRequestRef.current?.abort();
    transformRequestRef.current?.abort();
    revisionRequestRef.current?.abort();
  }, [connection.session?.account?.id, connection.session?.connectionRevision, connection.session?.sharing, connection.busy, connection.connecting]);

  function showToast(msg, usage = false) {
    setToast(msg);
    setToastUsage(usage);
    setTimeout(() => setToast(''), 5000);
  }

  async function handleAnalyze() {
    if (analysisRequestRef.current || transformRequestRef.current || revisionRequestRef.current || inputUploading || cooldown.retryIn) return;
    if (!aiReady) { showToast('Connect your ChatGPT plan and choose a model first.'); return; }
    if (!resume.trim()) { showToast('Please upload or paste your resume first.'); return; }
    const requestVersion = ++generationRef.current;
    analysisRequestRef.current?.abort();
    const controller = new AbortController();
    analysisRequestRef.current = controller;
    setAnalyzing(true);
    try {
      const response = await fetch('/api/analyze-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': connection.session.csrfToken },
        body: JSON.stringify({ resume, model: connection.selectedModel }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || 'Could not analyze this resume.'), { manageUsage: Boolean(data.manageUsageUrl), retryAfterSeconds: data.retryAfterSeconds });
      if (!controller.signal.aborted && requestVersion === generationRef.current) setAnalysis(data);
    } catch (error) {
      if (!controller.signal.aborted) cooldown.record(error);
      if (error.name !== 'AbortError') showToast(error.message, error.manageUsage);
    } finally {
      if (analysisRequestRef.current === controller) analysisRequestRef.current = null;
      if (requestVersion === generationRef.current) setAnalyzing(false);
    }
  }

  async function handleTransform() {
    if (transformRequestRef.current || analysisRequestRef.current || revisionRequestRef.current || saving || inputUploading || cooldown.retryIn) return;
    if (!connection.session?.sharing) {
      revealConnection();
      showToast('Choose your ChatGPT account to continue.');
      return;
    }
    if (!aiReady) { revealConnection(); showToast('Choose an available ChatGPT model first.'); return; }
    if (!resume.trim()) { showToast('Please upload or paste your resume first.'); return; }
    if (!jobDescription.trim()) { showToast('Please fill out the job description.'); return; }
    setToast('');
    setLoading(true);
    setRevisionError(null);
    setRevisionProgress(null);
    setTransformError(null);
    setProgress(null);
    const controller = new AbortController();
    transformRequestRef.current = controller;

    const timeout = setTimeout(() => controller.abort(new DOMException('Transform timed out. Your inputs are still here. Please try again.', 'TimeoutError')), 250000);

    try {
      const res = await fetch('/api/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-CSRF-Token': connection.session.csrfToken },
        body: JSON.stringify({ resume, jobDescription, model: connection.selectedModel, maxPages }),
        signal: controller.signal,
      });
      const data = await readTransformResponse(res, update => {
        if (!controller.signal.aborted) setProgress(update);
      });
      if (!controller.signal.aborted) {
        setResult(data);
        setResultInputs({ resume, jobDescription, maxPages });
        setFollowUpKey(value => value + 1);
      }
    } catch (err) {
      if (!controller.signal.aborted) cooldown.record(err);
      let message = err.message;
      if (controller.signal.aborted) {
        message = controller.signal.reason?.name === 'TimeoutError'
          ? controller.signal.reason.message : 'Transform was cancelled. Your inputs are still here.';
      } else if (['session_required', 'invalid_csrf'].includes(err.code)) {
        await connection.refresh();
        message = 'Your connection was refreshed. Choose your saved ChatGPT account and try again.';
      }
      setTransformError({ message, manageUsage: err.manageUsage });
    } finally {
      clearTimeout(timeout);
      if (transformRequestRef.current === controller) {
        transformRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  async function handleRefine(instruction) {
    if (!result || !resultInputs || revisionRequestRef.current || transformRequestRef.current || analysisRequestRef.current || saving || inputUploading || cooldown.retryIn) return false;
    if (staleResult) { setRevisionError({ message: 'Your inputs changed. Tailor again before refining this draft.' }); return false; }
    if (!aiReady) { revealConnection(); setRevisionError({ message: 'Choose your ChatGPT account and an available model first.' }); return false; }
    if (!instruction.trim() || instruction.trim().length > 2000) return false;
    const controller = new AbortController();
    revisionRequestRef.current = controller;
    setRefining(true); setRevisionError(null); setRevisionProgress(null); setToast('');
    const timeout = setTimeout(() => controller.abort(new DOMException('The revision took too long. Your previous draft and request are still here.', 'TimeoutError')), 135000);
    try {
      const response = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-CSRF-Token': connection.session.csrfToken },
        body: JSON.stringify({ ...resultInputs, result, instruction: instruction.trim(), model: connection.selectedModel }),
        signal: controller.signal,
      });
      const revised = await readTransformResponse(response, update => {
        if (!controller.signal.aborted) setRevisionProgress(update);
      });
      if (controller.signal.aborted) return false;
      setResult(revised); setProgress(null); setTransformError(null);
      showToast(revised.transformedResume === result.transformedResume ? 'AI feedback is ready. Your draft is unchanged.' : revised.savedApplication ? 'Updated your draft and saved a new application version.' : 'Your revised draft is ready.');
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) cooldown.record(failure);
      let message = failure.message;
      if (controller.signal.aborted) message = controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason.message : 'Revision cancelled. Your previous draft and request are still here.';
      else if (['session_required', 'invalid_csrf'].includes(failure.code)) {
        await connection.refresh();
        message = 'Your connection was refreshed. Choose your saved account and try your revision again.';
      }
      setRevisionError({ message, manageUsage: failure.manageUsage });
      return false;
    } finally {
      clearTimeout(timeout);
      if (revisionRequestRef.current === controller) { revisionRequestRef.current = null; setRefining(false); }
    }
  }

  async function saveApplication() {
    if (!result || !resultInputs || saving || refining || loading) return;
    const snapshot = result;
    setSaving(true);
    try {
      const { savedApplication: _saved, saveError: _error, ...draft } = result;
      void _saved; void _error;
      const savedApplication = await applicationRequest('save', { ...resultInputs, result: draft }, connection.session?.csrfToken);
      setResult(previous => previous === snapshot ? { ...previous, savedApplication, saveError: null } : previous);
      showToast('Application saved on this computer.');
    } catch (failure) { showToast(failure.message); }
    finally { setSaving(false); }
  }

  function restoreApplication(version) {
    if (loading || analyzing || refining || saving || inputUploading) { showToast('Finish or cancel the current AI request before opening a saved version.'); return; }
    setResume(version.resume, { pageCount: null });
    setJobDescription(version.jobDescription);
    setPageLimitOverride(version.maxPages);
    setResult({ ...version.result, savedApplication: { id: applicationId, versionId: version.id } });
    setFollowUpKey(value => value + 1); setRevisionError(null); setRevisionProgress(null);
    setResultInputs({ resume: version.resume, jobDescription: version.jobDescription, maxPages: version.maxPages });
    setProgress(null); setTransformError(null);
    window.location.hash = '#resume';
    showToast('Opened the original resume and saved job. Tailoring again keeps a new version when the draft changes.');
  }

  return (
    <div className="app">
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          {toastUsage && <a className="toast-usage" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a>}
          <button className="toast-close" aria-label="Dismiss notification" onClick={() => setToast('')}>✕</button>
        </div>
      )}

      <header className="app-header">
        <a className="header-left" href="#resume" aria-label="Landwise resume studio">
          <span className="header-logo" aria-hidden="true">L<span /></span>
          <div className="header-title-wrap">
            <span className="header-wordmark">landwise<span>.</span></span>
            <span className="header-sub">A little clarity. Your next opportunity.</span>
          </div>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <a href="#resume" aria-current={page === 'resume' ? 'page' : undefined}>Resume studio</a>
          <a href="#applications" aria-current={page === 'applications' ? 'page' : undefined}>My applications</a>
          <a href="#career-events" aria-current={page === 'events' ? 'page' : undefined}>Career events</a>
        </nav>
        <AIConnection connection={connection} mode="compact" />
      </header>

      <main className="app-main">
        <section className="app-page" ref={resumePageRef} tabIndex={-1} hidden={page !== 'resume'} aria-label="Resume studio">
          <div className="studio-hero">
            <div className="studio-intro">
              <p className="studio-eyebrow">Built around your experience</p>
              <h1>Your resume. A better fit.</h1>
              <p className="studio-description">Small edits to your real experience. A clearer fit, a learning plan, and your next step.</p>
            </div>
            <ol className="studio-steps" aria-label="Resume tailoring steps">
              {[['01', 'Add details'], ['02', 'Tailor'], ['03', 'Review & export']].map(([number, label], index) => (
                <li key={number} aria-current={index === (loading ? 1 : result ? 2 : 0) ? 'step' : undefined}>
                  <span>{number}</span>{label}
                </li>
              ))}
            </ol>
          </div>
          <div className="studio-workspace">
            <div className="panels">
              <InputPanel
                resume={resume}
                setResume={setResume}
                jobDescription={jobDescription}
                setJobDescription={setJobDescription}
                analysis={analysis}
                analyzing={analyzing}
                onAnalyze={handleAnalyze}
                aiReady={aiReady}
                aiBusy={loading || refining}
                onUploadingChange={setInputUploading}
                sourcePages={sourcePages}
                maxPages={maxPages}
                setMaxPages={setPageLimitOverride}
                retryIn={cooldown.retryIn}
              >
                {uploading => <>
                  <details className="connection-settings">
                    <summary>
                      <span className="connection-summary-copy">AI account & model</span>
                      <span className="connection-summary-state">{connection.loading ? 'Checking…' : aiReady ? 'Connected' : 'Set up ChatGPT'}</span>
                      <span className="connection-summary-toggle" aria-hidden="true">+</span>
                    </summary>
                    <AIConnection connection={connection} mode="full" />
                  </details>
                  <div className="transform-actions">
                    <button
                      className={`transform-btn${loading ? ' loading' : ''}`}
                      onClick={handleTransform}
                      disabled={loading || refining || saving || analyzing || uploading || cooldown.retryIn > 0 || connection.loading || connection.busy || connection.connecting}
                    >
                      {loading ? <span className="transform-busy"><span className="spinner" /> Tailoring your resume…</span> : <>{cooldown.retryIn > 0 ? `Try again in ${cooldown.retryIn}s` : 'Tailor my resume'}<span aria-hidden="true">↗</span></>}
                    </button>
                    {loading && <button className="cancel-transform" onClick={() => transformRequestRef.current?.abort()}>Cancel tailoring</button>}
                    <p className="transform-note">Keeps your roles and projects. Saves completed drafts in My applications on this computer.</p>
                  </div>
                </>}
              </InputPanel>

              <OutputPanel
                result={result}
                onSave={saveApplication}
                saving={saving}
                loading={loading}
                revising={refining}
                progress={progress}
                error={transformError}
                retryIn={cooldown.retryIn}
                stale={staleResult}
              >
                {result && <ResumeFollowUp key={followUpKey}
                  result={result} onSubmit={handleRefine} busy={refining}
                  disabled={staleResult || !aiReady || analyzing || inputUploading || saving}
                  disabledReason={staleResult ? 'Your inputs changed. Tailor again to update this draft before requesting revisions.' : inputUploading ? 'Wait for your PDF to finish loading.' : analyzing ? 'Wait for the resume analysis to finish.' : saving ? 'Saving your current draft…' : !aiReady ? 'Connect your ChatGPT account and choose a model to refine this draft.' : ''}
                  retryIn={cooldown.retryIn} error={revisionError} progress={revisionProgress}
                  onCancel={() => revisionRequestRef.current?.abort()}
                />}
              </OutputPanel>
            </div>
          </div>
        </section>
        <section className="app-page" ref={applicationsPageRef} tabIndex={-1} hidden={page !== 'applications'} aria-label="My applications">
          <Applications active={page === 'applications'} selectedId={applicationId} csrfToken={connection.session?.csrfToken} revision={result?.savedApplication?.versionId} onRestore={restoreApplication} onNotify={showToast} />
        </section>
        <section className="app-page" ref={eventsPageRef} tabIndex={-1} hidden={page !== 'events'} aria-label="Career events">
          <CareerEvents active={page === 'events'} onNotify={showToast} />
        </section>
      </main>
    </div>
  );
}
