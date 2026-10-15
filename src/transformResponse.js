function responseError(data) {
  return Object.assign(new Error(data.error || 'Transform could not be completed. Please try again.'), {
    code: data.code, manageUsage: Boolean(data.manageUsageUrl),
    retryAfterSeconds: data.retryAfterSeconds,
  });
}

function validateResult(result) {
  if (typeof result?.transformedResume !== 'string' || !result.transformedResume.trim()) {
    throw new Error('The response did not contain a resume. Your inputs are still here; please try again.');
  }
  return result;
}

export async function readTransformResponse(response, onProgress) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Landwise could not read the server response. Please check that the local server is running.'); }
    if (!response.ok) throw responseError(data);
    return validateResult(data);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result;
  function consume(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('The connection returned an unreadable update. Please try again.'); }
    if (event.type === 'error') throw responseError(event);
    if (event.type === 'progress') onProgress(event);
    if (event.type === 'result') {
      result = validateResult(event.result);
      onProgress({ ...event, complete: true });
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (result) return result;
      if (done) break;
    }
    consume(buffer);
    if (!result) throw new Error('The connection ended before your resume was ready. Your inputs are still here; please try again.');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
