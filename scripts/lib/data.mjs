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

export function isPhysicalService(service) {
  return (
    !service.is_virtual &&
    Number.isFinite(service.latitude) &&
    Number.isFinite(service.longitude)
  );
}

export function stateGeometryNote(state) {
  const notes = {
    ACT: "Health Act 1993 (ACT) s 86 requires a ministerially declared area that is at least 50 m at every point from the protected facility, sufficient for privacy and access, and no larger than necessary. This map shows a generic 150 m building buffer, not the legal declaration.",
    NSW: "Public Health Act 2010 (NSW) s 98A covers the clinic premises and every place within 150 m of any part of those premises or a pedestrian access point to the building. This map buffers the mapped building and does not separately model pedestrian access points.",
    QLD: "Termination of Pregnancy Act 2018 (Qld) s 14 covers the premises and places no more than 150 m from an entrance, unless another distance is prescribed. This map instead buffers the entire mapped building, so its boundary can differ from the legal zone.",
    SA: "Health Care Act 2008 (SA) s 48B defines the health access zone as the protected premises plus public areas within 150 m. This map shows the full building buffer, including land that may not be a public area.",
    VIC: "Public Health and Wellbeing Act 2008 (Vic) s 185B defines the safe access zone as the area within a 150 m radius of premises where abortions are provided, excluding pharmacies. This map uses the mapped building as a proxy for the legal premises.",
    TAS: "Reproductive Health (Access to Terminations) Act 2013 (Tas) s 9 defines the access zone as the area within a 150 m radius of premises where terminations are provided. This map uses the mapped building as a proxy for the legal premises.",
    WA: "Public Health Act 2016 (WA) s 202O includes the abortion premises and the area within 150 m outside its boundary. This map buffers the mapped building, which may not exactly match the legal premises boundary.",
    NT: "Termination of Pregnancy Law Reform Act 2017 (NT) s 4 includes the premises for terminations and the area within 150 m outside its boundary. This map buffers the mapped building, which may not exactly match the legal premises boundary.",
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
