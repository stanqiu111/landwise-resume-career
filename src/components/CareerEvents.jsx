import { useEffect, useState, useSyncExternalStore } from 'react';
import { careerResources } from '../data/careerEvents';
import { getVisibleCareerResources, getResourceDateLabel, getResourceDistanceKm } from '../careerEvents';
import { createCareerLocationStore } from '../careerLocation';
import './CareerEvents.css';

const SAVED_KEY = 'landwise.saved-career-events.v1';
const EMPTY_FILTERS = { query: '', country: 'all', location: 'all', school: 'all', audience: 'all' };
const distanceFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const LOCATION_MESSAGES = {
  idle: ['Find career events near you', 'Allow location access to put the closest cities first.'],
  loading: ['Finding nearby career events…', 'Allow location access in your browser. You can keep browsing while we check.'],
  denied: ['Choose your area below', 'Location is blocked. Allow it in your browser’s site settings or use the Location filter.'],
  timeout: ['Location took too long', 'Try again or choose a location below to explore events in that area.'],
  unavailable: ['Couldn’t find your location', 'Try again or choose a location below. All events are still available.'],
  unsupported: ['Choose your area below', 'This browser doesn’t support location access. Use the Location filter to find events.'],
  insecure: ['Choose your area below', 'Location access needs a secure connection. Open the HTTPS site or use the Location filter.'],
};

function Icon({ name, ...props }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18m-13 4h3m2 0h3" /></>,
    location: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
    external: <><path d="M14 3h7v7m0-7L10 14" /><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
    link: <><path d="m10 13 4-4m-6 6-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m2 2 2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0" transform="translate(1 1)" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function readSaved() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(id => careerResources.some(resource => resource.id === id)))] : [];
  } catch {
    return [];
  }
}

function ResourceCard({ resource, saved, onSave, onShare, userLocation }) {
  const sourceHost = new URL(resource.sourceUrl).hostname.replace(/^www\./, '');
  const distanceKm = getResourceDistanceKm(resource, userLocation);
  const verifiedLabel = new Date(`${resource.verifiedOn}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  return (
    <article className="career-card" aria-labelledby={`event-${resource.id}`}>
      <div className="career-card-top">
        <span className={`event-access ${resource.audience === 'public' ? 'event-access-public' : ''}`}>
          <span aria-hidden="true">{resource.audience === 'public' ? '◎' : '◇'}</span>
          {resource.audience === 'public' ? 'Public access' : 'Campus community'}
        </span>
        <button className={`event-save${saved ? ' is-saved' : ''}`} onClick={() => onSave(resource.id)} aria-pressed={saved} aria-label={`${saved ? 'Unsave' : 'Save'} ${resource.title}`} title={saved ? 'Remove from saved' : 'Save for later'}>
          <Icon name="bookmark" fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <p className="event-organizer">{resource.organizer}</p>
      <h4 id={`event-${resource.id}`}>{resource.title}</h4>
      <div className="event-meta">
        <p className="event-date"><Icon name="calendar" />{getResourceDateLabel(resource)}</p>
        <p><Icon name="location" />{resource.city.includes(resource.province) ? resource.city : `${resource.city}, ${resource.province}`} · {resource.country === 'Canada' ? 'Canada' : 'US'}</p>
        {distanceKm !== null && <p className="event-distance">{distanceKm < 1 ? 'Less than 1 km' : `About ${distanceFormatter.format(distanceKm)} km`} to {resource.city} city center</p>}
      </div>
      {resource.dateDetails && <p className="event-details">{resource.dateDetails}</p>}
      <p className="event-description">{resource.description}</p>
      <div className="event-eligibility">
        <span>Who can attend</span>
        <p>{resource.eligibility}</p>
        {resource.eligibilitySourceUrl && <a href={resource.eligibilitySourceUrl} target="_blank" rel="noopener noreferrer">Organizer’s access details <span aria-hidden="true">↗</span></a>}
      </div>
      <div className="event-card-footer">
        <div className="event-source-meta">
          <span>{sourceHost}</span>
          <span>Checked <time dateTime={resource.verifiedOn}>{verifiedLabel}</time></span>
        </div>
        <div className="event-card-actions">
          <a className="event-source-link" href={resource.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${resource.kind === 'event' ? 'View official event' : 'View official calendar'}: ${resource.title} on ${resource.sourceLabel} (opens in a new tab)`}>
            {resource.kind === 'event' ? 'View official event' : 'View official calendar'}<Icon name="external" />
          </a>
          <button className="event-share" onClick={() => onShare(resource)} aria-label={`Copy original source link for ${resource.title}`} title="Copy original source link"><Icon name="link" /></button>
        </div>
      </div>
    </article>
  );
}

