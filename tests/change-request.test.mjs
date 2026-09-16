import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChangeRequest,
  decodeChangeRequest,
} from "../scripts/apply-change-request.mjs";

function issueBody(request) {
  const payload = Buffer.from(JSON.stringify(request)).toString("base64");
  return `Proposed change\n\n<!-- safe-access-zones-change:v1:${payload} -->`;
}

const editRequest = {
  version: 1,
  action: "edit",
  submitted_at: "2026-09-16T04:40:00Z",
  service_id: "service-1",
  service_name: "Example Clinic",
  category: "clinic",
  removed: false,
  note: "Provider website confirms this location.",
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [151.0, -33.0],
        [151.001, -33.0],
        [151.001, -33.001],
        [151.0, -33.0],
      ],
    ],
  },
};

test("decodes and validates an editor issue payload", () => {
  assert.deepEqual(decodeChangeRequest(issueBody(editRequest)), editRequest);
});

test("applies an edit request to a known service", () => {
  const updated = applyChangeRequest({
    overrides: { version: 1, locations: {}, additions: [] },
    services: [{ id: "service-1" }],
    request: editRequest,
    issueNumber: 42,
    issueUrl: "https://github.com/benkaiser/safe-access-zones/issues/42",
    issueCreatedAt: "2026-09-16T04:41:00Z",
  });
  assert.equal(updated.locations["service-1"].category, "clinic");
  assert.equal(updated.locations["service-1"].triage_status, "manual-boundary");
  assert.equal(
    updated.locations["service-1"].source_issue_url,
    "https://github.com/benkaiser/safe-access-zones/issues/42",
  );
});

test("creates a deterministic manual addition from an issue", () => {
  const request = decodeChangeRequest(
    issueBody({
      version: 1,
      action: "add",
      submitted_at: "2026-09-16T04:40:00Z",
      name: "Example Health",
      category: "doctor",
      state: "NSW",
      suburb: "Sydney",
      latitude: -33.86,
      longitude: 151.2,
      note: "Provider website lists pregnancy termination.",
    }),
  );
  const updated = applyChangeRequest({
    overrides: { version: 1, locations: {}, additions: [] },
    services: [],
    request,
    issueNumber: 43,
    issueUrl: "https://github.com/benkaiser/safe-access-zones/issues/43",
    issueCreatedAt: "2026-09-16T04:42:00Z",
  });
  assert.equal(updated.additions[0].id, "manual-issue-43");
  assert.equal(updated.additions[0].name, "Example Health");
});

test("rejects malformed boundaries and unknown services", () => {
  const malformed = structuredClone(editRequest);
  malformed.boundary.coordinates[0][3] = [151.002, -33.002];
  assert.throws(
    () => decodeChangeRequest(issueBody(malformed)),
    /boundary ring must be closed/,
  );
  assert.throws(
    () =>
      applyChangeRequest({
        overrides: { version: 1, locations: {}, additions: [] },
        services: [],
        request: editRequest,
        issueNumber: 44,
        issueUrl: "https://github.com/benkaiser/safe-access-zones/issues/44",
        issueCreatedAt: "2026-09-16T04:43:00Z",
      }),
    /Unknown service ID/,
  );
});
