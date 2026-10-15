// Keep location in memory for this mounted directory and only ask when requested.
export function createCareerLocationStore({
  getGeolocation = () => globalThis.navigator?.geolocation,
  isSecureContext = () => globalThis.isSecureContext !== false,
} = {}) {
  let snapshot = Object.freeze({ status: 'idle', coordinates: null });
  let attempted = false;
  const listeners = new Set();

  function publish(status, coordinates = null) {
    snapshot = Object.freeze({ status, coordinates });
    for (const listener of [...listeners]) listener();
  }

  function request({ retry = false } = {}) {
    if (snapshot.status === 'loading' || (attempted && !retry)) return;
    attempted = true;
    const previousCoordinates = snapshot.coordinates;
    publish('loading', previousCoordinates);

    let settled = false;
    function settle(status, coordinates = null) {
      if (settled) return;
      settled = true;
      // A temporary refresh failure should keep the existing nearby ordering.
      publish(status, status === 'timeout' || status === 'unavailable'
        ? previousCoordinates : coordinates);
    }

    try {
      if (!isSecureContext()) {
        settle('insecure');
        return;
      }
      const geolocation = getGeolocation();
      if (typeof geolocation?.getCurrentPosition !== 'function') {
        settle('unsupported');
        return;
      }

      geolocation.getCurrentPosition(
        position => {
          if (settled) return;
          let coordinates;
          try {
            const { latitude, longitude } = position?.coords ?? {};
            if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
              || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
              settle('unavailable');
              return;
            }
            // City-level ordering does not require storing precise coordinates.
            coordinates = Object.freeze({
              latitude: Math.round(latitude * 100) / 100 || 0,
              longitude: Math.round(longitude * 100) / 100 || 0,
            });
          } catch {
            settle('unavailable');
            return;
          }
          settle('ready', coordinates);
        },
        error => settle(error?.code === 1 ? 'denied' : error?.code === 3 ? 'timeout' : 'unavailable'),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      );
    } catch {
      settle('unavailable');
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request,
  };
}
