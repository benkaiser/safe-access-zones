import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "./styles.css";
import unmatchedCandidatesJson from "../data/osm/unmatched-building-candidates.json";
import { rasterMapStyle } from "./map-style";
import type {
  FacilityCategory,
  FacilityCollection,
  FacilityFeature,
  GeoJsonFeature,
} from "./types";

interface BuildingCandidate {
  osm_url: string;
  name: string;
  address: string;
  distance_m: number;
  geometry: GeoJSON.Polygon;
}

interface UnmatchedTriage {
  service_id: string;
  service_name: string;
  triage_reason: string;
  candidates: BuildingCandidate[];
}

interface EditLocationRequest {
  version: 1;
  action: "edit";
  submitted_at: string;
  service_id: string;
  service_name: string;
  category: FacilityCategory;
  removed: boolean;
  note: string;
  boundary?: GeoJSON.Polygon | null;
}

interface AddLocationRequest {
  version: 1;
  action: "add";
  submitted_at: string;
  name: string;
  category: FacilityCategory;
  state: string;
  suburb: string;
  latitude: number;
  longitude: number;
  note: string;
}

type LocationChangeRequest = EditLocationRequest | AddLocationRequest;

const GITHUB_REPOSITORY = "benkaiser/safe-access-zones";
const CATEGORY_LABELS: Record<FacilityCategory, string> = {
  clinic: "Abortion clinic",
  doctor: "Doctor / general practice",
  hospital: "Hospital",
};
const unmatchedCandidates = unmatchedCandidatesJson as UnmatchedTriage[];
let locations: FacilityCollection = { type: "FeatureCollection", features: [] };
let buildings: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};
let selectedId = "";
let draftCoordinates: [number, number][] = [];
let isDrawing = false;
let clearBoundaryRequested = false;

