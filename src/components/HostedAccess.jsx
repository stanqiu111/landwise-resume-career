import { GUEST_TAILORINGS, LOCAL_SETUP_URL, hostedActionAccess } from '../hostedAccess';
import './HostedAccess.css';

export default function HostedAccess({ connection, signedIn, onSignIn, accountAvailable = true }) {
  const access = hostedActionAccess(connection.session, signedIn, 'transform', accountAvailable);
  const notConfigured = connection.session?.reason === 'configuration';
  return <section className="hosted-access" aria-label="Landwise AI availability">
    <div><span className="hosted-access-label">Landwise is free</span><h3>{notConfigured ? 'Resume AI is being connected.' : signedIn ? 'A little help for your next step.' : access.exhausted ? 'Your free tailorings are used.' : `Tailor up to ${GUEST_TAILORINGS} resumes. No signup.`}</h3><p role="status">{connection.loading ? 'Checking AI availability…' : access.message}</p></div>
    <p className="hosted-access-detail">{signedIn ? 'Tailoring, analysis, and follow-up edits each use one AI action. Saving, downloads, and career events don’t use your allowance.' : notConfigured ? `You’ll get ${GUEST_TAILORINGS} free tailorings with no signup once AI is ready.` : accountAvailable ? `After your ${GUEST_TAILORINGS} free tailorings, a free account includes 3 AI actions each month, or you can run Landwise on your own computer with your ChatGPT account.` : `After ${GUEST_TAILORINGS} free tailorings, run Landwise on your own computer with your ChatGPT account. Downloads and career events stay free.`}</p>
    {connection.error && <p className="hosted-access-error" role="alert">{connection.error}</p>}
    <div className="hosted-access-actions">{!signedIn && (access.local || !accountAvailable) && <a href={LOCAL_SETUP_URL} target="_blank" rel="noopener noreferrer">How to run it on your computer <span aria-hidden="true">↗</span></a>}{!signedIn && accountAvailable && <button type="button" onClick={onSignIn}>{connection.session?.guestEligible ? 'Already have an account? Sign in' : 'Create a free account or sign in'}</button>}{!connection.loading && ((!access.allowed && !access.exhausted) || connection.error) && <button type="button" onClick={connection.refresh}>Check availability</button>}</div>
  </section>;
}
