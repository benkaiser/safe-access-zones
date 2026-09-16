export const CATEGORY_LABELS = {
  clinic: "Abortion clinic",
  doctor: "Doctor / general practice",
  hospital: "Hospital",
};

const CLINIC_PATTERN =
  /\b(msi|clinic|family planning|pregnancy advisory|gynaehealth|day surgery)\b/i;
const HOSPITAL_PATTERN = /\bhospital\b/i;

export function classifyFacility(name) {
  if (HOSPITAL_PATTERN.test(name)) {
    return "hospital";
  }
  if (CLINIC_PATTERN.test(name)) {
    return "clinic";
  }
  return "doctor";
}

export function normalizeWebsite(value) {
  if (!value) {
    return "";
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function isPhysicalService(service) {
  return (
    !service.is_virtual &&
    Number.isFinite(service.latitude) &&
    Number.isFinite(service.longitude)
  );
}

export function stateGeometryNote(state) {
  const notes = {
    ACT: "The ACT uses declared protected areas rather than a general 150 m rule; this geometry is indicative only.",
    NSW: "Simplified premises-based geometry; NSW pedestrian access points are not included.",
    QLD: "Simplified premises-based geometry; Queensland zones are ordinarily measured from premises entrances.",
    SA: "Simplified radius; the South Australian rule applies to qualifying public areas.",
    VIC: "Indicative 150 m area generated from the best available premises geometry.",
    TAS: "Indicative 150 m area generated from the best available premises geometry.",
    WA: "Indicative 150 m area generated from the best available premises geometry.",
    NT: "Indicative 150 m area generated from the best available premises geometry.",
  };
  return notes[state] ?? "Indicative geometry generated from the best available location.";
}

export function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentLongitude, currentLatitude] = ring[index];
    const [previousLongitude, previousLatitude] = ring[previous];
    const intersects =
      currentLatitude > latitude !== previousLatitude > latitude &&
      longitude <
        ((previousLongitude - currentLongitude) * (latitude - currentLatitude)) /
          (previousLatitude - currentLatitude) +
          currentLongitude;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(point, polygon) {
  const [outer, ...holes] = polygon.coordinates;
  return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
}

export function approximateRingArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

export function pointToRingDistanceMeters([longitude, latitude], ring) {
  const latitudeRadians = (latitude * Math.PI) / 180;
  const metersPerLongitudeDegree = 111_320 * Math.cos(latitudeRadians);
  const metersPerLatitudeDegree = 110_540;
  let minimumDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index];
    const end = ring[index + 1];
    if (!start || !end) {
      continue;
    }
    const startX = (start[0] - longitude) * metersPerLongitudeDegree;
    const startY = (start[1] - latitude) * metersPerLatitudeDegree;
    const endX = (end[0] - longitude) * metersPerLongitudeDegree;
    const endY = (end[1] - latitude) * metersPerLatitudeDegree;
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const projection =
      segmentLengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared),
          );
    const closestX = startX + projection * segmentX;
    const closestY = startY + projection * segmentY;
    minimumDistance = Math.min(
      minimumDistance,
      Math.hypot(closestX, closestY),
    );
  }

  return minimumDistance;
}
