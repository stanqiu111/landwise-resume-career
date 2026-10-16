import { useId, useState } from 'react';
import './LandwiseAccount.css';

export default function LandwiseAccount({ account }) {
  const id = useId();
  const [email, setEmail] = useState('');
  if (!account.cloud) return null;
  return <section className="landwise-account" id="landwise-account" aria-labelledby={`${id}-title`}>
    <div className="landwise-account-copy">
      <p className="landwise-account-eyebrow">Your application library</p>
      <h2 id={`${id}-title`}>{account.user ? 'Your Landwise account' : 'Sign in to Landwise'}</h2>
      <p>{account.user ? 'Your applications are saved to this account. Your ChatGPT plan connection is separate.' : 'Use an email sign-in link to keep your drafts, fit reports, and application progress in your own account.'}</p>
      {!account.user && <p className="landwise-account-note">Sign in before uploading or using AI. Signing in or out clears the current draft from this tab.</p>}
    </div>
    {account.user ? <div className="landwise-account-session"><strong>{account.user.email || 'Signed in'}</strong><button type="button" onClick={account.signOut} disabled={account.busy}>{account.busy ? 'Signing out…' : 'Sign out of Landwise'}</button><span>Signing out clears this tab’s current draft.</span></div>
      : <form className="landwise-account-form" onSubmit={event => { event.preventDefault(); account.signIn(email); }}>
        <label htmlFor={`${id}-email`}>Email address</label>
        <div><input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={account.busy} placeholder="you@example.com" /><button disabled={account.busy || !email.trim()}>{account.busy ? 'Sending…' : 'Email me a sign-in link'}</button></div>
        <p>No password needed. This signs in to Landwise, not ChatGPT.</p>
      </form>}
    {account.error && <p className="landwise-account-error" role="alert">{account.error}</p>}
    {account.notice && <p className="landwise-account-notice" role="status">{account.notice}</p>}
  </section>;
}
