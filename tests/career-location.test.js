import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerLocationStore } from '../src/careerLocation.js';

function locationHarness(overrides = {}) {
  const requests = [];
  const geolocation = {
    getCurrentPosition(success, failure, options) {
      requests.push({ success, failure, options });
    },
  };
  const store = createCareerLocationStore({
    getGeolocation: () => geolocation,
    isSecureContext: () => true,
    ...overrides,
  });
  return { store, requests };
}

const position = (latitude = 53.5461, longitude = -113.4938) => ({
  coords: { latitude, longitude },
});

test('creating and reading the store never requests or accesses browser location', () => {
  let accesses = 0;
  const store = createCareerLocationStore({
    getGeolocation: () => { accesses += 1; },
    isSecureContext: () => { accesses += 1; return true; },
  });
  const initial = store.getSnapshot();
  const unsubscribe = store.subscribe(() => {});
  assert.deepEqual(initial, { status: 'idle', coordinates: null });
  assert.equal(store.getSnapshot(), initial);
  unsubscribe();
  assert.equal(accesses, 0);
});

test('success stores only coarse coordinates and requests low-accuracy cached location', () => {
  const { store, requests } = locationHarness();
  store.request();
  assert.deepEqual(store.getSnapshot(), { status: 'loading', coordinates: null });
  assert.deepEqual(requests[0].options, {
    enableHighAccuracy: false, timeout: 10000, maximumAge: 300000,
  });
  requests[0].success(position());
  assert.deepEqual(store.getSnapshot(), {
    status: 'ready', coordinates: { latitude: 53.55, longitude: -113.49 },
  });
  const ready = store.getSnapshot();
  assert.equal(store.getSnapshot(), ready);
});

test('valid zero coordinates and coordinate boundaries are accepted', () => {
  for (const [latitude, longitude] of [[0, 0], [-90, -180], [90, 180]]) {
    const { store, requests } = locationHarness();
    store.request();
    requests[0].success(position(latitude, longitude));
    assert.deepEqual(store.getSnapshot(), {
      status: 'ready', coordinates: { latitude, longitude },
    });
  }
});

