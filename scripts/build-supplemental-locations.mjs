import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("../", import.meta.url);
const stagingDirectory = new URL("data/source-staging/", root);
const organisationWords =
  /\b(aboriginal|associates|ATSICHS|bubble|campus|care|centre|centres|center|choice|choices|clinic|community|connect|cohealth|doctors?|family|foundation|general|generation|GP|group|health|hospital|LUMA|MATSICHS|med|medical|MSI|myhealth|online|options|planning|practice|reproductive|rokeby|service|services|smart clinics|surgery|telehealth|university|wellness|woman|women)\b/i;
const coordinateOverrides = JSON.parse(
  await readFile(
    new URL("data/supplemental-coordinate-overrides.json", root),
    "utf8",
  ),
);

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(the|pty|ltd)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(normalizeText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeText(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function distanceMeters(left, right) {
  if (
    !Number.isFinite(left.latitude) ||
    !Number.isFinite(left.longitude) ||
    !Number.isFinite(right.latitude) ||
    !Number.isFinite(right.longitude)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const latitude1 = left.latitude * radians;
  const latitude2 = right.latitude * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sameState(left, right) {
  return String(left.state).toUpperCase() === String(right.state).toUpperCase();
}

function matchesHealthdirect(candidate, trusted) {
  if (!sameState(candidate, trusted)) return false;
  const distance = distanceMeters(candidate, trusted);
  if (distance <= 60) return true;
  const nameSimilarity = tokenSimilarity(candidate.name, trusted.name);
  if (normalizeText(candidate.name) === normalizeText(trusted.name)) {
    return (
      distance <= 2_000 ||
      normalizeText(candidate.suburb) === normalizeText(trusted.suburb)
    );
  }
  return nameSimilarity >= 0.6 && distance <= 300;
}

function addressKey(record) {
  return normalizeText(
    [record.address, record.suburb, record.state, record.postcode]
      .filter(Boolean)
      .join(" "),
  );
}

function matchesSupplemental(candidate, kept) {
  if (!sameState(candidate, kept)) return false;
  const candidateAddress = addressKey(candidate);
  const keptAddress = addressKey(kept);
  if (candidateAddress && candidateAddress === keptAddress) return true;
  const distance = distanceMeters(candidate, kept);
  if (distance <= 20) return true;
  if (normalizeText(candidate.name) === normalizeText(kept.name)) {
    return distance <= 2_000;
  }
  return tokenSimilarity(candidate.name, kept.name) >= 0.75 && distance <= 150;
}

function qualityScore(record) {
  return (
    Number(record.services?.medical_abortion) +
    Number(record.services?.surgical_abortion) * 2 +
    Number(Boolean(record.address)) +
    Number(record.verification_status === "source-asserted")
  );
}

function looksLikeIndividual(record) {
  const name = String(record.name ?? "").trim();
  if (
    /^(associate professor|assoc\.? prof\.?|doctor|dr\.?|professor|prof\.?)\s/i.test(
      name,
    )
  ) {
    return true;
  }
  return (
    !organisationWords.test(name) &&
    /^[\p{L}'-]+(?:\s+[\p{L}'-]+){1,2}$/u.test(name)
  );
}

function stableId(record) {
  const key = [
    record.state,
    normalizeText(record.name),
    Number(record.latitude).toFixed(5),
    Number(record.longitude).toFixed(5),
  ].join("|");
  return `supplemental-${String(record.state).toLowerCase()}-${createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 16)}`;
}

const healthdirect = JSON.parse(
  await readFile(new URL("pregnancy_termination_services.json", root), "utf8"),
).filter(
  (record) =>
    !record.is_virtual &&
    Number.isFinite(record.latitude) &&
    Number.isFinite(record.longitude),
);
const candidates = [];
for (const entry of await readdir(stagingDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = new URL(`${entry.name}/providers.json`, stagingDirectory);
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (document.source?.permission_status !== "permission-confirmed") {
    throw new Error(`${entry.name} does not have confirmed publication permission`);
  }
  candidates.push(...document.records);
}

for (const candidate of candidates) {
  const override = coordinateOverrides.find(
    (item) =>
      item.state === candidate.state &&
      normalizeText(item.name) === normalizeText(candidate.name),
  );
  if (override) {
    candidate.latitude = override.latitude;
    candidate.longitude = override.longitude;
  }
}

candidates.sort(
  (left, right) =>
    qualityScore(right) - qualityScore(left) ||
    String(left.state).localeCompare(String(right.state)) ||
    left.name.localeCompare(right.name) ||
    left.source_record_id.localeCompare(right.source_record_id),
);

const kept = [];
const report = {
  generated_at: new Date().toISOString(),
  input_records: candidates.length,
  suppressed_healthdirect: 0,
  suppressed_supplemental_duplicate: 0,
  missing_coordinates: 0,
  excluded_individual_clinicians: 0,
  published_records: 0,
  by_state: {},
  healthdirect_matches: [],
  supplemental_duplicates: [],
};
for (const candidate of candidates) {
  if (looksLikeIndividual(candidate)) {
    report.excluded_individual_clinicians += 1;
    continue;
  }
  if (
    !Number.isFinite(candidate.latitude) ||
    !Number.isFinite(candidate.longitude)
  ) {
    report.missing_coordinates += 1;
    continue;
  }
  const trustedMatch = healthdirect.find((trusted) =>
    matchesHealthdirect(candidate, trusted),
  );
  if (trustedMatch) {
    report.suppressed_healthdirect += 1;
    report.healthdirect_matches.push({
      candidate_name: candidate.name,
      trusted_name: trustedMatch.name,
      state: candidate.state,
      distance_m: Math.round(distanceMeters(candidate, trustedMatch)),
    });
    continue;
  }
  const supplementalMatch = kept.find((record) =>
    matchesSupplemental(candidate, record),
  );
  if (supplementalMatch) {
    report.suppressed_supplemental_duplicate += 1;
    report.supplemental_duplicates.push({
      discarded_name: candidate.name,
      kept_name: supplementalMatch.name,
      state: candidate.state,
      distance_m: Math.round(distanceMeters(candidate, supplementalMatch)),
    });
    continue;
  }
  kept.push(candidate);
}

const output = kept
  .map((record) => ({
    id: stableId(record),
    name: record.name,
    service_type: "Pregnancy termination",
    suburb: record.suburb ?? "",
    state: String(record.state).toUpperCase(),
    postcode: String(record.postcode ?? ""),
    latitude: record.latitude,
    longitude: record.longitude,
    is_virtual: false,
    appointment_required: false,
  }))
  .sort(
    (left, right) =>
      left.state.localeCompare(right.state) || left.name.localeCompare(right.name),
  );

for (const record of output) {
  report.by_state[record.state] = (report.by_state[record.state] ?? 0) + 1;
}
report.published_records = output.length;

const outputDirectory = new URL("data/", root);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL("supplemental-locations.json", outputDirectory),
  `${JSON.stringify(output, null, 2)}\n`,
);
await writeFile(
  new URL("supplemental-dedup-report.json", outputDirectory),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Built ${output.length} sanitized supplemental locations from ${candidates.length} permitted records; suppressed ${report.suppressed_healthdirect} Healthdirect matches and ${report.suppressed_supplemental_duplicate} supplemental duplicates.`,
);