const map = new maplibregl.Map({
  container: "admin-map",
  style: rasterMapStyle,
  center: [134.2, -26.5],
  zoom: 3.3,
  maxZoom: 19,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

const facilitySelect = requiredElement<HTMLSelectElement>("facility-select");
const categorySelect = requiredElement<HTMLSelectElement>("category-select");
const removedCheckbox = requiredElement<HTMLInputElement>("removed-checkbox");
const noteInput = requiredElement<HTMLTextAreaElement>("decision-note");
const status = requiredElement<HTMLParagraphElement>("admin-status");
const triageSummary = requiredElement<HTMLDivElement>("triage-summary");
const editPanel = requiredElement<HTMLElement>("edit-location-panel");
const addPanel = requiredElement<HTMLElement>("add-location-panel");
const chooseEditButton = requiredElement<HTMLButtonElement>("choose-edit");
const chooseAddButton = requiredElement<HTMLButtonElement>("choose-add");

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing editor element: ${id}`);
  }
  return element as T;
}

function selectedFeature(): FacilityFeature | undefined {
  return locations.features.find((feature) => feature.properties.id === selectedId);
}

function draftFeatureCollection(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (draftCoordinates.length > 0) {
    const firstCoordinate = draftCoordinates[0];
    const lineCoordinates =
      draftCoordinates.length > 2 && firstCoordinate
        ? [...draftCoordinates, firstCoordinate]
        : draftCoordinates;
    features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: lineCoordinates,
      },
    });
    if (draftCoordinates.length >= 3 && firstCoordinate) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[...draftCoordinates, firstCoordinate]],
        },
      });
    }
    features.push(
      ...draftCoordinates.map(
        (coordinate): GeoJsonFeature<Record<string, never>, GeoJSON.Point> => ({
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: coordinate },
        }),
      ),
    );
  }
  return { type: "FeatureCollection", features };
}

function renderDraft(): void {
  const source = map.getSource("draft") as GeoJSONSource | undefined;
  source?.setData(draftFeatureCollection());
}

function renderSelection(): void {
  const feature = selectedFeature();
  if (!feature) {
    return;
  }
  categorySelect.value = feature.properties.category;
  removedCheckbox.checked = false;
  noteInput.value = "";
  draftCoordinates = [];
  clearBoundaryRequested = false;
  renderDraft();
  renderTriage();
  for (const layer of ["candidate-buildings-fill", "candidate-buildings-line"]) {
    if (map.getLayer(layer)) {
      map.setFilter(layer, ["==", ["get", "service_id"], selectedId]);
    }
  }
  map.flyTo({
    center: feature.geometry.coordinates as [number, number],
    zoom: 17,
  });
}

function renderTriage(): void {
  triageSummary.replaceChildren();
  const triage = unmatchedCandidates.find(
    (candidate) => candidate.service_id === selectedId,
  );
  const useNearestButton = requiredElement<HTMLButtonElement>(
    "use-nearest-boundary",
  );
  useNearestButton.disabled = !triage?.candidates[0];
  if (!triage) {
    return;
  }

  const reason = document.createElement("strong");
  reason.textContent = triage.triage_reason.replaceAll("-", " ");
  const detail = document.createElement("span");
  const nearest = triage.candidates[0];
  detail.textContent = nearest
    ? ` — nearest mapped building is ${nearest.distance_m} m from the supplied point`
    : " — no mapped building was found within 80 m";
  triageSummary.append(reason, detail);

  if (nearest) {
    const link = document.createElement("a");
    link.href = nearest.osm_url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = [
      nearest.name || "Unnamed building",
      nearest.address,
    ]
      .filter(Boolean)
      .join(", ");
    const paragraph = document.createElement("p");
    paragraph.append("Nearest candidate: ", link);
    triageSummary.append(paragraph);
  }
}

function refreshFacilitySelect(): void {
  facilitySelect.replaceChildren();
  const sorted = [...locations.features].sort((left, right) =>
    left.properties.name.localeCompare(right.properties.name),
  );
  for (const feature of sorted) {
    const option = document.createElement("option");
    option.value = feature.properties.id;
    option.textContent = `${feature.properties.name} — ${feature.properties.state}`;
    facilitySelect.append(option);
  }
  selectedId = selectedId || sorted[0]?.properties.id || "";
  facilitySelect.value = selectedId;
}

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.style.color = isError ? "#a31b45" : "";
}

function selectChangeType(type: "edit" | "add"): void {
  const isEdit = type === "edit";
  editPanel.hidden = !isEdit;
  addPanel.hidden = isEdit;
  chooseEditButton.classList.toggle("decision-active", isEdit);
  chooseAddButton.classList.toggle("decision-active", !isEdit);
  chooseEditButton.setAttribute("aria-pressed", String(isEdit));
  chooseAddButton.setAttribute("aria-pressed", String(!isEdit));
  setStatus("");
  if (isEdit) {
    renderSelection();
  }
}

function encodeChangeRequest(request: LocationChangeRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

function openGitHubIssue(
  request: LocationChangeRequest,
  title: string,
  summary: string,
): void {
  const body = [
    "## Proposed location change",
    "",
    summary,
    "",
    "## Evidence / reason",
    "",
    request.note,
    "",
    "After this issue is submitted, an automated workflow will validate the request and open a pull request for review.",
    "",
    `<!-- safe-access-zones-change:v1:${encodeChangeRequest(request)} -->`,
  ].join("\n");
  const issueUrl = new URL(
    `https://github.com/${GITHUB_REPOSITORY}/issues/new`,
  );
  issueUrl.searchParams.set("title", title);
  issueUrl.searchParams.set("body", body);
  if (issueUrl.toString().length > 7500) {
    setStatus(
      "This boundary has too many points for a pre-filled GitHub issue. Draw a simpler outline.",
      true,
    );
    return;
  }
  window.location.assign(issueUrl);
}

chooseEditButton.addEventListener("click", () => selectChangeType("edit"));
chooseAddButton.addEventListener("click", () => selectChangeType("add"));

facilitySelect.addEventListener("change", () => {
  selectedId = facilitySelect.value;
  renderSelection();
});

requiredElement<HTMLButtonElement>("draw-boundary").addEventListener("click", () => {
  isDrawing = true;
  clearBoundaryRequested = false;
  draftCoordinates = [];
  renderDraft();
  map.doubleClickZoom.disable();
  setStatus("Drawing started. Click corners and double-click the final point.");
});

