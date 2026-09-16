import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readGenerated(name) {
  return JSON.parse(
    await readFile(new URL(`../public/data/${name}`, import.meta.url), "utf8"),
  );
}

test("publishes one zone per physical location", async () => {
  const locations = await readGenerated("locations.geojson");
  const zones = await readGenerated("zones.geojson");
  assert.equal(locations.features.length, 31);
  assert.equal(zones.features.length, locations.features.length);
});

test("excludes virtual services and identifies every geometry basis", async () => {
  const locations = await readGenerated("locations.geojson");
  for (const location of locations.features) {
    assert.equal(location.geometry.type, "Point");
    assert.ok(["manual", "openstreetmap", "point"].includes(location.properties.geometry_source));
    assert.ok(location.properties.legal_note);
    assert.equal(
      location.properties.data_source,
      "Healthdirect National Health Services Directory (NHSD)",
    );
    assert.equal(
      location.properties.data_source_url,
      "https://www.healthdirect.gov.au/australian-health-services",
    );
    assert.ok(Number.isFinite(Date.parse(location.properties.source_synced_at)));
  }
});

test("publishes Healthdirect source sync metadata", async () => {
  const metadata = await readGenerated("metadata.json");
  assert.equal(metadata.source.publisher, "Healthdirect Australia");
  assert.equal(metadata.source.dataset, "National Health Services Directory (NHSD)");
  assert.equal(
    metadata.source.source_url,
    "https://www.healthdirect.gov.au/australian-health-services",
  );
  assert.ok(Number.isFinite(Date.parse(metadata.source.synced_at)));
});

test("publishes uncertainty only for unmatched records", async () => {
  const locations = await readGenerated("locations.geojson");
  const uncertainty = await readGenerated("uncertainty-zones.geojson");
  const unmatched = locations.features.filter(
    (location) => location.properties.boundary_status === "unmatched",
  );
  assert.equal(uncertainty.features.length, unmatched.length);
});
