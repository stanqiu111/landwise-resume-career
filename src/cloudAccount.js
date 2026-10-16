export function validateStorageConfig(value) {
  if (value?.storage === 'local') return { storage: 'local' };
  if (value?.storage !== 'supabase' || typeof value.url !== 'string' || typeof value.publishableKey !== 'string' || !value.publishableKey.trim()) {
    throw new Error('Landwise storage is not configured correctly. Ask the server owner to check its settings.');
  }
  const url = new URL(value.url);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The Landwise account server address is invalid.');
  }
  return { storage: 'supabase', url: url.href.replace(/\/$/, ''), publishableKey: value.publishableKey };
}

export function accountWorkspaceKey(config, user) {
  return config?.storage === 'supabase' ? `supabase:${user?.id || 'signed-out'}` : 'local';
}

// This session is only a source of the access token. The server independently
// verifies its identity and scopes every database operation to that user.
export async function cloudAuthorizationHeaders(client, expectedUserId) {
  if (!client) return {};
  if (!expectedUserId) throw new Error('Sign in to your Landwise account first.');
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error('Your Landwise session could not be refreshed. Please sign in again.');
  if (!data?.session?.access_token || data.session.user?.id !== expectedUserId || data.session.user?.is_anonymous) {
    throw new Error('Your Landwise account changed or signed out. Please sign in again before continuing.');
  }
  return { Authorization: `Bearer ${data.session.access_token}` };
}
