import { useEffect, useState } from 'react';

export default function useAICooldown(accountId) {
  const [deadlines, setDeadlines] = useState({});
  const [now, setNow] = useState(Date.now);
  const deadline = deadlines[accountId] || 0;
  const retryIn = Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => {
    if (!retryIn) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryIn]);

  function record(error) {
    if (!accountId || !Number.isFinite(error?.retryAfterSeconds) || error.retryAfterSeconds <= 0) return;
    const current = Date.now();
    setNow(current);
    setDeadlines(previous => ({ ...previous, [accountId]: Math.max(previous[accountId] || 0, current + error.retryAfterSeconds * 1000) }));
  }
  return { retryIn, record };
}
