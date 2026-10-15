export function retryDelaySeconds(headers, now = Date.now()) {
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (value != null && String(value).trim()) {
    const seconds = /^\d+(?:\.\d+)?$/.test(String(value).trim())
      ? Number(value) : (Date.parse(value) - now) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  }
  const milliseconds = headers?.get?.('retry-after-ms') ?? headers?.['retry-after-ms'];
  if (milliseconds != null && /^\d+(?:\.\d+)?$/.test(String(milliseconds).trim())) {
    const seconds = Number(milliseconds) / 1000;
    if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  }
  // A local pause when the provider does not give a reset time, not a promise
  // that its limit will have cleared by then.
  return 60;
}

export class AIRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`ChatGPT is receiving too many requests. Wait at least ${retryAfterSeconds} seconds before trying again. Your inputs have been kept.`);
    this.status = 429;
    this.code = 'chatgpt_rate_limited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const rateLimitError = (retryAfterSeconds = 60) => new AIRateLimitError(retryAfterSeconds);

// Shared by Analyze, Transform and model discovery. Identity comes from the
// authenticated local session, never a client-supplied account ID or token.
export function createAIAdmission(auth, now = Date.now) {
  const active = new Set();
  const cooldowns = new Map();
  return {
    acquire(req, exclusive = true) {
      auth.requireSession?.(req);
      const accountId = auth.getStatus?.(req)?.account?.id;
      req.aiAccountId = accountId;
      for (const [id, deadline] of cooldowns) if (deadline <= now()) cooldowns.delete(id);
      if (!accountId) return () => {};
      const remaining = Math.ceil(((cooldowns.get(accountId) || 0) - now()) / 1000);
      if (remaining > 0) {
        req.aiCooldownBlocked = true;
        throw rateLimitError(remaining);
      }
      if (!exclusive) return () => {};
      if (active.has(accountId)) {
        throw Object.assign(new Error('Another resume request is already running for this account. Wait for it to finish, or cancel it in the other tab.'), {
          status: 409, code: 'ai_request_in_progress',
        });
      }
      active.add(accountId);
      return () => active.delete(accountId);
    },
    record(req, error) {
      if (req.aiAccountId && !req.aiCooldownBlocked && error?.code === 'chatgpt_rate_limited') {
        const seconds = Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
        cooldowns.set(req.aiAccountId, Math.max(cooldowns.get(req.aiAccountId) || 0, now() + seconds * 1000));
      }
    },
  };
}
