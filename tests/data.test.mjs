import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFacility,
  normalizeWebsite,
  pointInPolygon,
  pointToRingDistanceMeters,
  stateGeometryNote,
} from "../scripts/lib/data.mjs";

test("classifies specialist clinics before general practices", () => {
  assert.equal(classifyFacility("MSI Brisbane Abortion & Contraception Clinic"), "clinic");
  assert.equal(classifyFacility("Family Planning Australia"), "clinic");
  assert.equal(classifyFacility("Royal Women's Hospital"), "hospital");
  assert.equal(classifyFacility("Bondi Doctors"), "doctor");
});

test("normalizes websites without corrupting absolute URLs", () => {
  assert.equal(normalizeWebsite("www.fpnsw.org.au"), "https://www.fpnsw.org.au");
  assert.equal(normalizeWebsite("https://example.org"), "https://example.org");
  assert.equal(normalizeWebsite(""), "");
});

test("detects points inside polygons", () => {
  const polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  };
  assert.equal(pointInPolygon([1, 1], polygon), true);
  assert.equal(pointInPolygon([3, 3], polygon), false);
});

test("flags ACT geometry as indicative", () => {
  assert.match(stateGeometryNote("ACT"), /indicative only/i);
});

test("measures distance from a point to a polygon edge", () => {
  const ring = [
    [0, 0],
    [0.001, 0],
    [0.001, 0.001],
    [0, 0.001],
    [0, 0],
  ];
  assert.equal(Math.round(pointToRingDistanceMeters([0.0005, 0.0005], ring)), 55);
  assert.equal(Math.round(pointToRingDistanceMeters([0.002, 0.0005], ring)), 111);
});
