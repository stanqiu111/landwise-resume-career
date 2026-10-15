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

export default function App() {
  const [page, setPage] = useState(() => window.location.hash === '#career-events' ? 'events' : 'resume');
  const [resume, setResumeRaw] = useState('');
  const [sourcePages, setSourcePages] = useState(null);
  const [pageLimitOverride, setPageLimitOverride] = useState(null);
  const estimatedPages = useMemo(() => estimateResumePages(resume), [resume]);
  const maxPages = pageLimitOverride ?? sourcePages ?? estimatedPages;
  const [jobDescription, setJobDescription] = useState('');
  const [result, setResult] = useState(null);
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
      if (window.location.hash === '#ai-connection') {
        requestAnimationFrame(() => document.getElementById('ai-connection')?.scrollIntoView({ block: 'center' }));
      }
    }
    window.addEventListener('hashchange', followLocation);
    return () => window.removeEventListener('hashchange', followLocation);
  }, []);

  useEffect(() => {
    const section = page === 'events' ? eventsPageRef.current : resumePageRef.current;
    section?.focus({ preventScroll: true });
    if (window.location.hash === '#ai-connection') {
      document.getElementById('ai-connection')?.scrollIntoView({ block: 'center' });
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
      document.getElementById('ai-connection')?.scrollIntoView({ block: 'center' });
      showToast('Choose your ChatGPT account to continue.');
      return;
    }
    if (!aiReady) { showToast('Choose an available ChatGPT model first.'); return; }
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
      if (!controller.signal.aborted) setResult(data);
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
        <div className="header-left">
          <div className="header-logo">✦</div>
          <div className="header-title-wrap">
            <h1>Landwise</h1>
            <span className="header-sub">Land the job, wisely.</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <a href="#resume" aria-current={page === 'resume' ? 'page' : undefined}>Resume studio</a>
          <a href="#career-events" aria-current={page === 'events' ? 'page' : undefined}>Career events</a>
        </nav>
        <AIConnection connection={connection} mode="compact" />
      </header>

      <main className="app-main">
        <section className="app-page" ref={resumePageRef} tabIndex={-1} hidden={page !== 'resume'} aria-label="Resume studio">
          <div className="studio-hero">
            <p className="studio-eyebrow"><span aria-hidden="true">✦</span> A little clarity for your next chapter</p>
            <h2>Your experience, <br /><em>beautifully put to work.</em></h2>
            <p>Build a resume that sounds like you. Discover the people and<br className="desktop-break" /> opportunities that help you take the next step.</p>
            <div className="studio-hero-actions">
              <button onClick={() => resumePageRef.current?.querySelector('textarea')?.focus()}>Work on my resume <span aria-hidden="true">→</span></button>
              <a href="#career-events">Explore career events <span aria-hidden="true">↗</span></a>
            </div>
            <div className="studio-features" aria-label="Resume studio features">
              <span><span aria-hidden="true">✓</span> Your experience, kept honest</span>
              <span><span aria-hidden="true">✓</span> Tailored to the role</span>
              <span><span aria-hidden="true">✓</span> Ready to share</span>
            </div>
          </div>
          <div className="studio-workspace">
            <div className="studio-workspace-heading"><h3>A fresh start for your resume.</h3><p>Your story in. A clearer next step out.</p></div>
            <AIConnection connection={connection} mode="full" />
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
              />

              <div className="transform-center">
                <div className="divider-line" />
                <button
                  className={`transform-btn${loading ? ' loading' : ''}`}
                  onClick={handleTransform}
                  disabled={loading || analyzing || cooldown.retryIn > 0 || connection.loading || connection.busy || connection.connecting}
                >
                  {loading ? (
                    <><span className="spinner" /> Transforming...</>
                  ) : (
                    cooldown.retryIn > 0 ? `Wait ${cooldown.retryIn}s` : connection.session?.sharing ? '✦ Transform' : 'Sign in to transform'
                  )}
                </button>
                {loading && <button className="cancel-transform" onClick={() => transformRequestRef.current?.abort()}>Cancel</button>}
                <div className="divider-line" />
              </div>

              <OutputPanel
                result={result}
                loading={loading}
                progress={progress}
                error={transformError}
                retryIn={cooldown.retryIn}
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
