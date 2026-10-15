import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './AIConnection.css';

const USAGE_URL = 'https://chatgpt.com/settings/usage';

function ConnectionWelcome({ accountId, enabled }) {
  const dialogRef = useRef(null);
  const acknowledged = useRef(new Set());
  const titleId = useId();
  const storageKey = accountId ? `landwise.chatgpt.welcome.v1:${accountId}` : null;

  useEffect(() => {
    if (!enabled || !storageKey || acknowledged.current.has(storageKey)) return;
    try {
      if (window.localStorage.getItem(storageKey) === 'seen') return;
    } catch { /* The welcome can still be dismissed if browser storage is disabled. */ }
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [enabled, storageKey]);

  function dismiss(event) {
    event?.preventDefault();
    if (storageKey) {
      acknowledged.current.add(storageKey);
      try { window.localStorage.setItem(storageKey, 'seen'); } catch { /* No credentials are stored here. */ }
    }
    dialogRef.current?.close();
  }

  return createPortal(
    <dialog className="ai-welcome" ref={dialogRef} aria-labelledby={titleId} onCancel={dismiss}>
      <div className="ai-welcome-symbol" aria-hidden="true">✦</div>
      <p className="ai-connection-eyebrow">Your plan. Your next step.</p>
      <h2 id={titleId}>You’re connected to ChatGPT.</h2>
      <p>Landwise can now use your ChatGPT plan when you choose to check or transform your resume. Those actions count toward your plan’s usage limits.</p>
      <p>Your resume is sent for AI processing only when you run one of those actions.</p>
      <div className="ai-welcome-actions">
        <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">Manage plan usage <span aria-hidden="true">↗</span></a>
        <button className="ai-connect-button" onClick={dismiss} autoFocus>Got it</button>
      </div>
    </dialog>,
    document.body,
  );
}

export default function AIConnection({ connection, mode = 'full' }) {
  const {
    session, loading, error, notice, connecting, busy, connect, signout, selectAccount, refresh,
    models, modelsLoading, modelError, selectedModel, setSelectedModel, refreshModels,
  } = connection;
  const account = session?.account;
  const connected = Boolean(session?.connected);
  const sharing = Boolean(connected && session?.sharing);
  const disabled = loading || connecting || busy;
  const canConnect = session?.authAvailable !== false;
  const accountLabel = account?.label || account?.email || account?.name || 'ChatGPT account';
  const accounts = session?.accounts || [];
  const needsAccountSelection = !account?.id && accounts.length > 0;
  const accountSelectId = useId();
  const modelSelectId = useId();

  if (mode === 'compact') {
    return (
      <div className="ai-connection-compact">
        {sharing ? (
          <a className="ai-account-chip" href="#ai-connection" title={accountLabel}>
            <span className="ai-connected-dot" aria-hidden="true" /> ChatGPT connected
          </a>
        ) : needsAccountSelection ? (
          <a className="ai-connect-button ai-connect-button-compact" href="#ai-connection">Choose ChatGPT account</a>
        ) : (
          <button className="ai-connect-button ai-connect-button-compact" onClick={() => connect(account?.id)} disabled={disabled || !canConnect}>
            {loading ? 'Checking account…' : connecting ? 'Signing in…' : 'Continue with ChatGPT'}
          </button>
        )}
        {error && <a className="ai-compact-error" href="#ai-connection" role="alert">Connection needs attention</a>}
      </div>
    );
  }

  return (
    <section className={`ai-connection${sharing ? ' is-connected' : ''}`} id="ai-connection" aria-label="AI account connection">
      <div className="ai-connection-main">
        <div className="ai-connection-icon" aria-hidden="true">✦</div>
        <div className="ai-connection-copy">
          <p className="ai-connection-eyebrow">{sharing ? 'Using your ChatGPT plan' : 'Bring your own AI plan'}</p>
          <h3>{sharing ? accountLabel : connected ? 'One more step to use your plan.' : account?.id ? 'Reconnect your ChatGPT account.' : needsAccountSelection ? 'Choose your ChatGPT account.' : 'Your AI, connected.'}</h3>
          <p>{sharing
            ? 'Run a resume check or tailor it to a role when you’re ready.'
            : connected
              ? 'Sign-in succeeded, but plan use is not enabled. Reconnect to allow Landwise to use your ChatGPT plan.'
              : account?.id
                ? 'This saved account is signed out. Continue with ChatGPT to reconnect.'
                : needsAccountSelection
                  ? 'Choose a saved account below, or add another ChatGPT account.'
                  : 'Sign in with an eligible ChatGPT Plus or Pro account. No API key needed.'}</p>
        </div>
        <div className="ai-connection-actions">
          {sharing ? (
            <>
              <a className="ai-usage-link" href={USAGE_URL} target="_blank" rel="noopener noreferrer">Manage usage <span aria-hidden="true">↗</span></a>
              <button className="ai-text-button" onClick={signout} disabled={disabled}>Sign out</button>
            </>
          ) : !needsAccountSelection && (
            <button className="ai-connect-button" onClick={() => connect(account?.id)} disabled={disabled || !canConnect}>
              {loading ? 'Checking account…' : connecting ? 'Waiting for sign-in…' : busy ? 'Updating account…' : connected ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
              {!disabled && <span aria-hidden="true">↗</span>}
            </button>
          )}
        </div>
      </div>

      {(connected || accounts.length > 0) && (
        <div className="ai-account-settings">
          {accounts.length > 0 && (
            <label className="ai-setting-field" htmlFor={accountSelectId}>
              <span>Account</span>
              <select id={accountSelectId} value={account?.id || ''} onChange={event => selectAccount(event.target.value)} disabled={disabled}>
                {!account?.id && <option value="" disabled>Choose a saved account</option>}
                {accounts.map(profile => <option key={profile.id} value={profile.id}>{profile.label || profile.email || 'ChatGPT account'}{profile.connected ? '' : ' — sign in again'}</option>)}
              </select>
            </label>
          )}
          {sharing && (
            <label className="ai-setting-field" htmlFor={modelSelectId}>
              <span>Model</span>
              <select id={modelSelectId} value={selectedModel} onChange={event => setSelectedModel(event.target.value)} disabled={disabled || modelsLoading || !models.length}>
                {!models.length && <option value="">{modelsLoading ? 'Loading models…' : 'Models unavailable'}</option>}
                {models.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
              </select>
            </label>
          )}
          <button className="ai-text-button ai-add-account" onClick={() => connect()} disabled={disabled}>+ Add account</button>
          {connected && !sharing && <button className="ai-text-button" onClick={signout} disabled={disabled}>Sign out</button>}
        </div>
      )}

      {connecting && <p className="ai-connection-status" role="status">Finish signing in in the ChatGPT window. Your resume will stay here.</p>}
      {notice && <p className="ai-connection-status" role="status">{notice}</p>}
      {!canConnect && <p className="ai-connection-error" role="status">ChatGPT sign-in is currently unavailable. You can still work on your resume and explore career events.</p>}
      {error && <div className="ai-connection-error" role="alert"><span>{error}</span><button className="ai-text-button" onClick={() => refresh()} disabled={connecting || busy}>Refresh connection</button></div>}
      {modelError && <div className="ai-connection-error" role="alert"><span>{modelError}</span><button className="ai-text-button" onClick={refreshModels} disabled={disabled}>Try models again</button></div>}
      <div className="ai-connection-footnote">
        <span>{sharing ? 'AI actions use your plan’s available allowance.' : 'You stay in control of when AI runs.'}</span>
        <span>Claude plan sign-in isn’t available in Landwise yet.</span>
      </div>
      <ConnectionWelcome accountId={account?.id} enabled={sharing} />
    </section>
  );
}
