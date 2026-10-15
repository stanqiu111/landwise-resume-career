import test from 'node:test';
import assert from 'node:assert/strict';
import { getResourceDateLabel, getResourceDistanceKm, getVisibleCareerResources } from '../src/careerEvents.js';
import { careerResources } from '../src/data/careerEvents.js';

const today = '2026-10-14';
const resource = (overrides = {}) => ({
  id: 'fair', title: 'Student career fair', organizer: 'University of Alberta',
  school: 'University of Alberta', city: 'Edmonton', province: 'Alberta', country: 'Canada', audience: 'campus',
  eligibility: 'Students and alumni', description: 'Meet engineering employers.',
  sourceUrl: 'https://example.edu/careers', sourceLabel: 'University career centre',
  kind: 'event', startDate: '2026-11-03', format: 'In person', verifiedOn: today,
  ...overrides,
});
const ids = resources => resources.map(item => item.id);
const edmonton = { latitude: 53.5461, longitude: -113.4938 };
const toronto = { latitude: 43.6532, longitude: -79.3832 };

test('events expire after their final day, including multi-day events', () => {
  const resources = [
    resource({ id: 'past', startDate: '2026-10-13' }),
    resource({ id: 'today', startDate: today }),
    resource({ id: 'ongoing', startDate: '2026-10-12', endDate: today }),
    resource({ id: 'finished', startDate: '2026-10-11', endDate: '2026-10-13' }),
    resource({ id: 'future', startDate: '2026-11-03' }),
  ];
  assert.deepEqual(ids(getVisibleCareerResources(resources, {}, today)), ['ongoing', 'today', 'future']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {}, '2026-10-15')), ['future']);
});

test('dated events sort first without mutating input, and calendars retain their input order', () => {
  const resources = [
    resource({ id: 'calendar-a', kind: 'calendar', startDate: '2025-01-01' }),
    resource({ id: 'later', startDate: '2026-12-01' }),
    resource({ id: 'calendar-b', kind: 'calendar', startDate: undefined }),
    resource({ id: 'earlier', startDate: '2026-11-01' }),
    resource({ id: 'same-day', startDate: '2026-11-01' }),
  ];
  const before = ids(resources);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {}, today)), ['earlier', 'same-day', 'later', 'calendar-a', 'calendar-b']);
  assert.deepEqual(ids(resources), before);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {}, '2027-01-01')), ['calendar-a', 'calendar-b']);
});

test('search words can match different fields and combine with location, campus, and audience filters', () => {
  const resources = [
    resource({ id: 'match' }),
    resource({ id: 'public', audience: 'public', school: null }),
    resource({ id: 'other-school', school: 'MacEwan University' }),
    resource({ id: 'other-city', city: 'Calgary' }),
    resource({ id: 'other-field', description: 'Meet healthcare employers.' }),
  ];
  const filters = {
    query: '  ALUMNI \nengineering   ', location: 'Edmonton',
    school: 'University of Alberta', audience: 'campus',
  };
  assert.deepEqual(ids(getVisibleCareerResources(resources, filters, today)), ['match']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { ...filters, audience: 'public' }, today)), []);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { ...filters, school: 'all', audience: 'public' }, today)), ['public']);
});

test('saved filtering respects the other filters and does not retain expired events', () => {
  const resources = [
    resource({ id: 'saved' }),
    resource({ id: 'unsaved' }),
    resource({ id: 'past-saved', startDate: '2026-10-13' }),
    resource({ id: 'saved-calendar', kind: 'calendar', city: 'Calgary' }),
  ];
  const filters = { savedOnly: true, savedIds: ['saved', 'past-saved', 'saved-calendar', 'missing'] };
  assert.deepEqual(ids(getVisibleCareerResources(resources, filters, today)), ['saved', 'saved-calendar']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { ...filters, location: 'Edmonton' }, today)), ['saved']);
  assert.deepEqual(getVisibleCareerResources(resources, { savedOnly: true }, today), []);
});

