import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  approximateRingArea,
  isPhysicalService,
  pointInPolygon,
  pointToRingDistanceMeters,
} from "./lib/data.mjs";

const root = new URL("../", import.meta.url);
const services = JSON.parse(
  await readFile(new URL("pregnancy_termination_services.json", root), "utf8"),
).filter(isPhysicalService);

const aroundClauses = services
  .map(
    ({ latitude, longitude }) =>
      `way(around:80,${latitude},${longitude})["building"];relation(around:80,${latitude},${longitude})["building"];`,
  )
  .join("\n");
const query = `[out:json][timeout:180];(\n${aroundClauses}\n);out tags geom;`;
const endpoints = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const execFileAsync = promisify(execFile);

async function fetchOverpass() {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      console.log(`Querying ${endpoint} for buildings near ${services.length} services…`);
      const { stdout } = await execFileAsync("curl", [
        "-fsS",
        "--max-time",
        "240",
        "-A",
        "safe-access-zones/0.1 (building matching)",
        "-H",
        "Accept: application/json",
        "--get",
        "--data-urlencode",
        `data=${query}`,
        endpoint,
      ], {
        maxBuffer: 50 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
      console.warn(`Overpass request failed: ${error.message}`);
    }
  }
  throw new Error(`All Overpass requests failed:\n${errors.join("\n")}`);
}

function closeRing(coordinates) {
  if (coordinates.length < 3) {
    return null;
  }
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coordinates.push([...first]);
  }
  return coordinates.length >= 4 ? coordinates : null;
}

function geometryToRing(geometry) {
  return closeRing(geometry.map(({ lon, lat }) => [lon, lat]));
}

function extractPolygons(element) {
  if (element.type === "way" && Array.isArray(element.geometry)) {
    const ring = geometryToRing(element.geometry);
    return ring ? [{ type: "Polygon", coordinates: [ring] }] : [];
  }
  if (element.type === "relation" && Array.isArray(element.members)) {
    return element.members
      .filter(
        (member) =>
          member.type === "way" &&
          (member.role === "outer" || member.role === "") &&
          Array.isArray(member.geometry),
      )
      .map((member) => geometryToRing(member.geometry))
      .filter(Boolean)
      .map((ring) => ({ type: "Polygon", coordinates: [ring] }));
  }
  return [];
}

function meaningfulNameTokens(value) {
  const ignored = new Set([
    "and",
    "centre",
    "center",
    "clinic",
    "medical",
    "myhealth",
    "shopping",
    "the",
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 2 && !ignored.has(token)),
  );
}

function isNamedShoppingCentreMatch(serviceName, candidateName) {
  if (!/\bshopping cent(?:re|er)\b/i.test(candidateName)) {
    return false;
  }
  const serviceTokens = meaningfulNameTokens(serviceName);
  const candidateTokens = meaningfulNameTokens(candidateName);
  return [...candidateTokens].some((token) => serviceTokens.has(token));
}

const response = await fetchOverpass();
const candidates = response.elements.flatMap((element) =>
  extractPolygons(element).map((geometry) => ({
    geometry,
    osm_type: element.type,
    osm_id: element.id,
    osm_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    name: element.tags?.name || "",
    building: element.tags?.building || "",
    address: [
      element.tags?.["addr:housenumber"],
      element.tags?.["addr:street"],
    ]
      .filter(Boolean)
      .join(" "),
    area: approximateRingArea(geometry.coordinates[0]),
  })),
);

const matches = [];
const unmatchedCandidates = [];
for (const service of services) {
  const point = [service.longitude, service.latitude];
  const containing = candidates
    .filter((candidate) => pointInPolygon(point, candidate.geometry))
    .sort((left, right) => left.area - right.area);
  let match = containing[0];
  if (!match) {
    const nearby = candidates
      .map((candidate) => ({
        ...candidate,
        distance_m: pointToRingDistanceMeters(
          point,
          candidate.geometry.coordinates[0],
        ),
      }))
      .filter((candidate) => candidate.distance_m <= 80)
      .sort((left, right) => left.distance_m - right.distance_m)
      .slice(0, 5)
      .map(({ area, ...candidate }) => ({
        ...candidate,
        distance_m: Math.round(candidate.distance_m * 10) / 10,
      }));
    const shoppingCentre = nearby.find((candidate) =>
      isNamedShoppingCentreMatch(service.name, candidate.name),
    );
    if (shoppingCentre) {
      match = {
        ...shoppingCentre,
        area: approximateRingArea(shoppingCentre.geometry.coordinates[0]),
        confidence: "named-shopping-centre-site",
      };
    }
    if (match) {
      matches.push({
        service_id: service.id,
        service_name: service.name,
        osm_type: match.osm_type,
        osm_id: match.osm_id,
        osm_url: match.osm_url,
        osm_name: match.name,
        confidence: match.confidence,
        matched_at: new Date().toISOString(),
        geometry: match.geometry,
      });
      continue;
    }
    const nearestDistance = nearby[0]?.distance_m;
    const triage_reason =
      nearestDistance === undefined
        ? "no-building-mapped-within-80m"
        : nearestDistance <= 10
          ? "likely-geocode-offset-near-building-edge"
          : nearestDistance <= 40
            ? "nearby-buildings-require-manual-selection"
            : "no-close-containing-footprint";
    unmatchedCandidates.push({
      service_id: service.id,
      service_name: service.name,
      state: service.state,
      suburb: service.suburb,
      latitude: service.latitude,
      longitude: service.longitude,
      triage_reason,
      candidates: nearby,
    });
    continue;
  }
  matches.push({
    service_id: service.id,
    service_name: service.name,
    osm_type: match.osm_type,
    osm_id: match.osm_id,
    osm_url: match.osm_url,
    osm_name: match.name,
    confidence: "point-contained-by-building",
    matched_at: new Date().toISOString(),
    geometry: match.geometry,
  });
}

const outputDirectory = new URL("data/osm/", root);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL("building-boundaries.json", outputDirectory),
  `${JSON.stringify(matches, null, 2)}\n`,
  "utf8",
);
await writeFile(
  new URL("unmatched-building-candidates.json", outputDirectory),
  `${JSON.stringify(unmatchedCandidates, null, 2)}\n`,
  "utf8",
);

console.log(
  `Matched ${matches.length}/${services.length} service points to containing OSM building footprints.`,
);
console.log(
  `Wrote ${unmatchedCandidates.length} unmatched records with nearby candidates for manual triage.`,
);
