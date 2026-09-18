import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}

test("tracked location sources contain no provider contact fields", async () => {
  const healthdirect = await readJson("pregnancy_termination_services.json");
  const supplemental = await readJson("data/supplemental-locations.json");
  for (const record of [...healthdirect, ...supplemental]) {
    assert.equal("phone" in record, false);
    assert.equal("email" in record, false);
    assert.equal("website" in record, false);
  }
});

test("supplemental locations are source-neutral and uniquely identified", async () => {
  const supplemental = await readJson("data/supplemental-locations.json");
  const ids = new Set();
  for (const record of supplemental) {
    assert.match(record.id, /^supplemental-(act|nsw|nt|qld|sa|tas|vic|wa)-[a-f0-9]{16}$/);
    assert.equal(ids.has(record.id), false);
    ids.add(record.id);
    assert.ok(Number.isFinite(record.latitude));
    assert.ok(Number.isFinite(record.longitude));
    assert.equal("source" in record, false);
    assert.equal("source_url" in record, false);
    assert.equal("evidence" in record, false);
  }
});

test("supplemental deduplication accounts for every permitted record", async () => {
  const report = await readJson("data/supplemental-dedup-report.json");
  assert.equal(
    report.input_records,
    report.published_records +
      report.suppressed_healthdirect +
      report.suppressed_supplemental_duplicate +
      report.excluded_individual_clinicians +
      report.missing_coordinates,
  );
  assert.equal(report.missing_coordinates, 0);
});