test('automatic requests run once and loading requests are deduplicated even with retry', () => {
  const { store, requests } = locationHarness();
  store.request();
  const loading = store.getSnapshot();
  store.request();
  store.request({ retry: true });
  assert.equal(store.getSnapshot(), loading);
  assert.equal(requests.length, 1);
  requests[0].success(position());
  const ready = store.getSnapshot();
  store.request();
  assert.equal(requests.length, 1);
  assert.equal(store.getSnapshot(), ready);

  store.request({ retry: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(store.getSnapshot(), { status: 'loading', coordinates: ready.coordinates });
  requests[1].failure({ code: 1 });
  assert.deepEqual(store.getSnapshot(), { status: 'denied', coordinates: null });
  store.request();
  assert.equal(requests.length, 2);
  store.request({ retry: true });
  assert.equal(requests.length, 3);
  requests[2].success(position(0, 0));
  assert.equal(store.getSnapshot().status, 'ready');
});

test('refresh keeps the previous coarse location while loading and after transient failures', () => {
  const { store, requests } = locationHarness();
  store.request();
  requests[0].success(position());
  const previousCoordinates = store.getSnapshot().coordinates;

  for (const [code, status] of [[3, 'timeout'], [2, 'unavailable']]) {
    store.request({ retry: true });
    assert.deepEqual(store.getSnapshot(), { status: 'loading', coordinates: previousCoordinates });
    requests.at(-1).failure({ code });
    assert.deepEqual(store.getSnapshot(), { status, coordinates: previousCoordinates });
    assert.equal(store.getSnapshot().coordinates, previousCoordinates);
  }

  store.request({ retry: true });
  requests.at(-1).success(position(NaN, 0));
  assert.deepEqual(store.getSnapshot(), { status: 'unavailable', coordinates: previousCoordinates });

  store.request({ retry: true });
  assert.equal(store.getSnapshot().coordinates, previousCoordinates);
  requests.at(-1).success(position(43.6532, -79.3832));
  assert.deepEqual(store.getSnapshot(), {
    status: 'ready', coordinates: { latitude: 43.65, longitude: -79.38 },
  });
});

test('refresh clears previous location when permission, security, or browser support is lost', () => {
  for (const status of ['denied', 'insecure', 'unsupported']) {
    let secure = true;
    let supported = true;
    const requests = [];
    const store = createCareerLocationStore({
      isSecureContext: () => secure,
      getGeolocation: () => supported ? {
        getCurrentPosition(success, failure) { requests.push({ success, failure }); },
      } : undefined,
    });
    store.request();
    requests[0].success(position());
    assert.ok(store.getSnapshot().coordinates);

    secure = status !== 'insecure';
    supported = status !== 'unsupported';
    store.request({ retry: true });
    if (status === 'denied') requests[1].failure({ code: 1 });
    assert.deepEqual(store.getSnapshot(), { status, coordinates: null });
  }
});

test('duplicate callbacks and callbacks from a previous attempt cannot change the latest snapshot', () => {
  const { store, requests } = locationHarness();
  store.request();
  requests[0].failure({ code: 3 });
  const timeout = store.getSnapshot();
  requests[0].success(position());
  requests[0].failure({ code: 1 });
  assert.equal(store.getSnapshot(), timeout);

  store.request({ retry: true });
  const loading = store.getSnapshot();
  requests[0].success(position());
  assert.equal(store.getSnapshot(), loading);
  requests[1].success(position(0, 0));
  const ready = store.getSnapshot();
  requests[1].success(position());
  requests[1].failure({ code: 2 });
  assert.equal(store.getSnapshot(), ready);
});

test('browser errors map to denial, timeout, or unavailability without coordinates', () => {
  for (const [error, status] of [
    [{ code: 1 }, 'denied'], [{ code: 3 }, 'timeout'],
    [{ code: 2 }, 'unavailable'], [{ code: 9 }, 'unavailable'],
    [undefined, 'unavailable'],
  ]) {
    const { store, requests } = locationHarness();
    store.request();
    requests[0].failure(error);
    assert.deepEqual(store.getSnapshot(), { status, coordinates: null });
    store.request();
    assert.equal(requests.length, 1);
  }
});

test('malformed coordinates are rejected rather than becoming a successful location', () => {
  for (const malformed of [
    undefined, null, {}, { coords: null }, { coords: {} },
    position('53', 0), position(0, '-113'), position(NaN, 0), position(0, NaN),
    position(Infinity, 0), position(0, -Infinity), position(90.01, 0),
    position(-90.01, 0), position(0, 180.01), position(0, -180.01),
    { get coords() { throw new Error('Unavailable position'); } },
  ]) {
    const { store, requests } = locationHarness();
    store.request();
    requests[0].success(malformed);
    assert.deepEqual(store.getSnapshot(), { status: 'unavailable', coordinates: null });
  }
});

test('missing geolocation support has a terminal unsupported state', () => {
  for (const geolocation of [undefined, null, {}, { getCurrentPosition: true }]) {
    const { store } = locationHarness({ getGeolocation: () => geolocation });
    store.request();
    assert.deepEqual(store.getSnapshot(), { status: 'unsupported', coordinates: null });
  }
});

test('an insecure context is rejected before accessing geolocation', () => {
  let accesses = 0;
  const { store } = locationHarness({
    isSecureContext: () => false,
    getGeolocation: () => { accesses += 1; },
  });
  store.request();
  assert.deepEqual(store.getSnapshot(), { status: 'insecure', coordinates: null });
  assert.equal(accesses, 0);
});

test('exceptions from browser support checks or the location request become unavailable', () => {
  const fail = () => { throw new Error('Browser request failed'); };
  for (const overrides of [
    { isSecureContext: fail },
    { getGeolocation: fail },
    { getGeolocation: () => ({ getCurrentPosition: fail }) },
  ]) {
    const { store } = locationHarness(overrides);
    store.request();
    assert.deepEqual(store.getSnapshot(), { status: 'unavailable', coordinates: null });
  }
});

test('subscribers receive each new snapshot once and unsubscribe stops notifications', () => {
  const { store, requests } = locationHarness();
  const observed = [];
  const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
  const initial = store.getSnapshot();
  store.request();
  store.request();
  requests[0].success(position());
  requests[0].failure({ code: 1 });
  assert.deepEqual(observed.map(snapshot => snapshot.status), ['loading', 'ready']);
  assert.notEqual(observed[0], initial);
  assert.notEqual(observed[1], observed[0]);
  assert.equal(observed[1], store.getSnapshot());
  unsubscribe();
  store.request({ retry: true });
  requests[1].failure({ code: 2 });
  assert.equal(observed.length, 2);
});
