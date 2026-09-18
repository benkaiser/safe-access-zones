import test from "node:test";
import assert from "node:assert/strict";

import { normaliseGeoJson } from "../scripts/collect-provider-sources.mjs";

const source = {
  jurisdiction: "QLD",
  name: "Example directory",
  url: "https://example.test/providers.json",
  unwrap: (payload) => payload,
};

function feature(id, name, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [153.1, -27.5] },
    properties: { id, name, state: "QLD", ...properties },
  };
}

test("normalises facility-level abortion records without contact fields", () => {
  const output = normaliseGeoJson(
    {
      type: "FeatureCollection",
      features: [
        feature(1, "Example Clinic", {
          abortion_medical: true,
          phone_label: "do not retain",
          notes: "do not retain",
          gestation_max: 9,
        }),
      ],
    },
    source,
    "2026-01-01T00:00:00.000Z",
  );

  assert.equal(output.records.length, 1);
  assert.equal(output.records[0].provider_role, "medical-abortion-provider");
  assert.equal(output.records[0].gestation_max_weeks, 9);
  assert.equal("phone_label" in output.records[0], false);
  assert.equal("notes" in output.records[0], false);
});

test("records confirmed permission and stale source warnings", () => {
  const output = normaliseGeoJson(
    {
      type: "FeatureCollection",
      features: [
        feature(1, "Example Clinic", {
          abortion_medical: true,
          last_validated: "2022-03-24T00:00:00.000Z",
        }),
      ],
    },
    source,
    "2026-09-16T00:00:00.000Z",
    "permission-confirmed",
  );

  assert.equal(output.source.permission_status, "permission-confirmed");
  assert.match(output.source.permission_basis, /Written permission/);
  assert.match(output.ambiguities.at(-1), /re-verify every facility/);
});

test("excludes pharmacies, named clinicians, and unrelated records", () => {
  const output = normaliseGeoJson(
    {
      type: "FeatureCollection",
      features: [
        feature(1, "Example Pharmacy", {
          type: "PH",
          abortion_medical: true,
        }),
        feature(2, "Dr Example", { abortion_medical: true }),
        feature(3, "General Clinic", { other_counselling: true }),
        feature(4, "Virtual Service", { abortion_telehealth: true }),
        feature(5, "Referral Service", { abortion_refsurgical: true }),
      ],
    },
    source,
    "2026-01-01T00:00:00.000Z",
  );

  assert.deepEqual(output.records, []);
});

test("rejects duplicate source identifiers", () => {
  assert.throws(
    () =>
      normaliseGeoJson(
        {
          type: "FeatureCollection",
          features: [
            feature(1, "Clinic One", { abortion_medical: true }),
            feature(1, "Clinic Two", { abortion_surgical: true }),
          ],
        },
        source,
        "2026-01-01T00:00:00.000Z",
      ),
    /Duplicate source IDs/,
  );
});
