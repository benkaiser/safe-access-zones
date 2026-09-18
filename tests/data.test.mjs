import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFacility,
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
  assert.match(stateGeometryNote("ACT"), /Health Act 1993.*s 86/i);
  assert.match(stateGeometryNote("ACT"), /not the legal declaration/i);
});

test("describes each jurisdiction's statutory measurement basis", () => {
  assert.match(stateGeometryNote("NSW"), /pedestrian access point/i);
  assert.match(stateGeometryNote("QLD"), /150 m from an entrance/i);
  assert.match(stateGeometryNote("SA"), /public areas within 150 m/i);
  assert.match(stateGeometryNote("VIC"), /150 m radius of premises/i);
  assert.match(stateGeometryNote("TAS"), /150 m radius of premises/i);
  assert.match(stateGeometryNote("WA"), /150 m outside its boundary/i);
  assert.match(stateGeometryNote("NT"), /150 m outside its boundary/i);
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