test('country and school filters include public campus events and distinguish Canadian and US resources', () => {
  const resources = [
    resource({ id: 'nait-community', school: 'NAIT', audience: 'public' }),
    resource({ id: 'nait-students', school: 'NAIT' }),
    resource({ id: 'us-campus', school: 'University of Washington', country: 'United States', city: 'Seattle', province: 'Washington' }),
  ];
  assert.deepEqual(ids(getVisibleCareerResources(resources, { country: 'Canada', school: 'NAIT', audience: 'public' }, today)), ['nait-community']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { country: 'United States' }, today)), ['us-campus']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { query: 'united states alumni', country: 'all' }, today)), ['us-campus']);
  assert.deepEqual(getVisibleCareerResources(resources, { country: 'United States', school: 'NAIT' }, today), []);
});

test('date labels retain the date and year and show ranges without timezone conversion', () => {
  assert.equal(getResourceDateLabel(resource()), 'Nov 3, 2026');
  assert.equal(getResourceDateLabel(resource({ endDate: '2026-11-04' })), 'Nov 3–4, 2026');
  assert.equal(getResourceDateLabel(resource({ endDate: '2026-11-03' })), 'Nov 3, 2026');
  assert.equal(getResourceDateLabel(resource({ startDate: '2026-12-31', endDate: '2027-01-01' })), 'Dec 31, 2026 – Jan 1, 2027');
  assert.equal(getResourceDateLabel(resource({ kind: 'calendar' })), 'See organizer calendar');
});

test('missing or invalid dates have useful labels and do not enter the dated event directory', () => {
  const invalid = resource({ startDate: '2026-02-30', endDate: 'not-a-date' });
  assert.equal(getResourceDateLabel(invalid), 'Date to be announced');
  assert.equal(getResourceDateLabel({ ...invalid, dateDetails: '  Organizer announces dates each term.  ' }), 'Organizer announces dates each term.');
  assert.equal(getResourceDateLabel({ ...invalid, endDate: '2026-11-04' }), 'Nov 4, 2026');
  assert.deepEqual(getVisibleCareerResources([invalid, resource({ startDate: undefined })], {}, today), []);
  assert.deepEqual(ids(getVisibleCareerResources([{ ...invalid, kind: 'calendar' }], {}, today)), ['fair']);
});

test('nearest sorting puts later local events ahead of earlier distant ones and sorts calendars separately', () => {
  const resources = [
    resource({ id: 'far-calendar', kind: 'calendar', coordinates: toronto }),
    resource({ id: 'far-sooner', startDate: '2026-10-15', coordinates: toronto }),
    resource({ id: 'near-later', startDate: '2026-12-01', coordinates: edmonton }),
    resource({ id: 'near-calendar', kind: 'calendar', coordinates: edmonton }),
    resource({ id: 'near-sooner', startDate: '2026-11-01', coordinates: edmonton }),
    resource({ id: 'regional-calendar', kind: 'calendar', city: 'Across Alberta' }),
  ];
  const before = structuredClone(resources);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {
    sortBy: 'nearest', userLocation: edmonton,
  }, today)), ['near-sooner', 'near-later', 'far-sooner', 'near-calendar', 'far-calendar', 'regional-calendar']);
  assert.deepEqual(resources, before);
});

test('date sorting remains the default and nearest sorting falls back to dates without valid user coordinates', () => {
  const resources = [
    resource({ id: 'near-later', startDate: '2026-12-01', coordinates: edmonton }),
    resource({ id: 'far-sooner', startDate: '2026-10-15', coordinates: toronto }),
  ];
  const expected = ['far-sooner', 'near-later'];
  assert.deepEqual(ids(getVisibleCareerResources(resources, { userLocation: edmonton }, today)), expected);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { sortBy: 'date', userLocation: edmonton }, today)), expected);
  for (const userLocation of [undefined, null, {}, { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 }, { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity }, { latitude: '0', longitude: 0 }]) {
    assert.deepEqual(ids(getVisibleCareerResources(resources, { sortBy: 'nearest', userLocation }, today)), expected);
  }
});

