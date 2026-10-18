export function hostedActionAccess(session, signedIn, action = 'transform', signInEnabled = true) {
  if (!session) return { allowed: false, message: 'Checking AI availability…' };
  if (!signedIn && !signInEnabled && (action !== 'transform' || session.reason === 'guest_trial_used' || (session.available && !session.guestEligible))) return { allowed: false, message: 'Account sign-in is being connected. You can still download your completed draft and explore career events.' };
  if (!signedIn && session.reason === 'guest_trial_used') return { allowed: false, signIn: true, message: 'Your first tailoring is complete. Create a free Landwise account to keep going.' };
  if (signedIn && session.reason === 'monthly_allowance') return { allowed: false, message: 'You’ve used your monthly AI allowance. Your saved applications and downloads are still available.' };
  if (!session.available) return { allowed: false, message: ['busy', 'ai_busy'].includes(session.reason) ? 'Landwise is busy right now. Please try again shortly.' : session.reason === 'daily_limit' ? 'AI tailoring is at today’s capacity. Please try again tomorrow.' : session.reason === 'monthly_limit' ? 'AI tailoring is at this month’s capacity. Please try again next month.' : 'AI tailoring is temporarily unavailable. You can still edit your inputs and explore career events.' };
  if (signedIn && !session.authenticated) return { allowed: false, message: 'Your account session needs to be refreshed. Check availability, then try again.' };
  if (!signedIn) return action === 'transform' && session.guestEligible
    ? { allowed: true, message: 'Your first tailored resume is free. No signup required.' }
    : { allowed: false, signIn: true, message: action === 'transform' ? 'Your first tailoring is complete. Create a free Landwise account to keep going.' : 'Sign in to a free Landwise account for resume feedback and follow-up changes.' };
  if (!Number.isFinite(session.remaining) || session.remaining <= 0) return { allowed: false, message: 'You’ve used your monthly AI allowance. Your saved applications and downloads are still available.' };
  return { allowed: true, message: `${session.remaining} of ${session.limit || 3} free AI actions remaining this month.` };
}

export function hostedFailureMessage(error, signedIn = false, signInEnabled = true) {
  if (!signedIn && !signInEnabled && ['guest_limit', 'sign_in_required', 'cloud_sign_in_required', 'hosted_ai_allowance_used'].includes(error?.code)) return 'Your first tailoring is the only AI action available without an account. Account sign-in is being connected; you can still download your draft.';
  const messages = {
    guest_limit: 'Your first tailoring has been used. Sign in to a free Landwise account to keep going.',
    sign_in_required: 'Sign in to a free Landwise account to use this feature.',
    cloud_sign_in_required: 'Your Landwise sign-in needs to be refreshed. Please sign in again.',
    monthly_allowance: 'You’ve used your monthly AI allowance. You can still review, save, and download your drafts.',
    shared_budget: 'AI tailoring is temporarily at capacity. Please try again later. Your inputs and completed drafts are still here.',
    session_required: 'Your session was refreshed. Please try again.',
    invalid_csrf: 'Your session was refreshed. Please try again.',
    hosted_ai_allowance_used: signedIn ? 'You’ve used your monthly AI allowance. Your saved applications and downloads are still available.' : 'Your first tailoring has been used. Sign in to a free Landwise account to keep going.',
    hosted_ai_budget_limit: 'AI tailoring is temporarily at capacity. Please try again later. Your inputs and completed drafts are still here.',
    hosted_ai_daily_limit: 'AI tailoring is at today’s capacity. Please try again tomorrow. Your inputs and drafts are still here.',
    hosted_ai_monthly_limit: 'AI tailoring is at this month’s capacity. Please try again next month. Your saved applications and downloads remain available.',
    hosted_ai_ip_limit: 'This connection has reached today’s AI limit. Please try again tomorrow.',
    hosted_ai_busy: 'This request is still running or waiting to finish. Retry the same request shortly to check for its result.',
    hosted_result_unavailable: 'This earlier request cannot be recovered. Check your saved applications or downloads. You can start a new request if you have AI actions remaining.',
    hosted_ai_unavailable: 'AI tailoring is not available yet. You can keep editing your inputs and browse career events.',
    hosted_ai_timeout: 'AI took too long to finish. Your inputs and previous drafts are still here.',
    hosted_request_failed: 'The request could not be confirmed. Retry the same request to check for its result.',
    transform_failed: 'The request could not be confirmed. Retry the same request to check for its result.',
    hosted_budget_unavailable: 'Landwise could not confirm this request’s status. Please retry the same request shortly.',
    budget_unavailable: 'Landwise could not confirm this request’s status. Please retry the same request shortly.',
  };
  return messages[error?.code] || error?.message || 'Your AI request could not be completed. Please try again.';
}

export function canRecoverHostedRequest(session) {
  return Boolean(session?.csrfToken && (session.available || (session.reason && session.reason !== 'configuration')));
}

export function keepHostedRequestId(error) {
  // A proxy failure or lost budget RPC response may hide a completed request.
  // Replay its ID until the server confirms a completed or terminal outcome.
  return !error?.code || ['hosted_ai_busy', 'hosted_request_failed', 'transform_failed', 'hosted_budget_unavailable', 'budget_unavailable'].includes(error.code);
}

export function validateHostedInputs(resume, jobDescription = '', payload = { resume, jobDescription }) {
  if (resume.length > 30000) return 'Your resume is too long. Please keep it within 30,000 characters.';
  if (jobDescription.length > 20000) return 'The job description is too long. Please keep it within 20,000 characters.';
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 60000) return 'This request is too large. Please shorten the inputs before trying again.';
  return '';
}

export function createHostedRequestIds(uuid = () => crypto.randomUUID()) {
  const requests = new Map();
  return {
    for(action, payload) {
      const fingerprint = JSON.stringify(payload);
      const previous = requests.get(action);
      if (previous?.fingerprint === fingerprint) { previous.retryable = false; return previous.id; }
      const id = uuid(); requests.set(action, { fingerprint, id, retryable: false }); return id;
    },
    failed(action, error, { aborted = false } = {}) {
      const request = requests.get(action);
      if (!request) return false;
      if (!aborted && !keepHostedRequestId(error)) { requests.delete(action); return false; }
      request.retryable = true;
      return true;
    },
    canRetry(action, payload, session) {
      const request = requests.get(action);
      return Boolean(request?.retryable && request.fingerprint === JSON.stringify(payload) && canRecoverHostedRequest(session));
    },
    complete(action) { requests.delete(action); },
  };
}

export function guestDraftForAccount(handoff, user, now = Date.now()) {
  if (!handoff || !user?.id || !user.email || handoff.email !== user.email.trim().toLowerCase() || now > handoff.expiresAt) return null;
  return handoff.draft;
}
