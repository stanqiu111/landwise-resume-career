import { useState, useEffect, useRef, useMemo } from 'react';
import InputPanel from './components/InputPanel';
import Applications from './components/Applications';
import { applicationRequest } from './applicationApi';
import OutputPanel from './components/OutputPanel';
import ResumeFollowUp from './components/ResumeFollowUp';
import CareerEvents from './components/CareerEvents';
import AIConnection from './components/AIConnection';
import LandwiseAccount from './components/LandwiseAccount';
import useLandwiseAccount from './useLandwiseAccount';
import useAIConnection from './useAIConnection';
import useHostedConnection from './useHostedConnection';
import HostedAccess from './components/HostedAccess';
import { createHostedRequestIds, guestDraftForAccount, hostedActionAccess, hostedFailureMessage, validateHostedInputs } from './hostedAccess';
import { readTransformResponse } from './transformResponse';
import useAICooldown from './useAICooldown';
import { estimateResumePages } from './resumeLayout';
import { createReadyChime } from './readyChime';
import './App.css';

const HOSTED = import.meta.env.VITE_LANDWISE_HOSTED === 'true';

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
  const account = useLandwiseAccount({ allowGuest: HOSTED });
  const [guestHandoff, setGuestHandoff] = useState(null);
  useEffect(() => {
    if (!guestHandoff) return;
    const timer = setTimeout(() => setGuestHandoff(current => current === guestHandoff ? null : current), Math.max(0, guestHandoff.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [guestHandoff]);
  if (account.loading || account.configError) return <main className="landwise-startup">
    <h1>Landwise</h1>
    {account.loading ? <p role="status">Opening your workspace…</p> : <><p role="alert">{account.configError}</p><button onClick={account.retry}>Try again</button></>}
  </main>;
  // A different Landwise user gets a fresh subtree. Token refreshes keep the
  // same key, while sign-out/account switches unmount every private draft,
  // library view and upload/request controller before another user sees them.
  return HOSTED ? <HostedWorkspace key={account.workspaceKey} account={account}
    guestDraft={guestDraftForAccount(guestHandoff, account.user)}
    onPrepareGuestDraft={(email, draft) => setGuestHandoff(draft ? { email: email.trim().toLowerCase(), draft, expiresAt: Date.now() + 30 * 60 * 1000 } : null)}
    onDiscardGuestDraft={() => setGuestHandoff(null)} />
    : <LocalWorkspace key={account.workspaceKey} account={account} />;
}

function LocalWorkspace({ account }) {
  const connection = useAIConnection();
  return <Workspace account={account} connection={connection} />;
}

function HostedWorkspace(props) {
  const connection = useHostedConnection({ authorizeHeaders: props.account.authorizeAIHeaders, signInEnabled: props.account.signInEnabled });
  return <Workspace {...props} connection={connection} hosted />;
}

function Workspace({ account, connection, hosted = false, guestDraft, onPrepareGuestDraft, onDiscardGuestDraft }) {
  const [readyChime] = useState(createReadyChime);
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
  const [showAccount, setShowAccount] = useState(() => window.location.hash === '#landwise-account');
  const [retryRevisionInstruction, setRetryRevisionInstruction] = useState('');
  const [hostedRequestIds] = useState(createHostedRequestIds);
  const cooldown = useAICooldown(hosted ? account.user?.id || 'hosted-guest' : connection.session?.account?.id);
  const transformAccess = hostedActionAccess(connection.session, Boolean(account.user), 'transform', account.signInEnabled);
  const followUpAccess = hostedActionAccess(connection.session, Boolean(account.user), 'revise', account.signInEnabled);
  const retryHostedTransform = hosted && hostedRequestIds.canRetry('transform', { resume, jobDescription, model: connection.selectedModel, maxPages }, connection.session);
  const retryHostedAnalysis = hosted && hostedRequestIds.canRetry('analyze', { resume, model: connection.selectedModel }, connection.session);
  const retryHostedRevision = hosted && Boolean(retryRevisionInstruction) && hostedRequestIds.canRetry('revise', { ...resultInputs, result, instruction: retryRevisionInstruction, model: connection.selectedModel }, connection.session);
  const aiReady = hosted ? Boolean(connection.session?.csrfToken && (transformAccess.allowed || retryHostedTransform)) : Boolean(account.ready && connection.session?.connected && connection.session?.sharing && connection.selectedModel && !connection.busy && !connection.connecting);
  const authorizeAI = hosted ? account.authorizeAIHeaders : account.authorizeHeaders;
  const generationRef = useRef(0);
  const analysisRequestRef = useRef(null);
  const transformRequestRef = useRef(null);
  const revisionRequestRef = useRef(null);
  const saveRequestRef = useRef(null);
  const staleResult = Boolean(resultInputs && (resultInputs.resume !== resume || resultInputs.jobDescription !== jobDescription || resultInputs.maxPages !== maxPages));
  const resumePageRef = useRef(null);
  const eventsPageRef = useRef(null);
  const applicationsPageRef = useRef(null);

  useEffect(() => () => readyChime.dispose(), [readyChime]);

  useEffect(() => {
    function followLocation() {
      setPage(currentPage());
      setApplicationId(window.location.hash.startsWith('#applications/') ? window.location.hash.slice(14) : '');
      if (window.location.hash === '#ai-connection') revealConnection();
      if (window.location.hash === '#landwise-account') setShowAccount(true);
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
    saveRequestRef.current?.abort();
  }, [connection.session?.account?.id, connection.session?.connectionRevision, connection.session?.sharing, connection.busy, connection.connecting]);

  function showToast(msg, usage = false) {
    setToast(msg);
    setToastUsage(!hosted && usage);
    setTimeout(() => setToast(''), 5000);
  }

  function openAccount() {
    setShowAccount(true);
    window.location.hash = '#landwise-account';
    requestAnimationFrame(() => document.getElementById('landwise-account')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  async function beginSignIn(email) {
    if (hosted && !account.user) onPrepareGuestDraft?.(email, result && resultInputs ? { resume, jobDescription, result, resultInputs, sourcePages, maxPages } : null);
    const success = await account.signIn(email);
    if (!success) onDiscardGuestDraft?.();
    return success;
  }

  function importGuestDraft() {
    if (!guestDraft || loading || analyzing || refining || saving || inputUploading) return;
    const { savedApplication: _saved, saveError: _error, ...draft } = guestDraft.result;
    void _saved; void _error;
    setResumeRaw(guestDraft.resume); setJobDescription(guestDraft.jobDescription);
    setSourcePages(guestDraft.sourcePages); setPageLimitOverride(guestDraft.maxPages);
    setResult(draft); setResultInputs(guestDraft.resultInputs); setAnalysis(null);
    setTransformError(null); setRevisionError(null); setProgress(null);
    setFollowUpKey(value => value + 1); onDiscardGuestDraft?.();
    window.location.hash = '#resume';
    showToast('Your guest draft is open. Choose Save application to keep it in this account.');
  }

  async function handleAnalyze() {
    if (analysisRequestRef.current || transformRequestRef.current || revisionRequestRef.current || inputUploading || cooldown.retryIn) return;
    if (hosted && !followUpAccess.allowed && !retryHostedAnalysis) { if (followUpAccess.signIn) openAccount(); showToast(followUpAccess.message); return; }
    if (!account.ready) { showToast('Sign in to your Landwise account first.'); return; }
    if (!(hosted ? followUpAccess.allowed || retryHostedAnalysis : aiReady)) { showToast(hosted ? transformAccess.message : 'Connect your ChatGPT plan and choose a model first.'); return; }
    if (!resume.trim()) { showToast('Please upload or paste your resume first.'); return; }
    const payload = { resume, model: connection.selectedModel };
    if (hosted && validateHostedInputs(resume, '', payload)) { showToast(validateHostedInputs(resume, '', payload)); return; }
    const requestId = hosted ? hostedRequestIds.for('analyze', payload) : null;
    const requestVersion = ++generationRef.current;
    analysisRequestRef.current?.abort();
    const controller = new AbortController();
    analysisRequestRef.current = controller;
    setAnalyzing(true);
    try {
      const response = await fetch('/api/analyze-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': connection.session.csrfToken, ...(requestId ? { 'X-Request-ID': requestId } : {}), ...await authorizeAI() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || 'Could not analyze this resume.'), { code: data.code, manageUsage: Boolean(data.manageUsageUrl), retryAfterSeconds: data.retryAfterSeconds });
      if (!controller.signal.aborted && requestVersion === generationRef.current) { setAnalysis(data); if (hosted) hostedRequestIds.complete('analyze'); }
    } catch (error) {
      if (!controller.signal.aborted) cooldown.record(error);
      if (hosted) hostedRequestIds.failed('analyze', error, { aborted: controller.signal.aborted });
      if (error.name !== 'AbortError') { if (hosted) connection.recordFailure(error); showToast(hosted ? hostedFailureMessage(error, Boolean(account.user), account.signInEnabled) : error.message, error.manageUsage); }
    } finally {
      if (analysisRequestRef.current === controller) analysisRequestRef.current = null;
      if (requestVersion === generationRef.current) setAnalyzing(false);
      if (hosted) connection.refresh();
    }
  }

  async function handleTransform() {
    if (transformRequestRef.current || analysisRequestRef.current || revisionRequestRef.current || saving || inputUploading || cooldown.retryIn) return;
    if (hosted && !aiReady) { if (transformAccess.signIn) openAccount(); showToast(transformAccess.message); return; }
    if (!hosted && !account.ready) { showToast('Sign in to your Landwise account before tailoring a resume.'); return; }
    if (!hosted && !connection.session?.sharing) {
      revealConnection();
      showToast('Choose your ChatGPT account to continue.');
      return;
    }
    if (!aiReady) { revealConnection(); showToast('Choose an available ChatGPT model first.'); return; }
    if (!resume.trim()) { showToast('Please upload or paste your resume first.'); return; }
    if (!jobDescription.trim()) { showToast('Please fill out the job description.'); return; }
    const payload = { resume, jobDescription, model: connection.selectedModel, maxPages };
    if (hosted && validateHostedInputs(resume, jobDescription, payload)) { showToast(validateHostedInputs(resume, jobDescription, payload)); return; }
    const requestId = hosted ? hostedRequestIds.for('transform', payload) : null;
    readyChime.prepare();
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
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-CSRF-Token': connection.session.csrfToken, ...(requestId ? { 'X-Request-ID': requestId } : {}), ...await authorizeAI() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await readTransformResponse(res, update => {
        if (!controller.signal.aborted) setProgress(update);
      });
      if (!controller.signal.aborted) {
        setResult(data);
        setResultInputs({ resume, jobDescription, maxPages });
        setFollowUpKey(value => value + 1);
        if (hosted) hostedRequestIds.complete('transform');
        readyChime.play();
      }
    } catch (err) {
      if (!controller.signal.aborted) cooldown.record(err);
      let message = hosted ? hostedFailureMessage(err, Boolean(account.user), account.signInEnabled) : err.message;
      if (hosted) {
        connection.recordFailure(err);
        hostedRequestIds.failed('transform', err, { aborted: controller.signal.aborted });
        if (account.signInEnabled && (['guest_limit', 'sign_in_required', 'cloud_sign_in_required'].includes(err.code) || (err.code === 'hosted_ai_allowance_used' && !account.user))) setShowAccount(true);
      }
      if (controller.signal.aborted) {
        message = controller.signal.reason?.name === 'TimeoutError'
          ? controller.signal.reason.message : 'Transform was cancelled. Your inputs are still here.';
      } else if (['session_required', 'invalid_csrf'].includes(err.code)) {
        await connection.refresh();
        message = hosted ? 'Your session was refreshed. Please try again.' : 'Your connection was refreshed. Choose your saved ChatGPT account and try again.';
      }
      setTransformError({ message, manageUsage: !hosted && err.manageUsage });
    } finally {
      clearTimeout(timeout);
      if (transformRequestRef.current === controller) {
        transformRequestRef.current = null;
        setLoading(false);
      }
      if (hosted) connection.refresh();
    }
  }

  async function handleRefine(instruction) {
    if (!result || !resultInputs || revisionRequestRef.current || transformRequestRef.current || analysisRequestRef.current || saving || inputUploading || cooldown.retryIn) return false;
    const payload = { ...resultInputs, result, instruction: instruction.trim(), model: connection.selectedModel };
    const recovering = hosted && hostedRequestIds.canRetry('revise', payload, connection.session);
    if (hosted && !followUpAccess.allowed && !recovering) { if (followUpAccess.signIn) openAccount(); setRevisionError({ message: followUpAccess.message }); return false; }
    if (!account.ready) { setRevisionError({ message: 'Sign in to your Landwise account before refining your draft.' }); return false; }
    if (staleResult) { setRevisionError({ message: 'Your inputs changed. Tailor again before refining this draft.' }); return false; }
    if (!(hosted ? followUpAccess.allowed || recovering : aiReady)) { if (!hosted) revealConnection(); setRevisionError({ message: hosted ? transformAccess.message : 'Choose your ChatGPT account and an available model first.' }); return false; }
    if (!instruction.trim() || instruction.trim().length > 2000) return false;
    if (hosted && validateHostedInputs(resultInputs.resume, resultInputs.jobDescription, payload)) { setRevisionError({ message: validateHostedInputs(resultInputs.resume, resultInputs.jobDescription, payload) }); return false; }
    const requestId = hosted ? hostedRequestIds.for('revise', payload) : null;
    readyChime.prepare();
    const controller = new AbortController();
    revisionRequestRef.current = controller;
    setRefining(true); setRevisionError(null); setRevisionProgress(null); setToast('');
    const timeout = setTimeout(() => controller.abort(new DOMException('The revision took too long. Your previous draft and request are still here.', 'TimeoutError')), 135000);
    try {
      const response = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-CSRF-Token': connection.session.csrfToken, ...(requestId ? { 'X-Request-ID': requestId } : {}), ...await authorizeAI() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const revised = await readTransformResponse(response, update => {
        if (!controller.signal.aborted) setRevisionProgress(update);
      });
      if (controller.signal.aborted) return false;
      setResult(revised); setProgress(null); setTransformError(null);
      if (hosted) { hostedRequestIds.complete('revise'); setRetryRevisionInstruction(''); }
      readyChime.play();
      showToast(revised.transformedResume === result.transformedResume ? 'AI feedback is ready. Your draft is unchanged.' : revised.savedApplication ? 'Updated your draft and saved a new application version.' : 'Your revised draft is ready.');
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) cooldown.record(failure);
      let message = hosted ? hostedFailureMessage(failure, Boolean(account.user), account.signInEnabled) : failure.message;
      if (hosted) {
        connection.recordFailure(failure);
        setRetryRevisionInstruction(hostedRequestIds.failed('revise', failure, { aborted: controller.signal.aborted }) ? instruction.trim() : '');
      }
      if (controller.signal.aborted) message = controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason.message : 'Revision cancelled. Your previous draft and request are still here.';
      else if (['session_required', 'invalid_csrf'].includes(failure.code)) {
        await connection.refresh();
        message = hosted ? 'Your session was refreshed. Please try your revision again.' : 'Your connection was refreshed. Choose your saved account and try your revision again.';
      }
      setRevisionError({ message, manageUsage: !hosted && failure.manageUsage });
      return false;
    } finally {
      clearTimeout(timeout);
      if (revisionRequestRef.current === controller) { revisionRequestRef.current = null; setRefining(false); }
      if (hosted) connection.refresh();
    }
  }

  async function saveApplication() {
    if (!result || !resultInputs || saving || refining || loading || !account.ready) return;
    const snapshot = result;
    const controller = new AbortController();
    saveRequestRef.current = controller;
    setSaving(true);
    try {
      const { savedApplication: _saved, saveError: _error, ...draft } = result;
      void _saved; void _error;
      const savedApplication = await applicationRequest('save', { ...resultInputs, result: draft }, connection.session?.csrfToken, { authorizeHeaders: account.authorizeHeaders, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResult(previous => previous === snapshot ? { ...previous, savedApplication, saveError: null } : previous);
      showToast(account.cloud ? 'Application saved to your Landwise account.' : 'Application saved on this computer.');
    } catch (failure) { if (!controller.signal.aborted) showToast(failure.message); }
    finally { if (saveRequestRef.current === controller) { saveRequestRef.current = null; setSaving(false); } }
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
        {hosted ? account.cloud && (account.user || account.signInEnabled) && <button type="button" className="hosted-header-account" onClick={openAccount}>{account.user ? 'My account' : 'Sign in · Free'}</button> : <AIConnection connection={connection} mode="compact" />}
      </header>

      <main className="app-main">
        {(!hosted || account.user || showAccount || page === 'applications') && <LandwiseAccount account={account} hosted={hosted} afterDraft={Boolean(result)} onSignIn={beginSignIn} />}
        {hosted && account.user && guestDraft && <section className="hosted-handoff" aria-label="Bring your guest draft into this account">
          <h2>Your guest draft is still here.</h2><p>Open it in this account, then choose Save application to keep it. Opening replaces any unsaved inputs currently in the studio.</p>
          <button onClick={importGuestDraft} disabled={loading || analyzing || refining || saving || inputUploading}>Open my guest draft</button><button onClick={onDiscardGuestDraft}>Discard guest draft</button>
        </section>}
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
                authorizeHeaders={authorizeAI}
                csrfToken={connection.session?.csrfToken}
                uploadAllowed={hosted ? Boolean(connection.session?.csrfToken && connection.session?.reason !== 'configuration') : account.ready && (!account.cloud || Boolean(connection.session?.csrfToken))}
                accountRequired={!hosted && account.cloud && !account.user}
                maxUploadMB={hosted ? 2 : 10}
                analysisUnavailableReason={hosted ? followUpAccess.message : ''}
                retryingAnalysis={retryHostedAnalysis}
                resume={resume}
                setResume={setResume}
                jobDescription={jobDescription}
                setJobDescription={setJobDescription}
                analysis={analysis}
                analyzing={analyzing}
                onAnalyze={handleAnalyze}
                aiReady={hosted ? followUpAccess.allowed || retryHostedAnalysis : aiReady}
                aiBusy={loading || refining}
                onUploadingChange={setInputUploading}
                sourcePages={sourcePages}
                maxPages={maxPages}
                setMaxPages={setPageLimitOverride}
                retryIn={cooldown.retryIn}
              >
                {uploading => <>
                  {hosted ? <HostedAccess connection={connection} signedIn={Boolean(account.user)} accountAvailable={account.cloud && account.signInEnabled} onSignIn={openAccount} /> : <details className="connection-settings">
                    <summary>
                      <span className="connection-summary-copy">AI account & model</span>
                      <span className="connection-summary-state">{connection.loading ? 'Checking…' : aiReady ? 'Connected' : 'Set up ChatGPT'}</span>
                      <span className="connection-summary-toggle" aria-hidden="true">+</span>
                    </summary>
                    <AIConnection connection={connection} mode="full" />
                  </details>}
                  <div className="transform-actions">
                    <button
                      className={`transform-btn${loading ? ' loading' : ''}`}
                      onClick={handleTransform}
                      disabled={(hosted ? !aiReady : !account.ready) || loading || refining || saving || analyzing || uploading || cooldown.retryIn > 0 || connection.loading || connection.busy || connection.connecting}
                    >
                      {loading ? <span className="transform-busy"><span className="spinner" /> Tailoring your resume…</span> : <>{cooldown.retryIn > 0 ? `Try again in ${cooldown.retryIn}s` : retryHostedTransform ? 'Retry my last tailoring' : 'Tailor my resume'}{!hosted && <span aria-hidden="true">↗</span>}</>}
                    </button>
                    {loading && <button className="cancel-transform" onClick={() => transformRequestRef.current?.abort()}>Cancel tailoring</button>}
                    <p className="transform-note">{hosted ? account.user ? 'Keeps your roles and projects. Completed drafts save to your application library.' : account.signInEnabled ? 'Keeps your roles and projects. Download each draft, or create a free account to save it.' : 'Keeps your roles and projects. Download each draft before leaving; nothing is saved to an account.' : account.cloud && !account.user ? 'Sign in to Landwise above, then connect your ChatGPT plan to tailor a resume.' : `Keeps your roles and projects. Saves completed drafts in My applications ${account.cloud ? 'in your Landwise account' : 'on this computer'}.`}</p>
                  </div>
                </>}
              </InputPanel>

              <OutputPanel
                storage={account.cloud ? 'supabase' : 'local'}
                hosted={hosted}
                result={result}
                onSave={hosted && !account.user ? account.signInEnabled ? openAccount : undefined : saveApplication}
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
                  disabled={staleResult || (hosted ? !followUpAccess.allowed && !retryHostedRevision : !aiReady) || analyzing || inputUploading || saving}
                  requestAllowed={!hosted || followUpAccess.allowed}
                  retryAllowed={retryHostedRevision}
                  retryInstruction={retryRevisionInstruction}
                  disabledReason={hosted && retryHostedRevision ? 'Keep your request unchanged to check for its earlier result without using another AI action.' : hosted && !followUpAccess.allowed ? followUpAccess.message : !account.ready ? 'Sign in to your Landwise account to refine a draft.' : staleResult ? 'Your inputs changed. Tailor again to update this draft before requesting revisions.' : inputUploading ? 'Wait for your PDF to finish loading.' : analyzing ? 'Wait for the resume analysis to finish.' : saving ? 'Saving your current draft…' : !aiReady ? 'Connect your ChatGPT account and choose a model to refine this draft.' : ''}
                  retryIn={cooldown.retryIn} error={revisionError} progress={revisionProgress}
                  onCancel={() => revisionRequestRef.current?.abort()}
                />}
                {hosted && result && !account.user && !showAccount && page !== 'applications' && <div className="hosted-signup-after-result"><LandwiseAccount account={account} hosted afterDraft onSignIn={beginSignIn} /></div>}
              </OutputPanel>
            </div>
          </div>
        </section>
        <section className="app-page" ref={applicationsPageRef} tabIndex={-1} hidden={page !== 'applications'} aria-label="My applications">
          {account.ready ? <Applications key={account.workspaceKey} storage={account.cloud ? 'supabase' : 'local'} authorizeHeaders={account.authorizeHeaders} active={page === 'applications'} selectedId={applicationId} csrfToken={connection.session?.csrfToken} revision={result?.savedApplication?.versionId} onRestore={restoreApplication} onNotify={showToast} />
            : <div className="application-card application-empty"><h1>My applications</h1><p>{hosted && !account.signInEnabled ? 'Account sign-in is being connected. Download any completed drafts to keep a copy.' : 'Sign in to Landwise above to open your own application library.'}</p></div>}
        </section>
        <section className="app-page" ref={eventsPageRef} tabIndex={-1} hidden={page !== 'events'} aria-label="Career events">
          <CareerEvents active={page === 'events'} onNotify={showToast} />
        </section>
      </main>
    </div>
  );
}
