import test from "node:test";
import assert from "node:assert/strict";

import { extractSearchPlusDocument } from "../scripts/extract-searchplus-html.mjs";

function htmlWithPayload(prefetchedData) {
  const root = ["$", "html", null, { prefetchedData }];
  const flight = `4:${JSON.stringify(root)}\n`;
  return `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
}

const medical = {
  id: "medical",
  title: "Medical abortion",
  group: "abortion",
};
const surgical = {
  id: "surgical",
  title: "Surgical abortion",
  group: "abortion",
};

function provider(id, title, type, service, location = {}) {
  return {
    id,
    title,
    _status: "published",
    providerType: { value: type },
    services: [{ value: service }],
    providerLocation: {
      address: "1 Example Street",
      suburb: "Sydney",
      state: "NSW",
      postcode: 2000,
      latitude: -33.86,
      longitude: 151.2,
      ...location,
    },
    providerContacts: { phone_1: "not retained", email: "not retained" },
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

test("extracts physical SEARCH+ facilities and omits contact fields", () => {
  const clinicType = { id: "clinic", title: "Health service" };
  const output = extractSearchPlusDocument(
    htmlWithPayload({
      services: [medical, surgical],
      providerTypes: [clinicType],
      providers: [
        provider("one", "Example Clinic", clinicType, medical),
        provider("two", "Example Day Surgery", clinicType, surgical),
      ],
    }),
    "2026-09-16T00:00:00.000Z",
  );

  assert.equal(output.records.length, 2);
  assert.equal(output.source.permission_status, "permission-confirmed");
  assert.equal(output.records[0].state, "NSW");
  assert.equal("providerContacts" in output.records[0], false);
});

test("excludes pharmacists, individual clinicians, and non-NSW records", () => {
  const pharmacist = { id: "pharmacy", title: "Pharmacist" };
  const practitioner = {
    id: "practitioner",
    title: "GPs & Nurse Practitioners",
  };
  const output = extractSearchPlusDocument(
    htmlWithPayload({
      services: [medical],
      providerTypes: [pharmacist, practitioner],
      providers: [
        provider("one", "Example Pharmacy", pharmacist, medical),
        provider("two", "Jessica Example", practitioner, medical),
        provider("three", "Example Medical Centre", practitioner, medical, {
          state: "VIC",
        }),
      ],
    }),
    "2026-09-16T00:00:00.000Z",
  );

  assert.deepEqual(output.records, []);
});

test("flags records sharing a premises for deduplication review", () => {
  const clinicType = { id: "clinic", title: "Health service" };
  const output = extractSearchPlusDocument(
    htmlWithPayload({
      services: [medical],
      providerTypes: [clinicType],
      providers: [
        provider("one", "Example Clinic", clinicType, medical),
        provider("two", "Example Service", clinicType, medical),
      ],
    }),
    "2026-09-16T00:00:00.000Z",
  );

  assert.equal(output.source.shared_address_record_count, 2);
  assert.ok(
    output.records.every(
      (record) => record.verification_status === "requires-review",
    ),
  );
});
