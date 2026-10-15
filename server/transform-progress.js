import { randomUUID } from 'node:crypto';

export function transformProgress(req, res, log = console.info) {
  const streaming = req.get('Accept')?.includes('application/x-ndjson');
  const requestId = randomUUID();
  const started = Date.now();
  const steps = new Map();
  let finished = false;
  function send(event) {
    if (!streaming || res.destroyed || res.writableEnded || finished) return;
    if (!res.headersSent) {
      res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
    }
    res.write(`${JSON.stringify({ ...event, requestId })}\n`);
  }
  const snapshot = () => ({ elapsedMs: Date.now() - started, steps: [...steps.values()].map(({ startedAt, ...step }) => ({ ...step, elapsedMs: step.elapsedMs ?? Date.now() - startedAt })) });
  const report = () => send({ type: 'progress', ...snapshot() });
  const heartbeat = streaming ? setInterval(report, 5000) : null;
  const cleanup = () => { finished = true; clearInterval(heartbeat); };
  res.once('close', cleanup);
  return {
    async step(id, label, work) {
      req.aiSignal.throwIfAborted();
      const state = { id, label, status: 'running', startedAt: Date.now() };
      steps.set(id, state);
      report();
      try {
        const result = await work();
        req.aiSignal.throwIfAborted();
        state.status = 'completed';
        return result;
      } catch (error) {
        state.status = 'failed';
        throw error;
      } finally {
        state.elapsedMs = Date.now() - state.startedAt;
        // Metadata only: never log prompts, resume text, responses or tokens.
        log(JSON.stringify({ event: 'transform_step', requestId, step: id, status: state.status, elapsedMs: state.elapsedMs }));
        report();
      }
    },
    complete(result) {
      const timing = snapshot();
      log(JSON.stringify({ event: 'transform_complete', requestId, elapsedMs: timing.elapsedMs }));
      if (streaming) send({ type: 'result', result, ...timing });
      cleanup();
      if (!res.destroyed) streaming ? res.end() : res.json(result);
    },
    fail(error) {
      const known = Number.isInteger(error?.status) && typeof error?.code === 'string';
      const body = {
        error: known ? error.message : 'The AI request could not be completed. Please try again.',
        code: known ? error.code : 'transform_failed',
        ...(error?.manageUsageUrl ? { manageUsageUrl: 'https://chatgpt.com/settings/usage' } : {}),
        ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      };
      log(JSON.stringify({ event: 'transform_failed', requestId, code: body.code, elapsedMs: Date.now() - started }));
      if (error?.retryAfterSeconds && !res.headersSent) res.set('Retry-After', String(error.retryAfterSeconds));
      if (streaming) send({ type: 'error', ...body });
      cleanup();
      if (!res.destroyed) streaming ? res.end() : res.status(known ? error.status : 502).json(body);
    },
  };
}
