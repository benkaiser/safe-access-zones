import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readServiceSources } from "./lib/services.mjs";

const CATEGORIES = new Set(["clinic", "doctor", "hospital"]);
const MARKER_PATTERN =
  /<!-- safe-access-zones-change:v1:([A-Za-z0-9+/=]+) -->/;

function requireString(value, field, maxLength = 2_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function validatePolygon(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.type !== "Polygon" ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length !== 1
  ) {
    throw new Error("boundary must be a single-ring GeoJSON Polygon or null");
  }
  const ring = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 201) {
    throw new Error("boundary must contain between 3 and 200 vertices");
  }
  for (const coordinate of ring) {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length !== 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1]) ||
      coordinate[0] < -180 ||
      coordinate[0] > 180 ||
      coordinate[1] < -90 ||
      coordinate[1] > 90
    ) {
      throw new Error("boundary contains an invalid coordinate");
    }
  }
  const first = ring[0];
  const last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error("boundary ring must be closed");
  }
  return value;
}

export function decodeChangeRequest(issueBody) {
  const marker = requireString(issueBody, "issue body", 50_000).match(
    MARKER_PATTERN,
  );
  if (!marker?.[1]) {
    throw new Error("Issue does not contain a safe-access-zones change request");
  }
  let request;
  try {
    request = JSON.parse(Buffer.from(marker[1], "base64").toString("utf8"));
  } catch (error) {
    throw new Error("Change request payload is not valid JSON", { cause: error });
  }
  if (!request || typeof request !== "object" || request.version !== 1) {
    throw new Error("Unsupported change request version");
  }
  if (request.action !== "edit" && request.action !== "add") {
    throw new Error("action must be edit or add");
  }
  requireString(request.submitted_at, "submitted_at", 40);
  if (!Number.isFinite(Date.parse(request.submitted_at))) {
    throw new Error("submitted_at must be an ISO date");
  }
  requireString(request.note, "note");
  if (!CATEGORIES.has(request.category)) {
    throw new Error("category is invalid");
  }

  if (request.action === "edit") {
    requireString(request.service_id, "service_id", 200);
    requireString(request.service_name, "service_name", 200);
    if (typeof request.removed !== "boolean") {
      throw new Error("removed must be a boolean");
    }
    if ("boundary" in request && request.boundary !== null) {
      validatePolygon(request.boundary);
    }
  } else {
    requireString(request.name, "name", 200);
    requireString(request.state, "state", 3);
    if (!/^[A-Z]{2,3}$/.test(request.state)) {
      throw new Error("state must be a two or three letter uppercase abbreviation");
    }
    if (typeof request.suburb !== "string" || request.suburb.length > 200) {
      throw new Error("suburb must be at most 200 characters");
    }
    if (
      !Number.isFinite(request.latitude) ||
      request.latitude < -90 ||
      request.latitude > 90 ||
      !Number.isFinite(request.longitude) ||
      request.longitude < -180 ||
      request.longitude > 180
    ) {
      throw new Error("latitude or longitude is invalid");
    }
  }
  return request;
}

export function applyChangeRequest({
  overrides,
  services,
  request,
  issueNumber,
  issueUrl,
  issueCreatedAt,
}) {
  if (
    !overrides ||
    overrides.version !== 1 ||
    !overrides.locations ||
    !Array.isArray(overrides.additions)
  ) {
    throw new Error("Repository overrides document is invalid");
  }
  const parsedIssueNumber = Number(issueNumber);
  if (!Number.isInteger(parsedIssueNumber) || parsedIssueNumber < 1) {
    throw new Error("Issue number is invalid");
  }
  requireString(issueUrl, "issue URL", 500);
  if (!Number.isFinite(Date.parse(issueCreatedAt))) {
    throw new Error("Issue creation date is invalid");
  }

  const updated = structuredClone(overrides);
  if (request.action === "edit") {
    const serviceExists =
      services.some((service) => service.id === request.service_id) ||
      updated.additions.some((addition) => addition.id === request.service_id);
    if (!serviceExists) {
      throw new Error(`Unknown service ID: ${request.service_id}`);
    }
    const existing = updated.locations[request.service_id] ?? {};
    const decision = {
      ...existing,
      category: request.category,
      removed: request.removed,
      note: request.note,
      reviewed_at: issueCreatedAt,
      source_issue_url: issueUrl,
    };
    if ("boundary" in request) {
      decision.boundary = request.boundary;
      delete decision.selected_osm_url;
      if (request.boundary) {
        decision.triage_status = "manual-boundary";
      } else {
        delete decision.triage_status;
      }
    }
    updated.locations[request.service_id] = decision;
  } else {
    const id = `manual-issue-${parsedIssueNumber}`;
    if (updated.additions.some((addition) => addition.id === id)) {
      throw new Error(`Issue #${parsedIssueNumber} has already been applied`);
    }
    updated.additions.push({
      id,
      name: request.name,
      category: request.category,
      state: request.state,
      suburb: request.suburb,
      latitude: request.latitude,
      longitude: request.longitude,
      note: request.note,
      added_at: issueCreatedAt,
      source_issue_url: issueUrl,
    });
  }
  return updated;
}

async function main() {
  const issueBody = process.env.CHANGE_REQUEST_BODY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const issueUrl = process.env.ISSUE_URL;
  const issueCreatedAt = process.env.ISSUE_CREATED_AT;
  if (!issueBody || !issueNumber || !issueUrl || !issueCreatedAt) {
    throw new Error("Missing GitHub issue environment variables");
  }

  const root = new URL("../", import.meta.url);
  const [overrides, serviceSources] = await Promise.all([
    readFile(new URL("data/curation-overrides.json", root), "utf8").then(JSON.parse),
    readServiceSources(root),
  ]);
  const request = decodeChangeRequest(issueBody);
  const updated = applyChangeRequest({
    overrides,
    services: [...serviceSources.healthdirect, ...serviceSources.supplemental],
    request,
    issueNumber,
    issueUrl,
    issueCreatedAt,
  });
  await writeFile(
    new URL("data/curation-overrides.json", root),
    `${JSON.stringify(updated, null, 2)}\n`,
    "utf8",
  );
  console.log(`Applied ${request.action} request from issue #${issueNumber}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
