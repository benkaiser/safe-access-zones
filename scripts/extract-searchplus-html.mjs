import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceUrl = "https://searchplus.org.au/";
const organisationWords =
  /\b(aboriginal|care|centre|centres|center|choice|clinic|community|doctors|family|group|health|hospital|medical|MSI|online|planning|practice|service|services|surgery|telehealth|women)\b/i;

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decodeFlightData(html) {
  let flightData = "";
  for (const match of html.matchAll(
    /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g,
  )) {
    const push = match[1].match(/^self\.__next_f\.push\((.*)\)$/s);
    if (!push) continue;
    try {
      const chunk = JSON.parse(push[1]);
      if (chunk[0] === 1 && typeof chunk[1] === "string") {
        flightData += chunk[1];
      }
    } catch {
      // Ignore non-JSON bootstrap scripts; provider data must parse below.
    }
  }
  const rootRecord = flightData
    .split("\n")
    .find((record) => record.startsWith("4:"));
  if (!rootRecord) {
    throw new Error("SEARCH+ HTML does not contain the expected RSC root record");
  }
  return JSON.parse(rootRecord.slice(2));
}

function findPrefetchedData(root) {
  const matches = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (
      !Array.isArray(value) &&
      Array.isArray(value.providers) &&
      Array.isArray(value.services)
    ) {
      matches.push(value);
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
  }
  visit(root);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one SEARCH+ provider payload, found ${matches.length}`,
    );
  }
  return matches[0];
}

function resolveRscReference(value, root) {
  if (typeof value !== "string" || !value.startsWith("$4:")) return value;
  let current = root;
  for (const token of value.slice(3).split(":")) {
    if (token === "props" && Array.isArray(current) && current[0] === "$") {
      current = current[3];
    } else {
      current = current?.[/^\d+$/.test(token) ? Number(token) : token];
    }
  }
  return current;
}

function relationValue(relation, root, byId) {
  const resolved = resolveRscReference(relation?.value, root);
  return typeof resolved === "string" ? byId.get(resolved) : resolved;
}

function looksLikeIndividual(name, providerType) {
  if (
    /^(associate professor|assoc\.? prof\.?|doctor|dr\.?|professor|prof\.?)\s/i.test(
      name,
    )
  ) {
    return true;
  }
  if (
    !["GPs & Nurse Practitioners", "Obstetrician/Gynaecologist"].includes(
      providerType,
    ) ||
    organisationWords.test(name)
  ) {
    return false;
  }
  return /^[\p{L}'-]+(?:\s+[\p{L}'-]+){1,3}$/u.test(name);
}

function roleFor(medical, surgical) {
  if (medical && surgical) return "medical-and-surgical-provider";
  return surgical
    ? "surgical-abortion-provider"
    : "medical-abortion-provider";
}

export function extractSearchPlusDocument(html, retrievedAt) {
  const root = decodeFlightData(html);
  const prefetched = findPrefetchedData(root);
  const servicesById = new Map(
    prefetched.services.map((service) => [service.id, service]),
  );
  const abortionServices = prefetched.services.filter(
    (service) => service.group === "abortion",
  );
  const abortionIds = new Set(abortionServices.map((service) => service.id));

  const records = [];
  let abortionTaggedCount = 0;
  const excluded = {
    unpublished_or_unnamed: 0,
    outside_nsw: 0,
    pharmacy: 0,
    individual_clinician: 0,
    virtual_only: 0,
  };
  for (const provider of prefetched.providers) {
    const services = (provider.services ?? [])
      .map((relation) => relationValue(relation, root, servicesById))
      .filter((service) => service && typeof service === "object");
    const abortion = services.filter((service) =>
      abortionIds.has(service.id),
    );
    if (!abortion.length) continue;
    abortionTaggedCount += 1;

    const serviceTitles = new Set(abortion.map((service) => service.title));
    const medical = serviceTitles.has("Medical abortion");
    const surgical = serviceTitles.has("Surgical abortion");
    const telehealth = serviceTitles.has("Medical abortion via telehealth");
    const providerType =
      relationValue(
        provider.providerType,
        root,
        new Map(
          prefetched.providerTypes.map((type) => [type.id, type]),
        ),
      )?.title ?? "";
    const name = cleanText(provider.title);
    const location = provider.providerLocation ?? {};

    if (!name || provider._status !== "published") {
      excluded.unpublished_or_unnamed += 1;
      continue;
    }
    if (location.state !== "NSW") {
      excluded.outside_nsw += 1;
      continue;
    }
    if (providerType === "Pharmacist" || /pharmac(?:ist|y)/i.test(name)) {
      excluded.pharmacy += 1;
      continue;
    }
    if (looksLikeIndividual(name, providerType)) {
      excluded.individual_clinician += 1;
      continue;
    }
    if (!(medical || surgical)) {
      excluded.virtual_only += 1;
      continue;
    }

    const serviceLabels = [
      medical && "medical abortion",
      surgical && "surgical abortion",
      telehealth && "medical abortion via telehealth",
    ].filter(Boolean);
    records.push({
      source_record_id: String(provider.id),
      name,
      provider_role: roleFor(medical, surgical),
      ...(cleanText(location.address) && {
        address: cleanText(location.address),
      }),
      ...(cleanText(location.suburb) && {
        suburb: cleanText(location.suburb),
      }),
      state: "NSW",
      ...(location.postcode != null && {
        postcode: String(location.postcode),
      }),
      latitude: nullableNumber(location.latitude),
      longitude: nullableNumber(location.longitude),
      services: {
        medical_abortion: medical,
        surgical_abortion: surgical,
        telehealth,
        surgical_referral: false,
      },
      gestation_min_weeks: null,
      gestation_max_weeks: nullableNumber(provider.gestationLimit),
      facility_level: true,
      source_url: sourceUrl,
      source_updated_at: cleanText(provider.updatedAt) ?? null,
      evidence: `SEARCH+ service tags: ${serviceLabels.join(", ")}.`,
      verification_status: "source-asserted",
    });
  }

  records.sort((left, right) => left.name.localeCompare(right.name));
  const addressCounts = new Map();
  for (const record of records) {
    const addressKey = [record.address, record.suburb, record.postcode]
      .filter(Boolean)
      .join("|")
      .toLowerCase();
    if (addressKey) {
      addressCounts.set(addressKey, (addressCounts.get(addressKey) ?? 0) + 1);
    }
  }
  let sharedAddressRecordCount = 0;
  for (const record of records) {
    const addressKey = [record.address, record.suburb, record.postcode]
      .filter(Boolean)
      .join("|")
      .toLowerCase();
    if (addressKey && addressCounts.get(addressKey) > 1) {
      record.verification_status = "requires-review";
      sharedAddressRecordCount += 1;
    }
  }
  const duplicateIds = records
    .map((record) => record.source_record_id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    throw new Error(
      `Duplicate source IDs: ${[...new Set(duplicateIds)].join(", ")}`,
    );
  }

  return {
    schema_version: 1,
    source: {
      jurisdiction: "NSW",
      name: "SEARCH+",
      url: sourceUrl,
      retrieved_at: retrievedAt,
      extraction_method: "user-supplied-index-html-written-permission",
      permission_status: "permission-confirmed",
      permission_basis:
        "Written permission and instruction to extract the embedded index HTML " +
        "were confirmed by the maintainer on 2026-09-16; correspondence is " +
        "retained outside the public repository.",
      source_provider_count: prefetched.providers.length,
      abortion_tagged_count: abortionTaggedCount,
      retained_facility_count: records.length,
      shared_address_record_count: sharedAddressRecordCount,
      excluded_counts: excluded,
    },
    records,
    ambiguities: [
      "The snapshot was supplied locally by the maintainer; no live API or access-control workaround was used.",
      "Service tags, gestational limits and coordinates are source assertions and require premises review before publication.",
      "Duplicate-looking provider names may represent distinct source records or locations; source IDs are retained for review.",
      ...(sharedAddressRecordCount
        ? [
            `${sharedAddressRecordCount} records share an address with another retained record and require deduplication review.`,
          ]
        : []),
    ],
  };
}

async function main() {
  const [inputPath, ...options] = process.argv.slice(2);
  if (!inputPath || !options.includes("--permission-confirmed")) {
    throw new Error(
      "Usage: node scripts/extract-searchplus-html.mjs <index.html> " +
        "--permission-confirmed",
    );
  }
  const html = await readFile(path.resolve(inputPath), "utf8");
  const document = extractSearchPlusDocument(html, new Date().toISOString());
  const outputDirectory = path.resolve("data/source-staging/nsw");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "providers.json");
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `SEARCH+: retained ${document.records.length} physical abortion-provider ` +
      `facilities from ${document.source.abortion_tagged_count} abortion-tagged ` +
      `listings; wrote ${path.relative(process.cwd(), outputPath)}`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
