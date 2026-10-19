// Read-only smoke checks: no resume upload, generation, or paid provider call.
const origin = new URL(process.argv[2] || 'https://landwise-resume.vercel.app');
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('Pass an HTTPS origin, for example https://landwise-resume.vercel.app');
}
async function get(path) {
  const response = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (!response.headers.get('cache-control')?.includes('no-store')) throw new Error(`${path}: missing no-store`);
  return response.json();
}
const health = await get('/api/health');
if (health.mode !== 'hosted' || !health.configured) throw new Error('Hosted AI is disabled or configuration is incomplete.');
const session = await get('/api/session');
if (session.mode !== 'hosted' || typeof session.csrfToken !== 'string' || typeof session.available !== 'boolean') {
  throw new Error('Hosted session or ledger response is invalid.');
}
const config = await get('/api/storage/config');
if (config.mode !== 'hosted' || config.storage !== 'supabase') throw new Error('Hosted storage is not configured.');
// Print availability only; never log the cookie, CSRF token, or keys.
console.info(JSON.stringify({ origin: origin.origin, configured: true, aiAvailable: session.available,
  reason: session.reason || null, accountSignInEnabled: config.signInEnabled }, null, 2));
