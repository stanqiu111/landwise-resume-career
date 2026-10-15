// SDK request timeouts may end when headers arrive. This deadline covers the
// entire operation, including reading a streaming body and hung credentials.
export async function withDeadline(signal, timeoutMs, timeoutError, work) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectOnAbort();
    else controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    // Cancel any parallel work still outstanding when another branch failed.
    controller.abort();
  }
}
