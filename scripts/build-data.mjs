import { readFile, mkdir, writeFile } from "node:fs/promises";
import buffer from "@turf/buffer";
import { feature, featureCollection, point } from "@turf/helpers";
import {
  CATEGORY_LABELS,
  classifyFacility,
  isPhysicalService,
  normalizeWebsite,
  stateGeometryNote,
} from "./lib/data.mjs";

const root = new URL("../", import.meta.url);

async function readJson(relativePath, fallback) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function makeAdditionService(addition) {
  return {
    id: addition.id,
    name: addition.name,
    service_type: "Pregnancy termination",
    suburb: addition.suburb,
    state: addition.state.toUpperCase(),
    postcode: "",
    latitude: addition.latitude,
    longitude: addition.longitude,
    phone: "",
    website: "",
    appointment_required: false,
    is_virtual: false,
    manual_category: addition.category,
    manual_note: addition.note,
    manual_source: true,
    source_synced_at: addition.added_at,
  };
}

const services = await readJson("pregnancy_termination_services.json", []);
const sourceMetadata = await readJson("data/source-metadata.json", null);
const buildingMatches = await readJson("data/osm/building-boundaries.json", []);
const overrides = await readJson("data/curation-overrides.json", {
  version: 1,
  locations: {},
  additions: [],
});

if (!Array.isArray(services)) {
  throw new Error("pregnancy_termination_services.json must contain an array");
}
if (
  !sourceMetadata ||
  typeof sourceMetadata.publisher !== "string" ||
  typeof sourceMetadata.dataset !== "string" ||
  typeof sourceMetadata.source_url !== "string" ||
  typeof sourceMetadata.synced_at !== "string" ||
  !Number.isFinite(Date.parse(sourceMetadata.synced_at))
) {
  throw new Error("data/source-metadata.json is missing required source details");
}
if (overrides.version !== 1) {
  throw new Error(`Unsupported curation override version: ${overrides.version}`);
}

const buildingsByService = new Map(
  buildingMatches.map((building) => [building.service_id, building]),
);
const allServices = [...services, ...overrides.additions.map(makeAdditionService)];
const locations = [];
const zones = [];
const uncertaintyZones = [];
const publishedBuildings = [];
const seenIds = new Set();

for (const service of allServices) {
  if (!isPhysicalService(service)) {
    continue;
  }
  if (!service.id || seenIds.has(service.id)) {
    throw new Error(`Missing or duplicate physical service id: ${service.id || "<empty>"}`);
  }
  seenIds.add(service.id);

  const override = overrides.locations[service.id];
  if (override?.removed) {
    continue;
  }

  const category =
    override?.category ?? service.manual_category ?? classifyFacility(service.name);
  if (!(category in CATEGORY_LABELS)) {
    throw new Error(`Invalid category "${category}" for ${service.name}`);
  }

  const automaticBuilding = buildingsByService.get(service.id);
  const boundaryGeometry = override?.boundary ?? automaticBuilding?.geometry;
  const acceptedCandidate =
    override?.boundary && override.triage_status === "accepted-candidate";
  const boundaryStatus = acceptedCandidate
    ? "matched"
    : override?.boundary
      ? "manual"
    : automaticBuilding
      ? "matched"
      : "unmatched";
  const geometrySource = acceptedCandidate
    ? "openstreetmap"
    : override?.boundary
      ? "manual"
    : automaticBuilding
      ? "openstreetmap"
      : "point";
  const zoneBasis = acceptedCandidate
    ? "osm-containing-building"
    : override?.boundary
      ? "manual-premises"
    : automaticBuilding
      ? "osm-containing-building"
      : "point-radius";
  const zoneConfidence = override?.boundary
    ? "reviewed"
    : automaticBuilding
      ? "building-match"
      : "approximate";

  const properties = {
    id: service.id,
    name: service.name,
    category,
    category_label: CATEGORY_LABELS[category],
    service_type: service.service_type || "Pregnancy termination",
    suburb: service.suburb || "",
    state: service.state || "",
    postcode: String(service.postcode || ""),
    phone: service.phone || "",
    website: normalizeWebsite(service.website),
    appointment_required: Boolean(service.appointment_required),
    geometry_source: geometrySource,
    boundary_status: boundaryStatus,
    zone_basis: zoneBasis,
    zone_confidence: zoneConfidence,
    legal_note: stateGeometryNote(service.state),
    osm_url: override?.selected_osm_url || automaticBuilding?.osm_url || "",
    data_source: service.manual_source
      ? "Manual curation"
      : "Healthdirect National Health Services Directory (NHSD)",
    data_source_url: service.manual_source ? "" : sourceMetadata.source_url,
    source_synced_at: service.manual_source
      ? service.source_synced_at
      : sourceMetadata.synced_at,
  };

  const servicePoint = point([service.longitude, service.latitude], properties, {
    id: service.id,
  });
  locations.push(servicePoint);

  let zoneInput = servicePoint;
  if (boundaryGeometry) {
    const boundaryFeature = feature(boundaryGeometry, {
      ...properties,
      source: geometrySource,
    });
    publishedBuildings.push(boundaryFeature);
    zoneInput = boundaryFeature;
  }

  const primaryZone = buffer(zoneInput, 0.15, {
    units: "kilometers",
    steps: 48,
  });
  if (!primaryZone) {
    throw new Error(`Unable to create a zone for ${service.name}`);
  }
  primaryZone.properties = properties;
  zones.push(primaryZone);

  if (!boundaryGeometry) {
    const uncertainty = buffer(servicePoint, 0.2, {
      units: "kilometers",
      steps: 48,
    });
    if (uncertainty) {
      uncertainty.properties = properties;
      uncertaintyZones.push(uncertainty);
    }
  }
}

const outputDirectory = new URL("public/data/", root);
await mkdir(outputDirectory, { recursive: true });

const outputs = {
  "locations.geojson": featureCollection(locations),
  "zones.geojson": featureCollection(zones),
  "uncertainty-zones.geojson": featureCollection(uncertaintyZones),
  "buildings.geojson": featureCollection(publishedBuildings),
};

for (const [filename, contents] of Object.entries(outputs)) {
  await writeFile(
    new URL(filename, outputDirectory),
    `${JSON.stringify(contents)}\n`,
    "utf8",
  );
}

const categories = Object.fromEntries(
  Object.keys(CATEGORY_LABELS).map((category) => [
    category,
    locations.filter((location) => location.properties.category === category).length,
  ]),
);
const metadata = {
  generated_at: new Date().toISOString(),
  source: {
    publisher: sourceMetadata.publisher,
    dataset: sourceMetadata.dataset,
    source_url: sourceMetadata.source_url,
    synced_at: sourceMetadata.synced_at,
  },
  source_records: services.length,
  physical_source_records: services.filter(isPhysicalService).length,
  excluded_virtual_records: services.filter((service) => service.is_virtual).length,
  published_locations: locations.length,
  matched_buildings: locations.filter(
    (location) => location.properties.boundary_status !== "unmatched",
  ).length,
  approximate_locations: locations.filter(
    (location) => location.properties.boundary_status === "unmatched",
  ).length,
  categories,
};
await writeFile(
  new URL("metadata.json", outputDirectory),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8",
);

console.log(
  `Generated ${locations.length} locations, ${zones.length} zones and ${publishedBuildings.length} building footprints.`,
);