requiredElement<HTMLButtonElement>("use-nearest-boundary").addEventListener(
  "click",
  () => {
    const nearest = unmatchedCandidates.find(
      (candidate) => candidate.service_id === selectedId,
    )?.candidates[0];
    const outerRing = nearest?.geometry.coordinates[0];
    if (!nearest || !outerRing) {
      setStatus("No nearby OSM candidate is available.", true);
      return;
    }
    isDrawing = false;
    map.doubleClickZoom.enable();
    clearBoundaryRequested = false;
    draftCoordinates = outerRing.slice(0, -1) as [number, number][];
    renderDraft();
    setStatus(
      `Loaded the nearest OSM candidate (${nearest.distance_m} m away). Review it, add evidence and save.`,
    );
  },
);

requiredElement<HTMLButtonElement>("clear-boundary").addEventListener("click", () => {
  isDrawing = false;
  map.doubleClickZoom.enable();
  clearBoundaryRequested = true;
  draftCoordinates = [];
  renderDraft();
  setStatus("The proposal will restore the source or OSM boundary.");
});

map.on("click", (event) => {
  if (!isDrawing) {
    return;
  }
  draftCoordinates.push([event.lngLat.lng, event.lngLat.lat]);
  renderDraft();
});

map.on("dblclick", (event) => {
  if (!isDrawing) {
    return;
  }
  event.preventDefault();
  isDrawing = false;
  map.doubleClickZoom.enable();
  if (draftCoordinates.length < 3) {
    draftCoordinates = [];
    renderDraft();
    setStatus("A boundary needs at least three points.", true);
    return;
  }
  setStatus("Boundary ready. Add a decision note and save.");
});

requiredElement<HTMLButtonElement>("save-change").addEventListener("click", () => {
  const feature = selectedFeature();
  const note = noteInput.value.trim();
  if (!feature || !note) {
    setStatus("A decision note is required.", true);
    return;
  }
  if (isDrawing && draftCoordinates.length < 3) {
    setStatus("A boundary needs at least three points.", true);
    return;
  }
  if (isDrawing) {
    isDrawing = false;
    map.doubleClickZoom.enable();
  }
  const firstCoordinate = draftCoordinates[0];
  const boundary =
    draftCoordinates.length >= 3 && firstCoordinate
      ? {
          type: "Polygon" as const,
          coordinates: [[...draftCoordinates, firstCoordinate]],
        }
      : undefined;
  const request: EditLocationRequest = {
    version: 1,
    action: "edit",
    submitted_at: new Date().toISOString(),
    service_id: feature.properties.id,
    service_name: feature.properties.name,
    category: categorySelect.value as FacilityCategory,
    removed: removedCheckbox.checked,
    note,
    ...(clearBoundaryRequested
      ? { boundary: null }
      : boundary
        ? { boundary }
        : {}),
  };
  const boundarySummary = clearBoundaryRequested
    ? "Restore the source or OSM footprint"
    : boundary
      ? "Replace with a proposed premises boundary"
      : "Keep the current footprint";
  openGitHubIssue(
    request,
    `[Location change] Edit ${feature.properties.name}`,
    [
      `**Location:** ${feature.properties.name} (${feature.properties.suburb}, ${feature.properties.state})`,
      `**Category:** ${CATEGORY_LABELS[request.category]}`,
      `**Remove from map:** ${request.removed ? "Yes" : "No"}`,
      `**Boundary:** ${boundarySummary}`,
    ].join("\n\n"),
  );
});

requiredElement<HTMLButtonElement>("add-location").addEventListener("click", () => {
  const name = requiredElement<HTMLInputElement>("add-name").value.trim();
  const state = requiredElement<HTMLInputElement>("add-state").value.trim().toUpperCase();
  const suburb = requiredElement<HTMLInputElement>("add-suburb").value.trim();
  const latitude = Number(requiredElement<HTMLInputElement>("add-latitude").value);
  const longitude = Number(requiredElement<HTMLInputElement>("add-longitude").value);
  const note = requiredElement<HTMLTextAreaElement>("add-note").value.trim();
  if (
    !name ||
    !state ||
    !note ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    setStatus(
      "Name, state, valid coordinates and an addition note are required.",
      true,
    );
    return;
  }
  const request: AddLocationRequest = {
    version: 1,
    action: "add",
    submitted_at: new Date().toISOString(),
    name,
    category: requiredElement<HTMLSelectElement>("add-category")
      .value as FacilityCategory,
    state,
    suburb,
    latitude,
    longitude,
    note,
  };
  openGitHubIssue(
    request,
    `[Location change] Add ${name}`,
    [
      `**Location:** ${name} (${suburb || "suburb not supplied"}, ${state})`,
      `**Category:** ${CATEGORY_LABELS[request.category]}`,
      `**Coordinates:** ${latitude}, ${longitude}`,
    ].join("\n\n"),
  );
});

