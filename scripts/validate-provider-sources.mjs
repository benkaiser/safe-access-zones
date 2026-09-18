import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const stateCodes = new Set(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]);
const roles = new Set([
  "medical-abortion-provider",
  "surgical-abortion-provider",
  "medical-and-surgical-provider",
  "telehealth-provider",
  "referral-service",
  "unclear",
]);
const statuses = new Set(["source-asserted", "ambiguous", "requires-review"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateRecord(record, file, ids) {
  const label = `${file}:${record.source_record_id ?? "unknown"}`;
  assert(typeof record.source_record_id === "string", `${label}: invalid ID`);
  assert(!ids.has(record.source_record_id), `${label}: duplicate ID`);
  ids.add(record.source_record_id);
  assert(typeof record.name === "string" && record.name.trim(), `${label}: missing name`);
  assert(!/^(dr\.?|doctor|prof\.?|professor)\s/i.test(record.name), `${label}: named clinician`);
  assert(!/pharmacy/i.test(record.name), `${label}: pharmacy`);
  assert(roles.has(record.provider_role), `${label}: invalid provider role`);
  assert(stateCodes.has(record.state), `${label}: invalid state code`);
  assert(record.facility_level === true, `${label}: not a facility`);
  assert(statuses.has(record.verification_status), `${label}: invalid status`);
  assert(typeof record.source_url === "string", `${label}: missing source URL`);
  assert(typeof record.evidence === "string" && record.evidence.trim(), `${label}: missing evidence`);
  assert(record.services && typeof record.services === "object", `${label}: missing services`);

  const checkedText = [record.name, record.address, record.evidence]
    .filter(Boolean)
    .join(" ");
  assert(!/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(checkedText), `${label}: email retained`);
  assert(!/\b(?:\+?61|0)[2-478](?:[\s()-]*\d){8}\b/.test(checkedText), `${label}: phone retained`);

  const { latitude, longitude } = record;
  assert((latitude == null) === (longitude == null), `${label}: partial coordinates`);
  if (latitude != null) {
    assert(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90, `${label}: invalid latitude`);
    assert(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180, `${label}: invalid longitude`);
  }
}

export async function validateDirectory(directory) {
  const states = await readdir(directory, { withFileTypes: true });
  const summaries = [];
  for (const state of states.filter((entry) => entry.isDirectory())) {
    const file = path.join(directory, state.name, "providers.json");
    let document;
    try {
      document = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert(document.schema_version === 1, `${file}: invalid schema version`);
    assert(stateCodes.has(document.source?.jurisdiction), `${file}: invalid source jurisdiction`);
    assert(Array.isArray(document.records), `${file}: missing records`);
    assert(Array.isArray(document.ambiguities), `${file}: missing ambiguities`);
    const ids = new Set();
    for (const record of document.records) validateRecord(record, file, ids);
    summaries.push({
      state: document.source.jurisdiction,
      source: document.source.name,
      records: document.records.length,
      review: document.records.filter((record) => record.verification_status !== "source-asserted").length,
      ambiguities: document.ambiguities.length,
    });
  }
  return summaries.sort((left, right) => left.state.localeCompare(right.state));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validateDirectory(path.resolve("data/source-staging"))
    .then((summaries) => {
      for (const summary of summaries) {
        console.log(
          `${summary.state}: ${summary.records} records, ${summary.review} review, ` +
            `${summary.ambiguities} ambiguities — ${summary.source}`,
        );
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
