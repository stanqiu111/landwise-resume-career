const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function getCurrentDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function eventDate(resource) {
  if (resource.kind !== 'event') return null;
  return parseDate(resource.startDate) ? resource.startDate : parseDate(resource.endDate) ? resource.endDate : null;
}

function hasValidCoordinates(coordinates) {
  return coordinates != null
    && Number.isFinite(coordinates.latitude) && Math.abs(coordinates.latitude) <= 90
    && Number.isFinite(coordinates.longitude) && Math.abs(coordinates.longitude) <= 180;
}

export function getResourceDistanceKm(resource, userLocation) {
  if (!hasValidCoordinates(userLocation) || !hasValidCoordinates(resource.coordinates)) return null;
  if (/^(online|virtual)$/i.test(resource.format?.trim() || '')) return null;

  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDifference = radians(resource.coordinates.latitude - userLocation.latitude);
  const longitudeDifference = radians(resource.coordinates.longitude - userLocation.longitude);
  const haversine = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(radians(userLocation.latitude)) * Math.cos(radians(resource.coordinates.latitude))
    * Math.sin(longitudeDifference / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

export function getVisibleCareerResources(resources, filters = {}, today = getCurrentDate()) {
  const words = (filters.query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const savedIds = new Set(filters.savedIds || []);
  const sortByDistance = filters.sortBy === 'nearest' && hasValidCoordinates(filters.userLocation);

  return resources.filter(resource => {
    if (resource.kind === 'event' && !eventDate(resource)) return false;
    const lastDay = parseDate(resource.endDate) ? resource.endDate : eventDate(resource);
    if (resource.kind === 'event' && lastDay && lastDay < today) return false;
    if (filters.location && filters.location !== 'all' && resource.city !== filters.location) return false;
    if (filters.country && filters.country !== 'all' && resource.country !== filters.country) return false;
    if (filters.school && filters.school !== 'all' && resource.school !== filters.school) return false;
    if (filters.audience && filters.audience !== 'all' && resource.audience !== filters.audience) return false;
    if (filters.savedOnly && !savedIds.has(resource.id)) return false;

    const searchText = [
      resource.title, resource.organizer, resource.school, resource.city, resource.province, resource.country,
      resource.audience, resource.eligibility, resource.description, resource.sourceLabel,
      resource.sourceUrl, resource.format, resource.dateDetails, resource.startDate, resource.endDate,
    ].filter(Boolean).join(' ').toLowerCase();
    return words.every(word => searchText.includes(word));
  }).sort((a, b) => {
    const aDate = eventDate(a);
    const bDate = eventDate(b);
    if (aDate && !bDate) return -1;
    if (bDate && !aDate) return 1;
    if (sortByDistance) {
      const aDistance = getResourceDistanceKm(a, filters.userLocation);
      const bDistance = getResourceDistanceKm(b, filters.userLocation);
      if (aDistance !== null && bDistance === null) return -1;
      if (bDistance !== null && aDistance === null) return 1;
      if (aDistance !== null && bDistance !== null && aDistance !== bDistance) return aDistance - bDistance;
    }
    if (aDate && bDate) return aDate.localeCompare(bDate);
    return 0;
  });
}

export function getResourceDateLabel(resource) {
  if (resource.kind === 'calendar') return 'See organizer calendar';
  const start = parseDate(resource.startDate);
  const end = parseDate(resource.endDate);
  if (!start && !end) return resource.dateDetails?.trim() || 'Date to be announced';
  if (!start) return dateFormatter.format(end);
  if (!end || end <= start) return dateFormatter.format(start);

  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return dateFormatter.format(start).replace(String(start.getUTCDate()) + ',', `${start.getUTCDate()}–${end.getUTCDate()},`);
  }
  return `${dateFormatter.format(start)} – ${dateFormatter.format(end)}`;
}
