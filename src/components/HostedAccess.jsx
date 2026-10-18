import { hostedActionAccess } from '../hostedAccess';
import './HostedAccess.css';

export default function HostedAccess({ connection, signedIn, onSignIn, accountAvailable = true }) {
  const access = hostedActionAccess(connection.session, signedIn, 'transform', accountAvailable);
  const notConfigured = connection.session?.reason === 'configuration';
  return <section className="hosted-access" aria-label="Landwise AI availability">
    <div><span className="hosted-access-label">Landwise is free</span><h3>{notConfigured ? 'Resume AI is being connected.' : signedIn ? 'A little help for your next step.' : 'Start with one resume. No signup.'}</h3><p role="status">{connection.loading ? 'Checking AI availability…' : access.message}</p></div>
    <p className="hosted-access-detail">{notConfigured ? 'Your first tailoring will be free and won’t require signup once AI is ready.' : signedIn ? 'Tailoring, analysis, and follow-up edits each use one AI action. Saving, downloads, and career events don’t use your allowance.' : accountAvailable ? 'After your first tailoring, a free account includes 3 AI actions each month. No subscription required.' : 'Account sign-in is being connected. You can download your first tailored draft.'}</p>
    {connection.error && <p className="hosted-access-error" role="alert">{connection.error}</p>}
    <div className="hosted-access-actions">{!signedIn && accountAvailable && <button type="button" onClick={onSignIn}>{connection.session?.guestEligible ? 'Already have an account? Sign in' : 'Create a free account or sign in'}</button>}{!connection.loading && (!access.allowed || connection.error) && <button type="button" onClick={connection.refresh}>Check availability</button>}</div>
  </section>;
}