export default function CareerEvents({ active, onNotify, publicPreview = false }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [savedOnly, setSavedOnly] = useState(false);
  const [savedIds, setSavedIds] = useState(readSaved);
  const [locationStore] = useState(createCareerLocationStore);
  const locationState = useSyncExternalStore(locationStore.subscribe, locationStore.getSnapshot, locationStore.getSnapshot);
  const [sortPreference, setSortPreference] = useState('automatic');
  const userLocation = locationState.coordinates;
  const sortBy = userLocation && sortPreference !== 'date' ? 'nearest' : 'date';
  const [locationTitle, defaultLocationDescription] = locationState.status === 'ready'
    ? [sortBy === 'nearest' ? 'Nearby events first' : 'Your location is ready', sortBy === 'nearest'
      ? 'Distances are approximate and measured to each event’s city center.'
      : 'Choose Nearest first to sort events by distance from you.']
    : LOCATION_MESSAGES[locationState.status];
  const locationDescription = userLocation && locationState.status !== 'ready'
    ? locationState.status === 'loading'
      ? 'Updating your location. Results use your previous location while we check.'
      : 'Results still use your previous location. Try again or choose an area below.'
    : defaultLocationDescription;

  // The component stays mounted to preserve filters, so only ask when its tab opens.
  // The store deduplicates requests across repeat visits and StrictMode effects.
  useEffect(() => {
    if (active) locationStore.request();
  }, [active, locationStore]);

  const activeResources = getVisibleCareerResources(careerResources);
  const countryResources = activeResources.filter(resource => filters.country === 'all' || resource.country === filters.country);
  const locations = [...new Set(countryResources.map(resource => resource.city))].sort();
  const schools = [...new Set(countryResources.map(resource => resource.school).filter(Boolean))].sort();
  const results = getVisibleCareerResources(careerResources, { ...filters, savedOnly, savedIds, sortBy, userLocation });
  const upcoming = results.filter(resource => resource.kind === 'event');
  const calendars = results.filter(resource => resource.kind === 'calendar');
  const savedCount = activeResources.filter(resource => savedIds.includes(resource.id)).length;
  const hasFilters = Object.entries(filters).some(([key, value]) => value !== EMPTY_FILTERS[key]);

  function updateFilter(key, value) {
    setFilters(previous => ({
      ...previous, [key]: value,
      ...(key === 'country' ? { location: 'all', school: 'all' } : {}),
    }));
  }

  function toggleSaved(id) {
    const next = savedIds.includes(id) ? savedIds.filter(savedId => savedId !== id) : [...savedIds, id];
    setSavedIds(next);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      onNotify(next.includes(id) ? 'Saved to this browser.' : 'Removed from saved resources.');
    } catch {
      onNotify('Your selection is kept for this visit. Browser storage is unavailable.');
    }
  }

  async function shareResource(resource) {
    try {
      await navigator.clipboard.writeText(resource.sourceUrl);
      onNotify('Original source link copied.');
    } catch {
      onNotify('Could not copy the link. Use the official source link to open and share the page.');
    }
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    setSavedOnly(false);
  }

  return (
    <div className="career-events">
      <div className="career-hero">
        <div className="career-hero-copy">
          <p className="career-eyebrow"><span /> BEYOND THE RESUME</p>
          <h2>Good opportunities<br /><em>start with a hello.</em></h2>
          <p>Find career fairs, meet employers, and take your next step. Campus and public events for students across Canada and the United States.</p>
        </div>
        <aside className="career-hero-note">
          <Icon name="calendar" width="26" height="26" />
          <div className="career-hero-note-copy">
            <h3>Your next move, in one place.</h3>
            <p>Find an event. Check who’s hiring. <br />Bring a resume that tells your story.</p>
          </div>
          <a href="#resume">{publicPreview ? 'Resume tailoring · Coming soon' : <>Prepare your resume <span aria-hidden="true">→</span></>}</a>
        </aside>
      </div>

      <div className="career-directory">
        <div className="career-directory-heading">
          <h3>Find your next connection</h3>
          <div className="career-view-toggle" role="group" aria-label="Resource view">
            <button aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>All resources</button>
            <button aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}><Icon name="bookmark" />Saved <span>{savedCount}</span></button>
          </div>
        </div>
        <div className="career-location-bar">
          <span className="career-location-icon"><Icon name="location" /></span>
          <div className="career-location-message" role="status">
            <strong>{locationTitle}</strong>
            <p>{locationDescription}</p>
          </div>
          <div className="career-location-actions">
            {!['unsupported', 'insecure'].includes(locationState.status) && (
              <button className="career-location-request" onClick={() => locationStore.request({ retry: true })} disabled={locationState.status === 'loading'}>
                {locationState.status === 'loading' ? 'Locating…' : locationState.status === 'ready' ? 'Update location' : 'Use my location'}
              </button>
            )}
            <label className="career-sort">
              <span>Sort by</span>
              <select value={sortBy} onChange={event => setSortPreference(event.target.value)}>
                <option value="date">Soonest first</option>
                <option value="nearest" disabled={!userLocation}>Nearest first</option>
              </select>
            </label>
          </div>
        </div>
        <div className="career-filters">
          <label className="career-search">
            <span>Search events & schools</span>
            <div><Icon name="search" /><input type="search" placeholder="School, employer, or keyword…" value={filters.query} onChange={event => updateFilter('query', event.target.value)} /></div>
          </label>
          <label>
            <span>Country</span>
            <select value={filters.country} onChange={event => updateFilter('country', event.target.value)}>
              <option value="all">Canada & United States</option><option>Canada</option><option>United States</option>
            </select>
          </label>
          <label>
            <span>Location</span>
            <select value={filters.location} onChange={event => updateFilter('location', event.target.value)}>
              <option value="all">All locations</option>{locations.map(location => <option key={location}>{location}</option>)}
            </select>
          </label>
          <label>
            <span>School</span>
            <select value={filters.school} onChange={event => updateFilter('school', event.target.value)}>
              <option value="all">All schools & organizers</option>{schools.map(school => <option key={school}>{school}</option>)}
            </select>
          </label>
          <label>
            <span>Access</span>
            <select value={filters.audience} onChange={event => updateFilter('audience', event.target.value)}>
              <option value="all">All access types</option><option value="public">Open to the public</option><option value="campus">Campus community</option>
            </select>
          </label>
        </div>
        <div className="career-results-meta">
          <p role="status">{results.length} {results.length === 1 ? 'resource' : 'resources'}{savedOnly ? ' saved' : ''}{hasFilters ? ' matching your filters' : ' to explore'}</p>
          {(hasFilters || savedOnly) && <button onClick={resetFilters}>Clear filters</button>}
        </div>
        <p className="career-source-note">Curated from original organizer websites. Check the source for registration, eligibility, and schedule changes. Saved resources stay in this browser.</p>

        {results.length === 0 && (
          <div className="career-empty">
            <Icon name={savedOnly ? 'bookmark' : 'search'} width="32" height="32" />
            <h3>{savedOnly && savedCount === 0 ? 'Your next opportunity is out there.' : 'No resources match these filters.'}</h3>
            <p>{savedOnly && savedCount === 0 ? 'Save an event or calendar to keep it handy for later. Past events leave this list automatically.' : 'Try another school or location, or explore all resources.'}</p>
            <button onClick={resetFilters}>Explore all resources <span aria-hidden="true">→</span></button>
          </div>
        )}

        {[
          { title: 'Upcoming & ongoing events', subtitle: sortBy === 'nearest' ? 'Closest cities first · Dates announced by the organizer' : 'Dates announced by the organizer', resources: upcoming },
          { title: 'Keep an eye on these calendars', subtitle: sortBy === 'nearest' ? 'Closest cities first · Regional calendars follow' : 'Find more fairs, employer sessions, and networking opportunities', resources: calendars },
        ].filter(group => group.resources.length > 0).map(group => (
          <section className="career-resource-group" key={group.title} aria-label={group.title}>
            <div className="career-group-heading"><h3>{group.title}</h3><p>{group.subtitle}</p></div>
            <div className="career-grid">
              {group.resources.map(resource => <ResourceCard key={resource.id} resource={resource} saved={savedIds.includes(resource.id)} onSave={toggleSaved} onShare={shareResource} userLocation={userLocation} />)}
            </div>
          </section>
        ))}
      </div>

      <aside className="career-prep">
        <div><p className="career-eyebrow">MAKE THE MOST OF THE FAIR</p><h3>Turn a conversation into an application.</h3></div>
        <ol>
          <li><span>01</span><div><strong>Choose your employers</strong><p>Check the organizer’s employer list and pick a few you’d like to meet.</p></div></li>
          <li><span>02</span><div><strong>Prepare your introduction</strong><p>Share what you study, what you’ve built, and the kind of role you’re exploring.</p></div></li>
          <li><span>03</span><div><strong>{publicPreview ? 'Keep the role in mind' : 'Tailor your application'}</strong><p>{publicPreview ? 'Save job descriptions that interest you, and review your relevant experience before applying.' : 'Find a role you like, then bring its job description to the resume studio.'}</p></div></li>
        </ol>
        <a href="#resume">{publicPreview ? 'See what’s coming to Landwise' : <>Work on my resume <span aria-hidden="true">→</span></>}</a>
      </aside>
    </div>
  );
}
