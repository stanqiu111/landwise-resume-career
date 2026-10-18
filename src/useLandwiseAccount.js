import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { accountWorkspaceKey, canStartLandwiseSignIn, cloudAuthorizationHeaders, validateStorageConfig } from './cloudAccount';

export default function useLandwiseAccount({ allowGuest = false } = {}) {
  const [config, setConfig] = useState(null);
  const [client, setClient] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const operationRef = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let subscription;
    let accountClient;
    let authRevision = 0;
    async function initialize() {
      try {
        const response = await fetch('/api/storage/config', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('Landwise could not load its storage settings. Please retry.');
        const nextConfig = validateStorageConfig(await response.json());
        if (controller.signal.aborted) return;
        setConfig(nextConfig);
        if (nextConfig.storage !== 'supabase') { setLoading(false); return; }
        accountClient = createClient(nextConfig.url, nextConfig.publishableKey, {
          auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
        });
        setClient(accountClient);
        const listener = accountClient.auth.onAuthStateChange((_event, session) => {
          if (controller.signal.aborted) return;
          authRevision += 1;
          setUser(session?.user && !session.user.is_anonymous ? session.user : null);
          if (session?.user && !session.user.is_anonymous) { setError(''); setNotice(''); }
          setLoading(false);
        });
        subscription = listener.data.subscription;
        const initialRevision = authRevision;
        const session = await accountClient.auth.getSession();
        if (controller.signal.aborted) return;
        if (session.error) setError('Your Landwise sign-in could not be restored. Please request a new sign-in link.');
        if (authRevision === initialRevision) setUser(session.data?.session?.user && !session.data.session.user.is_anonymous ? session.data.session.user : null);
        setLoading(false);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setConfigError(failure.message || 'Landwise could not load its storage settings.');
        setLoading(false);
      }
    }
    initialize();
    return () => { mounted.current = false; controller.abort(); subscription?.unsubscribe(); accountClient?.auth.stopAutoRefresh(); };
  }, [attempt]);

  const retry = useCallback(() => { setLoading(true); setConfigError(''); setError(''); setAttempt(value => value + 1); }, []);
  const signInEnabled = canStartLandwiseSignIn(config, allowGuest);
  const signIn = useCallback(async email => {
    if (!signInEnabled) { setError('Account sign-in is being connected. Download any completed drafts to keep a copy.'); return false; }
    if (!client || operationRef.current) return false;
    operationRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/`, shouldCreateUser: true },
      });
      if (result.error) throw result.error;
      if (mounted.current) setNotice('Check your email for a sign-in link. Open it in this browser to finish connecting your Landwise account.');
      return true;
    } catch (failure) {
      if (mounted.current) setError(failure.message || 'The sign-in link could not be sent. Please try again.');
      return false;
    } finally { operationRef.current = false; if (mounted.current) setBusy(false); }
  }, [client, signInEnabled]);
  const signOut = useCallback(async () => {
    if (!client || operationRef.current) return;
    operationRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      if (mounted.current) setUser(null);
    } catch (failure) { if (mounted.current) setError(failure.message || 'Landwise could not sign you out. Please try again.'); }
    finally { operationRef.current = false; if (mounted.current) setBusy(false); }
  }, [client]);
  const userId = user?.id;
  const authorizeHeaders = useCallback(() => cloudAuthorizationHeaders(client, userId), [client, userId]);
  const authorizeAIHeaders = useCallback(() => cloudAuthorizationHeaders(client, userId, { allowGuest }), [client, userId, allowGuest]);
  const cloud = config?.storage === 'supabase';
  return { config, cloud, user, loading, configError, error, notice, busy, retry, signIn, signOut, signInEnabled, authorizeHeaders, authorizeAIHeaders,
    ready: !loading && !configError && config?.storage !== 'unavailable' && (!cloud || Boolean(userId)), workspaceKey: accountWorkspaceKey(config, user) };
}