async function loadEditor(): Promise<void> {
  const [locationsResponse, buildingsResponse] = await Promise.all([
    fetch("./data/locations.geojson"),
    fetch("./data/buildings.geojson"),
  ]);
  if (!locationsResponse.ok || !buildingsResponse.ok) {
    throw new Error("Run npm run build:data before opening the editor.");
  }
  locations = (await locationsResponse.json()) as FacilityCollection;
  buildings = (await buildingsResponse.json()) as GeoJSON.FeatureCollection;

  map.addSource("editor-buildings", { type: "geojson", data: buildings });
  map.addLayer({
    id: "editor-buildings-fill",
    type: "fill",
    source: "editor-buildings",
    paint: { "fill-color": "#176f83", "fill-opacity": 0.2 },
  });
  const candidateFeatures = unmatchedCandidates.flatMap((triage) =>
    triage.candidates.map(
      (candidate): GeoJSON.Feature<GeoJSON.Polygon> => ({
        type: "Feature",
        properties: {
          service_id: triage.service_id,
          distance_m: candidate.distance_m,
          osm_url: candidate.osm_url,
        },
        geometry: candidate.geometry,
      }),
    ),
  );
  map.addSource("candidate-buildings", {
    type: "geojson",
    data: { type: "FeatureCollection", features: candidateFeatures },
  });
  map.addLayer({
    id: "candidate-buildings-fill",
    type: "fill",
    source: "candidate-buildings",
    filter: ["==", ["get", "service_id"], ""],
    paint: { "fill-color": "#f1b82d", "fill-opacity": 0.28 },
  });
  map.addLayer({
    id: "candidate-buildings-line",
    type: "line",
    source: "candidate-buildings",
    filter: ["==", ["get", "service_id"], ""],
    paint: {
      "line-color": "#a56b00",
      "line-width": 2,
      "line-dasharray": [2, 1],
    },
  });
  map.addLayer({
    id: "editor-buildings-line",
    type: "line",
    source: "editor-buildings",
    paint: { "line-color": "#176f83", "line-width": 2 },
  });
  map.addSource("editor-locations", { type: "geojson", data: locations });
  map.addLayer({
    id: "editor-locations",
    type: "circle",
    source: "editor-locations",
    paint: {
      "circle-color": "#b42352",
      "circle-radius": 7,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
  map.addSource("draft", { type: "geojson", data: draftFeatureCollection() });
  map.addLayer({
    id: "draft-fill",
    type: "fill",
    source: "draft",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#f1b82d", "fill-opacity": 0.25 },
  });
  map.addLayer({
    id: "draft-line",
    type: "line",
    source: "draft",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#a56b00", "line-width": 3 },
  });
  map.addLayer({
    id: "draft-points",
    type: "circle",
    source: "draft",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": "#f1b82d",
      "circle-radius": 5,
      "circle-stroke-color": "#5d4300",
      "circle-stroke-width": 1,
    },
  });

  map.on("click", "editor-locations", (event) => {
    if (isDrawing) {
      return;
    }
    const id = event.features?.[0]?.properties?.id as string | undefined;
    if (id) {
      selectedId = id;
      facilitySelect.value = id;
      selectChangeType("edit");
    }
  });

  refreshFacilitySelect();
  setStatus("Choose whether to edit an existing location or add a new one.");
}

map.once("load", () => {
  loadEditor().catch((error: unknown) => {
    setStatus(
      error instanceof Error ? error.message : "Unable to load editor data.",
      true,
    );
  });
});
