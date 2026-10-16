export async function applicationRequest(action, body, csrfToken, { authorizeHeaders, signal } = {}) {
  const authorization = authorizeHeaders ? await authorizeHeaders() : {};
  signal?.throwIfAborted();
  const response = await fetch(`/api/applications/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...authorization },
    body: JSON.stringify(body),
    signal,
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Your application library is unavailable. Check the Landwise server connection, then retry.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'The application could not be opened.'), { code: data.code });
  return data;
}
