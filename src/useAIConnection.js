import { useCallback, useEffect, useRef, useState } from 'react';

const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
const POLL_INTERVAL = 1500;

async function responseData(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Landwise could not read the server response. Please try again.');
  }
  if (!response.ok) throw new Error(data.error || data.message || 'Something went wrong. Please try again.');
  return data;
}

function hasNewConnection(next, previous) {
  if (!next.connected) return false;
  return !previous?.connected
    || next.account?.id !== previous.account?.id
    || (next.sharing && !previous.sharing)
    || (next.connectionRevision != null && next.connectionRevision !== previous.connectionRevision);
}

export default function useAIConnection() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modelState, setModelState] = useState({ key: '', models: [], selectedModel: '', error: '' });
  const [modelRevision, setModelRevision] = useState(0);
  const mounted = useRef(false);
  const refreshSequence = useRef(0);
  const pendingSignIn = useRef(null);
  const mutationInProgress = useRef(false);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    const sequence = ++refreshSequence.current;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      const next = await responseData(response);
      if (mounted.current && sequence === refreshSequence.current) {
        setSession(next);
        setLoading(false);
        if (!silent) setError('');
      }
      return next;
    } catch (failure) {
      if (mounted.current && sequence === refreshSequence.current) {
        setLoading(false);
        if (!silent) setError(failure.message);
      }
      return null;
    }
  }, []);

  const stopSignIn = useCallback(() => {
    const pending = pendingSignIn.current;
    if (pending?.timer) window.clearTimeout(pending.timer);
    pendingSignIn.current = null;
    if (mounted.current) setConnecting(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Scheduling also lets StrictMode cancel its throwaway subscription before
    // it makes a session request.
    const initialRefresh = window.setTimeout(refresh, 0);
    const onFocus = () => refresh({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.clearTimeout(initialRefresh);
      stopSignIn();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, stopSignIn]);

  const connect = useCallback(async (profileId) => {
    if (pendingSignIn.current || mutationInProgress.current) return;
    if (!session?.csrfToken) {
      setError('Your sign-in session is not ready. Refresh the connection and try again.');
      return;
    }

    // Open synchronously in the click event, so browsers do not block the window.
    // The provider page never receives access to the resume tab through opener.
    const popup = window.open('about:blank', '_blank', 'popup,width=540,height=760');
    if (!popup) {
      setError('Allow pop-ups for Landwise, then try signing in again. Your resume is still here.');
      return;
    }
    popup.opener = null;
    popup.document.title = 'Connecting Landwise';
    popup.document.body.textContent = 'Opening ChatGPT sign-in…';
    const pending = { popup, previous: session, expiresAt: Date.now() + SIGN_IN_TIMEOUT, timer: null };
    pendingSignIn.current = pending;
    setConnecting(true);
    setError('');
    setNotice('');

    try {
      const response = await fetch('/api/auth/chatgpt/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(profileId ? { profileId } : {}),
      });
      const data = await responseData(response);
      const authorizationUrl = new URL(data.authorizationUrl, window.location.origin);
      if (authorizationUrl.origin !== window.location.origin
        || authorizationUrl.pathname !== '/api/auth/chatgpt/authorize'
        || authorizationUrl.username || authorizationUrl.password) {
        throw new Error('The sign-in address was not recognized. Please try again.');
      }
      if (!mounted.current || pendingSignIn.current !== pending) {
        popup.close();
        return;
      }
      if (popup.closed) {
        stopSignIn();
        return;
      }
      popup.location.replace(authorizationUrl.href);

      const poll = async () => {
        if (!mounted.current || pendingSignIn.current !== pending) return;
        const next = await refresh({ silent: true });
        if (!mounted.current || pendingSignIn.current !== pending) return;
        if (next && hasNewConnection(next, pending.previous)) {
          stopSignIn();
          return;
        }
        if (popup.closed) {
          // Focus also refreshes the session if the provider isolates its popup.
          stopSignIn();
          return;
        }
        if (Date.now() >= pending.expiresAt) {
          stopSignIn();
          setError('Sign-in is taking longer than expected. Finish in the ChatGPT window, then refresh the connection here.');
          return;
        }
        pending.timer = window.setTimeout(poll, POLL_INTERVAL);
      };
      pending.timer = window.setTimeout(poll, POLL_INTERVAL);
    } catch (failure) {
      popup.close();
      if (mounted.current && pendingSignIn.current === pending) {
        stopSignIn();
        setError(failure.message);
      }
    }
  }, [session, refresh, stopSignIn]);

  const mutateAccount = useCallback(async (path, body) => {
    if (mutationInProgress.current || pendingSignIn.current || !session?.csrfToken) return;
    mutationInProgress.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(body),
      });
      const result = await responseData(response);
      await refresh();
      if (mounted.current) {
        setNotice([result.message, result.warning]
          .filter(message => typeof message === 'string' && message.trim())
          .join(' '));
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      mutationInProgress.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [session, refresh]);

  const signout = useCallback(() => mutateAccount('/api/auth/chatgpt/signout', {}), [mutateAccount]);
  const selectAccount = useCallback(profileId => mutateAccount('/api/auth/chatgpt/select', { profileId }), [mutateAccount]);
  const clearError = useCallback(() => setError(''), []);
  const refreshModels = useCallback(() => setModelRevision(revision => revision + 1), []);
  const accountId = session?.connected && session?.sharing ? session.account?.id : null;
  const csrfToken = session?.csrfToken;
  const modelKey = accountId ? `${accountId}:${modelRevision}` : '';

  useEffect(() => {
    if (!accountId || !csrfToken) return;
    const controller = new AbortController();
    async function loadModels() {
      try {
        const response = await fetch('/api/ai/models', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: '{}',
          signal: controller.signal,
        });
        const data = await responseData(response);
        const models = Array.isArray(data.models)
          ? data.models.filter(model => typeof model.slug === 'string' && model.slug && typeof model.displayName === 'string')
          : [];
        if (!models.length) throw new Error('No models are available for this ChatGPT account yet.');
        if (!controller.signal.aborted) {
          setModelState(previous => ({
            key: modelKey,
            models,
            selectedModel: previous.key === modelKey && models.some(model => model.slug === previous.selectedModel)
              ? previous.selectedModel : models[0].slug,
            error: '',
          }));
        }
      } catch (failure) {
        if (!controller.signal.aborted) setModelState({ key: modelKey, models: [], selectedModel: '', error: failure.message });
      }
    }
    loadModels();
    return () => controller.abort();
  }, [accountId, csrfToken, modelKey]);

  const setSelectedModel = useCallback(slug => {
    setModelState(previous => previous.models.some(model => model.slug === slug)
      ? { ...previous, selectedModel: slug } : previous);
  }, []);
  const currentModels = modelKey && modelState.key === modelKey ? modelState : null;

  return {
    session, loading, error, notice, connecting, busy, connect, signout, selectAccount, refresh, clearError,
    models: currentModels?.models || [],
    modelsLoading: Boolean(modelKey && !currentModels),
    modelError: currentModels?.error || '',
    selectedModel: currentModels?.selectedModel || '',
    setSelectedModel,
    refreshModels,
  };
}
