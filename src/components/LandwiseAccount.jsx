import { useId, useState } from 'react';
import './LandwiseAccount.css';

export default function LandwiseAccount({ account, hosted = false, afterDraft = false, onSignIn }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const waitingForSignIn = hosted && !account.user && account.signInEnabled !== true;
  if (!account.cloud) return null;
  return <section className="landwise-account" id="landwise-account" aria-labelledby={`${id}-title`}>
    <div className="landwise-account-copy">
      <p className="landwise-account-eyebrow">Your application library</p>
      <h2 id={`${id}-title`}>{waitingForSignIn ? 'Account sign-in is being connected.' : account.user ? 'Your Landwise account' : hosted && afterDraft ? 'Keep your draft. Take the next step.' : hosted ? 'Your free Landwise account' : 'Sign in to Landwise'}</h2>
      <p>{waitingForSignIn ? 'You can still use your first tailoring and download it. Account saving and additional AI actions will be available once sign-in is ready.' : account.user ? hosted ? 'Your drafts, fit reports, and application progress are saved to your account. No subscription required.' : 'Your applications are saved to this account. Your ChatGPT plan connection is separate.' : hosted ? 'Create an account or sign in with an email link. Get 3 free AI actions each month, save applications, and request follow-up changes.' : 'Use an email sign-in link to keep your drafts, fit reports, and application progress in your own account.'}</p>
      {!account.user && <p className="landwise-account-note">{waitingForSignIn ? 'Download a copy of your finished draft before leaving this tab.' : hosted && afterDraft ? 'Keep this tab open while you sign in. You can choose to bring this draft into your account afterward. Download a copy before leaving this tab.' : hosted ? 'Your first tailoring needs no account. Signing in clears unsaved inputs from this tab.' : 'Sign in before uploading or using AI. Signing in or out clears the current draft from this tab.'}</p>}
    </div>
    {account.user ? <div className="landwise-account-session"><strong>{account.user.email || 'Signed in'}</strong><button type="button" onClick={account.signOut} disabled={account.busy}>{account.busy ? 'Signing out…' : 'Sign out of Landwise'}</button><span>Signing out clears this tab’s current draft.</span></div>
      : !waitingForSignIn && <form className="landwise-account-form" onSubmit={event => { event.preventDefault(); (onSignIn || account.signIn)(email); }}>
        <label htmlFor={`${id}-email`}>Email address</label>
        <div><input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={account.busy} placeholder="you@example.com" /><button disabled={account.busy || !email.trim()}>{account.busy ? 'Sending…' : 'Email me a sign-in link'}</button></div>
        <p>{hosted ? 'No password or paid plan needed.' : 'No password needed. This signs in to Landwise, not ChatGPT.'}</p>
      </form>}
    {account.error && <p className="landwise-account-error" role="alert">{account.error}</p>}
    {!waitingForSignIn && account.notice && <p className="landwise-account-notice" role="status">{account.notice}</p>}
  </section>;
}
