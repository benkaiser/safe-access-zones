import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  approximateRingArea,
  isPhysicalService,
  pointInPolygon,
  pointToRingDistanceMeters,
} from "./lib/data.mjs";
import { readServiceSources } from "./lib/services.mjs";

const root = new URL("../", import.meta.url);
const { healthdirect, supplemental } = await readServiceSources(root);
const services = [...healthdirect, ...supplemental].filter(isPhysicalService);
const existingMatches = JSON.parse(
  await readFile(new URL("data/osm/building-boundaries.json", root), "utf8"),
);
const overrides = JSON.parse(
  await readFile(new URL("data/curation-overrides.json", root), "utf8"),
);
const serviceIds = new Set(services.map((service) => service.id));
const preservedMatches = existingMatches.filter((match) =>
  serviceIds.has(match.service_id),
);
const resolvedIds = new Set([
  ...preservedMatches.map((match) => match.service_id),
  ...Object.entries(overrides.locations)
    .filter(([, override]) => override.boundary)
    .map(([serviceId]) => serviceId),
]);
const servicesToMatch = services.filter((service) => !resolvedIds.has(service.id));
const batchSize = 10;
const cacheDirectory = new URL("data/osm/cache/", root);
const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const execFileAsync = promisify(execFile);

async function writeCache(cacheUrl, response) {
  await mkdir(cacheDirectory, { recursive: true });
  const temporaryUrl = new URL(
    `${cacheUrl.pathname.split("/").at(-1)}.${process.pid}.tmp`,
    cacheDirectory,
  );
  await writeFile(temporaryUrl, `${JSON.stringify(response)}\n`);
  await rename(temporaryUrl, cacheUrl);
}

function queryForServices(batch) {
  const aroundClauses = batch
    .map(
      ({ latitude, longitude }) =>
        `way(around:80,${latitude},${longitude})["building"];relation(around:80,${latitude},${longitude})["building"];`,
    )
    .join("\n");
  return `[out:json][timeout:90];(\n${aroundClauses}\n);out tags geom;`;
}

async function fetchOverpass(batch, batchNumber, totalBatches, depth = 0) {
  const query = queryForServices(batch);
  const cacheKey = createHash("sha256").update(query).digest("hex");
  const cacheUrl = new URL(`${cacheKey}.json`, cacheDirectory);
  try {
    const cached = JSON.parse(await readFile(cacheUrl, "utf8"));
    console.log(`Batch ${batchNumber}/${totalBatches}: using cached response.`);
    return cached;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const errors = [];
  const endpointOffset = (batchNumber - 1 + depth) % endpoints.length;
  const orderedEndpoints = [
    ...endpoints.slice(endpointOffset),
    ...endpoints.slice(0, endpointOffset),
  ];
  for (const endpoint of orderedEndpoints) {
    try {
      console.log(
        `Batch ${batchNumber}/${totalBatches}: querying ${endpoint} for ${batch.length} services…`,
      );
      const { stdout } = await execFileAsync("curl", [
        "-fsS",
        "--max-time",
        "120",
        "--retry",
        "1",
        "--retry-delay",
        "3",
        "--retry-all-errors",
        "-A",
        "safe-access-zones/0.1 (building matching)",
        "-H",
        "Accept: application/json",
        "--data-urlencode",
        `data=${query}`,
        endpoint,
      ], {
        maxBuffer: 50 * 1024 * 1024,
      });
      const response = JSON.parse(stdout);
      await writeCache(cacheUrl, response);
      return response;
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
      console.warn(`Overpass request failed: ${error.message}`);
    }
  }
  if (batch.length > 1) {
    const splitAt = Math.ceil(batch.length / 2);
    console.warn(
      `Batch ${batchNumber}/${totalBatches}: all mirrors failed; retrying as ${splitAt} and ${batch.length - splitAt} services.`,
    );
    const left = await fetchOverpass(
      batch.slice(0, splitAt),
      batchNumber,
      totalBatches,
      depth + 1,
    );
    const right = await fetchOverpass(
      batch.slice(splitAt),
      batchNumber,
      totalBatches,
      depth + 2,
    );
    const response = { elements: [...left.elements, ...right.elements] };
    await writeCache(cacheUrl, response);
    return response;
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

function candidatesFromResponse(response) {
  return response.elements.flatMap((element) =>
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
}

const matches = [...preservedMatches];
const unmatchedCandidates = [];
function matchServices(batch, candidates) {
  const batchMatches = [];
  const batchUnmatched = [];
  for (const service of batch) {
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
        batchMatches.push({
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
      batchUnmatched.push({
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
    batchMatches.push({
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
  return { batchMatches, batchUnmatched };
}

const totalBatches = Math.ceil(servicesToMatch.length / batchSize);
for (let index = 0; index < servicesToMatch.length; index += batchSize) {
  const batch = servicesToMatch.slice(index, index + batchSize);
  const response = await fetchOverpass(
    batch,
    Math.floor(index / batchSize) + 1,
    totalBatches,
  );
  const candidates = candidatesFromResponse(response);
  const { batchMatches, batchUnmatched } = matchServices(batch, candidates);
  matches.push(...batchMatches);
  unmatchedCandidates.push(...batchUnmatched);
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
await rm(cacheDirectory, { recursive: true, force: true });

console.log(
  `Preserved ${preservedMatches.length} existing matches and added ${matches.length - preservedMatches.length} OSM building matches.`,
);
console.log(
  `Wrote ${unmatchedCandidates.length}/${servicesToMatch.length} unresolved records with nearby candidates for manual triage.`,
);
