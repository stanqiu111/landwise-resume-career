import { useState, useEffect, useRef, useMemo } from 'react';
import InputPanel from './components/InputPanel';
import OutputPanel from './components/OutputPanel';
import CareerEvents from './components/CareerEvents';
import AIConnection from './components/AIConnection';
import useAIConnection from './useAIConnection';
import { readTransformResponse } from './transformResponse';
import useAICooldown from './useAICooldown';
import { estimateResumePages } from './resumeLayout';
import './App.css';

function revealConnection() {
  requestAnimationFrame(() => {
    const section = document.getElementById('ai-connection');
    const disclosure = section?.closest('details');
    if (disclosure) disclosure.open = true;
    section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

export default function App() {
  const [page, setPage] = useState(() => window.location.hash === '#career-events' ? 'events' : 'resume');
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
  const resumePageRef = useRef(null);
  const eventsPageRef = useRef(null);

  useEffect(() => {
    function followLocation() {
      setPage(window.location.hash === '#career-events' ? 'events' : 'resume');
      if (window.location.hash === '#ai-connection') revealConnection();
    }
    window.addEventListener('hashchange', followLocation);
    return () => window.removeEventListener('hashchange', followLocation);
  }, []);

  useEffect(() => {
    const section = page === 'events' ? eventsPageRef.current : resumePageRef.current;
    section?.focus({ preventScroll: true });
    if (window.location.hash === '#ai-connection') {
      revealConnection();
    } else window.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);

  // Editing invalidates feedback; an explicit click starts the next AI check.
  function setResume(text, source) {
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
  }, [connection.session?.account?.id, connection.session?.connectionRevision, connection.session?.sharing, connection.busy, connection.connecting]);

  function showToast(msg, usage = false) {
    setToast(msg);
    setToastUsage(usage);
    setTimeout(() => setToast(''), 5000);
  }

  async function handleAnalyze() {
    if (analysisRequestRef.current || transformRequestRef.current || cooldown.retryIn) return;
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
    if (transformRequestRef.current || analysisRequestRef.current || cooldown.retryIn) return;
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
              <p className="studio-description">Bring your experience and a job description. Create a clearer, more relevant resume.</p>
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
                aiBusy={loading}
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
                      disabled={loading || analyzing || uploading || cooldown.retryIn > 0 || connection.loading || connection.busy || connection.connecting}
                    >
                      {loading ? <span className="transform-busy"><span className="spinner" /> Tailoring your resume…</span> : <>{cooldown.retryIn > 0 ? `Try again in ${cooldown.retryIn}s` : 'Tailor my resume'}<span aria-hidden="true">↗</span></>}
                    </button>
                    {loading && <button className="cancel-transform" onClick={() => transformRequestRef.current?.abort()}>Cancel tailoring</button>}
                    <p className="transform-note">Built from your experience. Review before you apply.</p>
                  </div>
                </>}
              </InputPanel>

              <OutputPanel
                result={result}
                loading={loading}
                progress={progress}
                error={transformError}
                retryIn={cooldown.retryIn}
                stale={Boolean(resultInputs && (resultInputs.resume !== resume || resultInputs.jobDescription !== jobDescription || resultInputs.maxPages !== maxPages))}
              />
            </div>
          </div>
        </section>
        <section className="app-page" ref={eventsPageRef} tabIndex={-1} hidden={page !== 'events'} aria-label="Career events">
          <CareerEvents active={page === 'events'} onNotify={showToast} />
        </section>
      </main>
    </div>
  );
}
