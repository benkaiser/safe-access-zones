import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const stagingDirectory = path.resolve("data/source-staging");
const userAgent =
  "safe-access-zones/0.1 (https://github.com/benkaiser/safe-access-zones)";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "au");
  url.searchParams.set("limit", "5");
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": userAgent },
  });
  if (!response.ok) {
    throw new Error(`Nominatim returned HTTP ${response.status}`);
  }
  return response.json();
}

const stateDirectories = (
  await readdir(stagingDirectory, { withFileTypes: true })
).filter((entry) => entry.isDirectory());
const report = [];
let requestCount = 0;

async function geocodeWithRateLimit(query) {
  if (requestCount > 0) await sleep(1100);
  const results = await geocode(query);
  requestCount += 1;
  return results;
}

function isFacilityResult(result) {
  return (
    ["amenity", "building", "healthcare", "office", "shop"].includes(
      result.category,
    ) ||
    [
      "building",
      "clinic",
      "doctors",
      "healthcare",
      "hospital",
      "house",
      "office",
    ].includes(result.addresstype)
  );
}

for (const stateDirectory of stateDirectories) {
  const file = path.join(stagingDirectory, stateDirectory.name, "providers.json");
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  let changed = false;
  for (const record of document.records) {
    if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) {
      continue;
    }
    const queries = [
      [record.address, "Australia"],
      [
        record.name,
        record.address,
        record.suburb,
        record.state,
        record.postcode,
        "Australia",
      ],
      [
        record.address,
        record.suburb,
        record.state,
        record.postcode,
        "Australia",
      ],
      [record.name, record.suburb, record.state, "Australia"],
      [record.name, record.state, "Australia"],
    ]
      .map((parts) => parts.filter(Boolean).join(", "))
      .filter((query, index, all) => query && all.indexOf(query) === index);
    let match;
    let matchedQuery = queries[0];
    for (const query of queries) {
      const results = await geocodeWithRateLimit(query);
      const facilityResult = results.find(isFacilityResult);
      if (facilityResult) {
        match = facilityResult;
        matchedQuery = query;
        break;
      }
    }
    if (!match) {
      report.push({
        state: record.state,
        source_record_id: record.source_record_id,
        name: record.name,
        queries,
        status: "unmatched",
      });
      continue;
    }
    record.latitude = Number(match.lat);
    record.longitude = Number(match.lon);
    report.push({
      state: record.state,
      source_record_id: record.source_record_id,
      name: record.name,
      query: matchedQuery,
      status: "matched",
      latitude: record.latitude,
      longitude: record.longitude,
      display_name: match.display_name,
      osm_type: match.osm_type,
      osm_id: match.osm_id,
    });
    changed = true;
  }
  if (changed) {
    document.source.geocoding = {
      provider: "OpenStreetMap Nominatim",
      geocoded_at: new Date().toISOString(),
      public_attribution: "© OpenStreetMap contributors",
    };
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  }
}

await mkdir(stagingDirectory, { recursive: true });
await writeFile(
  path.join(stagingDirectory, "geocoding-report.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      requests: requestCount,
      matches: report,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Geocoded ${report.filter((item) => item.status === "matched").length}/${report.length} missing facility locations.`,
);
