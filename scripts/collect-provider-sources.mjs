import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sources = {
  wa: {
    jurisdiction: "WA",
    name: "4Choice",
    url: "https://trheneve66.execute-api.ap-southeast-2.amazonaws.com/prod/getProviders",
    access: "private-evaluation",
    unwrap: (payload) => payload.body,
  },
  qld: {
    jurisdiction: "QLD",
    name: "Children by Choice Find a Service",
    url: "https://findaservice.childrenbychoice.org.au/data/ee07ec93-2b09-4acf-b0ec-5e5acef29d8e.json",
    access: "private-evaluation",
    unwrap: (payload) => payload,
  },
  vic: {
    jurisdiction: "VIC",
    name: "1800 My Options",
    url: "https://pubgeomapping.1800myoptions.org.au/data/services.json",
    access: "written-permission",
    unwrap: (payload) => payload,
  },
};

function usage() {
  console.error(
    "Usage: node scripts/collect-provider-sources.mjs <wa|qld|vic> " +
      "[--private-evaluation|--permission-confirmed]",
  );
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serviceFlags(properties) {
  return {
    medical_abortion: Boolean(properties.abortion_medical),
    surgical_abortion: Boolean(properties.abortion_surgical),
    telehealth: Boolean(
      properties.abortion_telehealth ?? properties.other_telehealth,
    ),
    surgical_referral: Boolean(properties.abortion_refsurgical),
  };
}

function roleFor(flags) {
  if (flags.medical_abortion && flags.surgical_abortion) {
    return "medical-and-surgical-provider";
  }
  if (flags.surgical_abortion) return "surgical-abortion-provider";
  if (flags.medical_abortion) return "medical-abortion-provider";
  if (flags.telehealth) return "telehealth-provider";
  if (flags.surgical_referral) return "referral-service";
  return "unclear";
}

function looksLikeIndividual(name) {
  return /^(associate professor|assoc\.? prof\.?|doctor|dr\.?|professor|prof\.?)\s/i.test(
    name,
  );
}

function normaliseFeature(feature, source) {
  const properties = feature?.properties ?? {};
  const name = cleanText(properties.name);
  const flags = serviceFlags(properties);
  const coordinates =
    feature?.geometry?.type === "Point" &&
    Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : [];

  if (
    !name ||
    looksLikeIndividual(name) ||
    properties.type === "PH" ||
    !(flags.medical_abortion || flags.surgical_abortion)
  ) {
    return null;
  }

  const serviceLabels = [
    flags.medical_abortion && "medical abortion",
    flags.surgical_abortion && "surgical abortion",
    flags.telehealth && "telehealth",
    flags.surgical_referral && "surgical referral",
  ].filter(Boolean);
  const sourceId = properties.id ?? properties.service_lookup_id;

  return {
    source_record_id: String(sourceId ?? `${name}-${coordinates.join("-")}`),
    name,
    provider_role: roleFor(flags),
    ...(cleanText(properties.address_label) && {
      address: cleanText(properties.address_label),
    }),
    ...(cleanText(properties.suburb) && { suburb: cleanText(properties.suburb) }),
    state: cleanText(properties.state) ?? source.jurisdiction,
    ...(cleanText(String(properties.postcode ?? "")) && {
      postcode: cleanText(String(properties.postcode)),
    }),
    latitude: nullableNumber(coordinates[1]),
    longitude: nullableNumber(coordinates[0]),
    services: flags,
    gestation_min_weeks: nullableNumber(properties.gestation_min),
    gestation_max_weeks: nullableNumber(properties.gestation_max),
    facility_level: true,
    source_url: source.url,
    source_updated_at:
      cleanText(properties.last_validated) ??
      cleanText(properties.date_modified) ??
      null,
    evidence: `Source flags: ${serviceLabels.join(", ")}.`,
    verification_status: "source-asserted",
  };
}

export function normaliseGeoJson(
  payload,
  source,
  retrievedAt,
  permissionStatus = "permission-required",
) {
  const geojson = source.unwrap(payload);
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new Error(`${source.name} did not return a GeoJSON FeatureCollection`);
  }

  const records = geojson.features
    .map((feature) => normaliseFeature(feature, source))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));

  const duplicateIds = records
    .map((record) => record.source_record_id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    throw new Error(`Duplicate source IDs: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  const sourceUpdateDates = records
    .map((record) => record.source_updated_at)
    .filter(Boolean)
    .map((date) => new Date(date))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  const latestSourceUpdate = sourceUpdateDates.at(-1);
  const staleSourceWarning =
    latestSourceUpdate &&
    new Date(retrievedAt).getTime() - latestSourceUpdate.getTime() >
      2 * 365 * 24 * 60 * 60 * 1000
      ? `The latest retained record validation date is ${
          latestSourceUpdate.toISOString().split("T")[0]
        }; re-verify every facility before public use.`
      : null;

  return {
    schema_version: 1,
    source: {
      jurisdiction: source.jurisdiction,
      name: source.name,
      url: source.url,
      retrieved_at: retrievedAt,
      extraction_method:
        permissionStatus === "permission-confirmed"
          ? "public-geojson-written-permission"
          : "public-geojson-private-evaluation",
      permission_status: permissionStatus,
      ...(permissionStatus === "permission-confirmed" && {
        permission_basis:
          "Written permission confirmed by the maintainer on 2026-09-16; " +
          "correspondence is retained outside the public repository.",
      }),
      source_feature_count: geojson.features.length,
      retained_facility_count: records.length,
    },
    records,
    ambiguities: [
      "Service flags and gestational limits are source assertions and require owner confirmation before publication.",
      "Coordinates identify source map points, not reviewed premises boundaries.",
      ...(staleSourceWarning ? [staleSourceWarning] : []),
    ],
  };
}

async function main() {
  const [sourceKey, ...options] = process.argv.slice(2);
  const source = sources[sourceKey];
  if (!source) {
    usage();
    process.exitCode = 2;
    return;
  }

  const permissionConfirmed = options.includes("--permission-confirmed");
  const privateEvaluation = options.includes("--private-evaluation");
  if (source.access === "written-permission" && !permissionConfirmed) {
    throw new Error(
      `${source.name} prohibits copying beyond personal use. Obtain written ` +
        "permission and rerun with --permission-confirmed.",
    );
  }
  if (
    source.access === "private-evaluation" &&
    !privateEvaluation &&
    !permissionConfirmed
  ) {
    throw new Error(
      "This unlicensed source may only be collected into git-ignored staging " +
        "for permission assessment. Rerun with --private-evaluation.",
    );
  }

  const response = await fetch(source.url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${source.name} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const document = normaliseGeoJson(
    payload,
    source,
    new Date().toISOString(),
    permissionConfirmed ? "permission-confirmed" : "permission-required",
  );
  const outputDirectory = path.resolve("data/source-staging", sourceKey);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "providers.json");
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `${source.name}: retained ${document.records.length} facility-level ` +
      `abortion-provider records from ${document.source.source_feature_count}; ` +
      `wrote ${path.relative(process.cwd(), outputPath)}`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
