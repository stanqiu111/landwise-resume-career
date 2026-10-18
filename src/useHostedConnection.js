import { useCallback, useEffect, useRef, useState } from 'react';
import { hostedFailureMessage } from './hostedAccess';

export default function useHostedConnection({ authorizeHeaders, signInEnabled = true }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(null);
  const refresh = useCallback(async () => {
    if (!mounted.current) return null;
    const request = ++sequence.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', headers: await authorizeHeaders(), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Landwise could not check AI availability.');
      if (data.mode !== 'hosted' || (typeof data.csrfToken !== 'string' && !(data.csrfToken === null && data.available === false))) throw new Error('Landwise AI is not ready on this site. Please try again later.');
      if (mounted.current && request === sequence.current) { setSession(data); setError(''); setLoading(false); }
      return data;
    } catch (failure) {
      if (mounted.current && request === sequence.current && !controller.signal.aborted) { setError(failure.message || 'Landwise could not check AI availability.'); setLoading(false); }
      return null;
    } finally { if (pending.current === controller) pending.current = null; }
  }, [authorizeHeaders]);
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(refresh, 0);
    const focus = () => refresh();
    window.addEventListener('focus', focus);
    return () => { mounted.current = false; clearTimeout(timer); pending.current?.abort(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  function recordFailure(failure) {
    setError(hostedFailureMessage(failure, session?.authenticated, signInEnabled));
    if (failure.code === 'guest_limit') setSession(previous => previous ? { ...previous, guestEligible: false } : previous);
    if (failure.code === 'monthly_allowance') setSession(previous => previous ? { ...previous, remaining: 0 } : previous);
    if (failure.code === 'shared_budget') setSession(previous => previous ? { ...previous, available: false, reason: 'capacity' } : previous);
    if (failure.code === 'hosted_ai_allowance_used') setSession(previous => previous ? { ...previous, guestEligible: false, remaining: 0, reason: previous.authenticated ? 'monthly_allowance' : 'guest_trial_used' } : previous);
    if (['hosted_ai_budget_limit', 'hosted_ai_daily_limit', 'hosted_ai_monthly_limit', 'hosted_ai_ip_limit'].includes(failure.code)) setSession(previous => previous ? { ...previous, available: false, reason: 'capacity' } : previous);
  }
  return { session, loading, error, refresh, recordFailure, busy: false, connecting: false };
}
