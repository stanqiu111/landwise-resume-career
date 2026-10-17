import { useEffect, useRef, useState } from 'react';
import CareerEvents from './CareerEvents';
import '../App.css';
import './PublicLaunch.css';

function currentView() {
  return ['#career-events', '#public-events-content'].includes(window.location.hash) ? 'events' : window.location.hash === '#resume' ? 'resume' : 'home';
}

function JourneyCard() {
  return <aside className="public-journey" aria-label="What you can do with Landwise">
    <div className="public-journey-top"><span>Your next chapter</span><span aria-hidden="true">✦</span></div>
    <div className="public-journey-item is-available">
      <span className="public-journey-number">01</span>
      <div><span className="public-feature-state">Available now</span><h3>Find a real connection.</h3><p>Campus fairs. Public events.<br />A chance to meet your next team.</p><a href="#career-events">Explore career events</a></div>
    </div>
    <div className="public-journey-item">
      <span className="public-journey-number">02</span>
      <div><span className="public-feature-state">Coming soon</span><h3>Make your experience count.</h3><p>A clearer resume for the role you want,<br />with your story kept intact.</p></div>
    </div>
    <div className="public-journey-item">
      <span className="public-journey-number">03</span>
      <div><span className="public-feature-state">Coming soon</span><h3>Know your next step.</h3><p>Understand your fit, build the right skills,<br />and prepare with a little more clarity.</p></div>
    </div>
    <p className="public-journey-foot">Built around the experience you already have.</p>
  </aside>;
}

export default function PublicLaunch() {
  const [view, setView] = useState(currentView);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const homeRef = useRef(null);
  const resumeRef = useRef(null);
  const eventsRef = useRef(null);
  const eventsOpen = view === 'events';

  useEffect(() => {
    const navigate = () => setView(currentView());
    window.addEventListener('hashchange', navigate);
    return () => { window.removeEventListener('hashchange', navigate); clearTimeout(toastTimer.current); };
  }, []);

  useEffect(() => {
    document.title = eventsOpen ? 'Career events in Canada & the US | Landwise' : 'Landwise — Your next opportunity';
    const target = view === 'resume' ? resumeRef.current : eventsOpen ? eventsRef.current : homeRef.current;
    target?.focus({ preventScroll: true });
    if (view === 'resume') target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
  }, [view, eventsOpen]);

  function notify(message) {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 4500);
  }

  return <div className="public-launch">
    <a className="public-skip" href={eventsOpen ? '#public-events-content' : '#public-home-content'}>Skip to content</a>
    <header className="public-header">
      <a className="public-brand" href="#home" aria-label="Landwise home"><span className="public-brand-icon" aria-hidden="true">L<i /></span><span>landwise<span>.</span></span></a>
      <nav className="public-navigation" aria-label="Main navigation">
        <a href="#career-events" aria-current={eventsOpen ? 'page' : undefined}>Career events <span className="public-nav-dot" aria-hidden="true" /></a>
        <a href="#resume" aria-current={view === 'resume' ? 'page' : undefined}>Resume tailoring <span className="public-nav-soon">Soon</span></a>
      </nav>
      <span className="public-preview-badge">Public preview</span>
    </header>

    {toast && <div className="public-toast" role="status"><span>{toast}</span><button type="button" onClick={() => setToast('')} aria-label="Dismiss notification">×</button></div>}

    <main>
      <div hidden={eventsOpen}>
        <section className="public-hero public-container" id="public-home-content" ref={homeRef} tabIndex={-1} aria-labelledby="public-hero-title">
          <div className="public-hero-copy">
            <p className="public-eyebrow"><span /> FOR YOUR NEXT CHAPTER</p>
            <h1 id="public-hero-title">A little clarity.<br />Your next<br /><em>opportunity.</em></h1>
            <p className="public-hero-description">You’ve got experience worth sharing. Find the people, places, and next steps that help it go further.</p>
            <div className="public-hero-actions"><a className="public-primary-link" href="#career-events">Explore career events</a><a className="public-text-link" href="#resume">What’s coming next</a></div>
            <p className="public-free-note"><span aria-hidden="true">✓</span> Landwise is free to use. No signup to browse.</p>
          </div>
          <JourneyCard />
        </section>

        <section className="public-available public-container" aria-labelledby="public-available-title">
          <div><p className="public-section-label">OPEN THE DOOR</p><h2 id="public-available-title">A conversation can change<br />what comes next.</h2></div>
          <div className="public-available-copy"><p>Explore student career fairs and public hiring events across Canada and the United States. Filter by area or school, save interesting events, and go straight to the organizer’s website.</p><a className="public-text-link" href="#career-events">Find your next connection</a></div>
          <div className="public-available-details"><span><i aria-hidden="true">◎</i> Canada & United States</span><span><i aria-hidden="true">◇</i> Campus & public events</span><span><i aria-hidden="true">✓</i> Original organizer sources</span></div>
        </section>

        <section className="public-coming public-container" id="resume" ref={resumeRef} tabIndex={-1} aria-labelledby="public-coming-title">
          <div className="public-coming-copy"><p className="public-coming-badge">Resume tailoring · Coming soon</p><h2 id="public-coming-title">Your story.<br />A little more focused.</h2><p>We’re preparing the resume studio for the public site. AI tailoring isn’t available in this preview yet.</p><p>The aim is simple: small, relevant edits to your real experience, plus clear feedback on your fit and the skills to build next.</p></div>
          <div className="public-coming-plan"><h3>Here’s the plan</h3><ol><li><span>01</span><div><strong>Try your first tailoring without signing up.</strong><p>When it opens, start with your resume and a job description.</p></div></li><li><span>02</span><div><strong>Keep going with your own ChatGPT plan.</strong><p>Later tailoring will use your eligible ChatGPT plan and its usage limits. Landwise itself stays free.</p></div></li></ol><p className="public-plan-note">Career events are ready to explore today.</p><a href="#career-events">Browse available events</a></div>
        </section>
      </div>

      <section hidden={!eventsOpen} className="public-events public-container" id="public-events-content" ref={eventsRef} tabIndex={-1} aria-label="Career event directory">
        <h1 className="public-sr-only">Career events in Canada and the United States</h1>
        <div className="public-events-status"><span><i aria-hidden="true" /> Career events are available now</span><a href="#resume">Resume tailoring is coming soon</a></div>
        <CareerEvents active={eventsOpen} onNotify={notify} publicPreview />
      </section>
    </main>

    <footer className="public-footer public-container"><a className="public-footer-wordmark" href="#home">landwise<span>.</span></a><p>Free tools for your next opportunity.<br />Check organizer websites for event registration and eligibility.</p><span>Made for the next step.</span></footer>
  </div>;
}