test('distance uses great-circle kilometres, supports zero coordinates, and handles the date line', () => {
  const origin = { latitude: 0, longitude: 0 };
  assert.equal(getResourceDistanceKm(resource({ coordinates: origin }), origin), 0);
  assert.ok(Math.abs(getResourceDistanceKm(resource({
    coordinates: { latitude: 0, longitude: 1 },
  }), origin) - 111.195) < 0.01);
  assert.ok(Math.abs(getResourceDistanceKm(resource({
    coordinates: { latitude: 0, longitude: -179 },
  }), { latitude: 0, longitude: 179 }) - 222.39) < 0.01);
  const resources = [
    resource({ id: 'distant', coordinates: { latitude: 0, longitude: 1 } }),
    resource({ id: 'zero', coordinates: origin }),
  ];
  assert.deepEqual(ids(getVisibleCareerResources(resources, { sortBy: 'nearest', userLocation: origin }, today)), ['zero', 'distant']);
});

test('invalid or missing resource coordinates and online resources have no distance and follow located events', () => {
  const resources = [
    resource({ id: 'unknown', startDate: '2026-10-16' }),
    resource({ id: 'invalid-latitude', startDate: '2026-10-17', coordinates: { latitude: -91, longitude: 0 } }),
    resource({ id: 'invalid-longitude', startDate: '2026-10-18', coordinates: { latitude: 0, longitude: 181 } }),
    resource({ id: 'invalid-number', startDate: '2026-10-19', coordinates: { latitude: 0, longitude: NaN } }),
    resource({ id: 'online', startDate: '2026-10-20', format: 'Online', coordinates: edmonton }),
    resource({ id: 'virtual', startDate: '2026-10-21', format: 'Virtual', coordinates: edmonton }),
    resource({ id: 'located', startDate: '2026-12-01', coordinates: toronto }),
  ];
  for (const item of resources.slice(0, -1)) assert.equal(getResourceDistanceKm(item, edmonton), null);
  assert.equal(getResourceDistanceKm(resources.at(-1), null), null);
  assert.deepEqual(ids(getVisibleCareerResources(resources, { sortBy: 'nearest', userLocation: edmonton }, today)), [
    'located', 'unknown', 'invalid-latitude', 'invalid-longitude', 'invalid-number', 'online', 'virtual',
  ]);
});

test('nearest sorting preserves expiry, saved selections, and explicit country, city, school, and audience filters', () => {
  const resources = [
    resource({ id: 'far-saved', city: 'Toronto', school: 'U of T', coordinates: toronto }),
    resource({ id: 'near-saved', coordinates: edmonton }),
    resource({ id: 'far-unsaved', city: 'Toronto', school: 'U of T', coordinates: toronto }),
    resource({ id: 'far-expired', city: 'Toronto', school: 'U of T', startDate: '2026-10-13', coordinates: toronto }),
    resource({ id: 'other-country', city: 'Toronto', school: 'U of T', country: 'United States', coordinates: toronto }),
    resource({ id: 'other-school', city: 'Toronto', school: 'Other university', coordinates: toronto }),
    resource({ id: 'other-audience', city: 'Toronto', school: 'U of T', audience: 'public', coordinates: toronto }),
  ];
  const savedIds = resources.filter(item => item.id !== 'far-unsaved').map(item => item.id);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {
    sortBy: 'nearest', userLocation: edmonton, savedOnly: true, savedIds,
    country: 'Canada', location: 'Toronto', school: 'U of T', audience: 'campus',
  }, today)), ['far-saved']);
  assert.deepEqual(ids(getVisibleCareerResources(resources, {
    sortBy: 'nearest', userLocation: edmonton, savedOnly: true, savedIds: ['near-saved', 'far-saved', 'far-expired'],
  }, today)), ['near-saved', 'far-saved']);
});

test('curated city resources have valid approximate coordinates while regional calendars have no point distance', () => {
  const regional = careerResources.find(item => item.city === 'Across Alberta');
  assert.equal(regional.coordinates, undefined);
  assert.equal(getResourceDistanceKm(regional, edmonton), null);
  for (const item of careerResources.filter(item => item !== regional)) {
    assert.equal(Number.isFinite(getResourceDistanceKm(item, edmonton)), true, item.id);
  }
  const local = careerResources.filter(item => item.city === 'Edmonton');
  assert.ok(local.length > 0);
  assert.ok(local.every(item => getResourceDistanceKm(item, edmonton) === 0));
});
