export async function applicationRequest(action, body, csrfToken) {
  const response = await fetch(`/api/applications/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Application folders are unavailable. Restart the local Landwise server, then retry.'); }
  if (!response.ok) throw new Error(data.error || 'The application folder could not be opened.');
  return data;
}
