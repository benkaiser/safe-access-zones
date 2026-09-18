import maplibregl, {
  type GeoJSONSource,
  type LngLatBoundsLike,
} from "maplibre-gl";
import "./styles.css";
import unmatchedCandidatesJson from "../data/osm/unmatched-building-candidates.json";
import { rasterMapStyle } from "./map-style";
import type {
  CurationDecision,
  CurationOverrides,
} from "./types";

interface BuildingCandidate {
  osm_url: string;
  name: string;
  address: string;
  building: string;
  distance_m: number;
  geometry: GeoJSON.Polygon;
}

interface TriageItem {
  service_id: string;
  service_name: string;
  state: string;
  suburb: string;
  latitude: number;
  longitude: number;
  triage_reason: string;
  candidates: BuildingCandidate[];
}

type TriageStatus = NonNullable<CurationDecision["triage_status"]>;

interface PendingDecision {
  status: TriageStatus;
  boundary: GeoJSON.Polygon | null;
  selectedOsmUrl?: string;
  label: string;
}

const LEGACY_STORAGE_KEY = "safe-access-zones-triage-v1";
const triageItems = unmatchedCandidatesJson as TriageItem[];
const reasonLabels: Record<string, string> = {
  "likely-geocode-offset-near-building-edge":
    "Likely geocode offset: a footprint is within 10 m of the supplied point.",
  "nearby-buildings-require-manual-selection":
    "Ambiguous location: one or more buildings are nearby, but none contains the supplied point.",
  "no-close-containing-footprint":
    "No close footprint: the nearest mapped building is more than 40 m away.",
};

let overrides: CurationOverrides = { version: 1, locations: {}, additions: [] };
let queue: TriageItem[] = [];
let selectedId = triageItems[0]?.service_id ?? "";
let selectedCandidateIndex = 0;
let pendingDecision: PendingDecision | null = null;
let draftCoordinates: [number, number][] = [];
let drawing = false;

const map = new maplibregl.Map({
  container: "triage-map",
  style: rasterMapStyle,
  center: [134.2, -26.5],
  zoom: 3.3,
  maxZoom: 19,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

const queueElement = requiredElement<HTMLElement>("triage-queue");
const filterElement = requiredElement<HTMLSelectElement>("triage-filter");
const nameElement = requiredElement<HTMLElement>("triage-name");
const placeElement = requiredElement<HTMLElement>("triage-place");
const reasonElement = requiredElement<HTMLElement>("triage-reason");
const positionElement = requiredElement<HTMLElement>("triage-position");
const candidateListElement = requiredElement<HTMLElement>("candidate-list");
const noteElement = requiredElement<HTMLTextAreaElement>("triage-note");
const pendingElement = requiredElement<HTMLElement>("pending-decision");
const statusElement = requiredElement<HTMLElement>("triage-status");
const saveButton = requiredElement<HTMLButtonElement>("save-triage");
const acceptCandidateButton =
  requiredElement<HTMLButtonElement>("accept-candidate");
const drawBoundaryButton =
  requiredElement<HTMLButtonElement>("draw-triage-boundary");
const keepApproximateButton =
  requiredElement<HTMLButtonElement>("keep-approximate");
const deferButton = requiredElement<HTMLButtonElement>("defer-triage");

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing triage element: ${id}`);
  }
  return element as T;
}

function isCurationOverrides(value: unknown): value is CurationOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const document = value as Record<string, unknown>;
  return (
    document.version === 1 &&
    Boolean(document.locations) &&
    typeof document.locations === "object" &&
    !Array.isArray(document.locations) &&
    Array.isArray(document.additions)
  );
}

async function apiError(response: Response): Promise<Error> {
  const body = await response.text();
  try {
    const document = JSON.parse(body) as { error?: unknown };
    if (typeof document.error === "string") {
      return new Error(document.error);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.error("Unable to parse curation API error", error);
    }
  }
  return new Error(body || `Curation API request failed (${response.status}).`);
}

async function loadRepositoryOverrides(): Promise<CurationOverrides> {
  const response = await fetch("/api/curation-overrides", { cache: "no-store" });
  if (!response.ok) {
    throw await apiError(response);
  }
  const document = (await response.json()) as unknown;
  if (!isCurationOverrides(document)) {
    throw new Error("The repository curation overrides file is invalid.");
  }
  return document;
}

async function writeRepositoryOverrides(
  document: CurationOverrides,
): Promise<CurationOverrides> {
  const response = await fetch("/api/curation-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  if (!response.ok) {
    throw await apiError(response);
  }
  const result = (await response.json()) as { document?: unknown };
  if (!isCurationOverrides(result.document)) {
    throw new Error("The curation API returned an invalid overrides document.");
  }
  return result.document;
}

async function migrateLegacyBrowserOverrides(
  repositoryOverrides: CurationOverrides,
): Promise<{ document: CurationOverrides; migrated: boolean }> {
  const stored = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!stored) {
    return { document: repositoryOverrides, migrated: false };
  }

  let legacyDocument: unknown;
  try {
    legacyDocument = JSON.parse(stored) as unknown;
  } catch (error) {
    console.error("Unable to parse legacy browser triage progress", error);
    return { document: repositoryOverrides, migrated: false };
  }
  if (!isCurationOverrides(legacyDocument)) {
    console.error("Legacy browser triage progress has an invalid format.");
    return { document: repositoryOverrides, migrated: false };
  }

  const merged = structuredClone(repositoryOverrides);
  for (const [serviceId, legacyDecision] of Object.entries(
    legacyDocument.locations,
  )) {
    const repositoryDecision = merged.locations[serviceId];
    if (
      !repositoryDecision ||
      legacyDecision.reviewed_at > repositoryDecision.reviewed_at
    ) {
      merged.locations[serviceId] = legacyDecision;
    }
  }
  const additionIds = new Set(merged.additions.map((addition) => addition.id));
  for (const addition of legacyDocument.additions) {
    if (!additionIds.has(addition.id)) {
      merged.additions.push(addition);
    }
  }

  if (JSON.stringify(merged) !== JSON.stringify(repositoryOverrides)) {
    const saved = await writeRepositoryOverrides(merged);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    return { document: saved, migrated: true };
  }
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  return { document: merged, migrated: true };
}

function currentItem(): TriageItem | undefined {
  return triageItems.find((item) => item.service_id === selectedId);
}

function currentDecision(): CurationDecision | undefined {
  return overrides.locations[selectedId];
}

function isReviewed(item: TriageItem): boolean {
  return Boolean(overrides.locations[item.service_id]?.triage_status);
}

function rebuildQueue(): void {
  const filter = filterElement.value;
  queue = triageItems.filter((item) => {
    if (filter === "all") {
      return true;
    }
    if (filter === "unreviewed") {
      return !isReviewed(item);
    }
    if (filter === "reviewed") {
      return isReviewed(item);
    }
    return item.triage_reason === filter;
  });
  queue.sort((left, right) => {
    if (filter === "unreviewed") {
      return (
        (left.candidates[0]?.distance_m ?? Number.POSITIVE_INFINITY) -
        (right.candidates[0]?.distance_m ?? Number.POSITIVE_INFINITY)
      );
    }
    return left.service_name.localeCompare(right.service_name);
  });
  if (!queue.some((item) => item.service_id === selectedId)) {
    selectedId = queue[0]?.service_id ?? "";
  }
  renderQueue();
  renderCurrentItem();
  renderProgress();
}

function renderQueue(): void {
  queueElement.replaceChildren();
  for (const item of queue) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "triage-queue-item";
    button.setAttribute(
      "aria-current",
      item.service_id === selectedId ? "true" : "false",
    );

    const title = document.createElement("strong");
    title.textContent = item.service_name;
    const detail = document.createElement("span");
    detail.textContent = `${item.suburb}, ${item.state} · ${item.candidates.length} candidate${item.candidates.length === 1 ? "" : "s"}`;
    const state = document.createElement("small");
    state.className = `triage-state${isReviewed(item) ? " reviewed" : ""}`;
    state.textContent = currentStatusLabel(item);
    button.append(title, detail, state);
    button.addEventListener("click", () => selectItem(item.service_id));
    queueElement.append(button);
  }
  if (queue.length === 0) {
    const empty = document.createElement("p");
    empty.className = "candidate-empty";
    empty.textContent = "No locations match this queue filter.";
    queueElement.append(empty);
  }
}

function currentStatusLabel(item: TriageItem): string {
  const decision = overrides.locations[item.service_id]?.triage_status;
  const labels: Record<TriageStatus, string> = {
    "accepted-candidate": "accepted",
    "manual-boundary": "drawn",
    "keep-approximate": "approximate",
    deferred: "deferred",
  };
  return decision ? labels[decision] : "open";
}

function renderProgress(): void {
  const reviewed = triageItems.filter(isReviewed).length;
  const total = triageItems.length;
  const percent = total === 0 ? 0 : Math.round((reviewed / total) * 100);
  requiredElement<HTMLElement>("triage-progress-text").textContent =
    `${reviewed} of ${total} reviewed`;
  requiredElement<HTMLElement>("triage-progress-percent").textContent = `${percent}%`;
  requiredElement<HTMLElement>("triage-progress-bar").style.width = `${percent}%`;
}

function selectItem(id: string): void {
  selectedId = id;
  selectedCandidateIndex = 0;
  pendingDecision = null;
  draftCoordinates = [];
  drawing = false;
  map.doubleClickZoom.enable();
  renderQueue();
  renderCurrentItem();
}

function renderCurrentItem(): void {
  const item = currentItem();
  if (!item) {
    nameElement.textContent = "Queue complete";
    placeElement.textContent = "";
    reasonElement.textContent = "Choose another queue filter to inspect reviewed decisions.";
    candidateListElement.replaceChildren();
    updateMapSelection();
    return;
  }

  const queueIndex = queue.findIndex((entry) => entry.service_id === item.service_id);
  positionElement.textContent =
    queueIndex >= 0 ? `Queue item ${queueIndex + 1} of ${queue.length}` : "";
  nameElement.textContent = item.service_name;
  placeElement.textContent = `${item.suburb}, ${item.state} · ${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}`;
  reasonElement.textContent =
    reasonLabels[item.triage_reason] ?? item.triage_reason.replaceAll("-", " ");

  const decision = currentDecision();
  noteElement.value = decision?.note ?? "";
  pendingDecision = decision?.triage_status
    ? {
        status: decision.triage_status,
        boundary: decision.boundary ?? null,
        selectedOsmUrl: decision.selected_osm_url,
        label: `Saved decision: ${currentStatusLabel(item)}`,
      }
    : null;
  const selectedFromDecision = decision?.selected_osm_url
    ? item.candidates.findIndex(
        (candidate) => candidate.osm_url === decision.selected_osm_url,
      )
    : -1;
  if (selectedFromDecision >= 0) {
    selectedCandidateIndex = selectedFromDecision;
  }
  renderCandidates(item);
  draftCoordinates =
    decision?.boundary?.coordinates[0]?.slice(0, -1) as [number, number][] | undefined ??
    [];
  renderPendingDecision();
  updateMapSelection();
}

function renderCandidates(item: TriageItem): void {
  candidateListElement.replaceChildren();
  if (item.candidates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "candidate-empty";
    empty.textContent =
      "No OSM building is mapped within 80 m. Verify the coordinates and draw the premises manually.";
    candidateListElement.append(empty);
    acceptCandidateButton.disabled = true;
    return;
  }
  acceptCandidateButton.disabled = false;

  item.candidates.forEach((candidate, index) => {
    const wrapper = document.createElement("div");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `candidate-card${index === selectedCandidateIndex ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(index === selectedCandidateIndex));

    const badge = document.createElement("strong");
    badge.className = "candidate-card-index";
    badge.textContent = String(index + 1);
    const content = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent =
      candidate.name || candidate.address || `Unnamed ${candidate.building || "building"}`;
    const detail = document.createElement("span");
    detail.textContent = [
      `${candidate.distance_m} m from point`,
      candidate.address && candidate.name ? candidate.address : "",
      candidate.building ? `OSM type: ${candidate.building}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    content.append(title, detail);
    button.append(badge, content);
    button.addEventListener("click", () => {
      selectedCandidateIndex = index;
      renderCandidates(item);
      if (pendingDecision?.status === "accepted-candidate") {
        acceptSelectedCandidate();
      } else {
        updateMapSelection();
      }
    });

    const link = document.createElement("a");
    link.className = "candidate-osm-link";
    link.href = candidate.osm_url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Inspect on OpenStreetMap";
    wrapper.append(button, link);
    candidateListElement.append(wrapper);
  });
}

function updateMapSelection(fitMap = true): void {
  const item = currentItem();
  const pointSource = map.getSource("triage-current-point") as
    | GeoJSONSource
    | undefined;
  const candidateSource = map.getSource("triage-candidates") as
    | GeoJSONSource
    | undefined;
  const draftSource = map.getSource("triage-draft") as GeoJSONSource | undefined;
  if (!pointSource || !candidateSource || !draftSource) {
    return;
  }

  pointSource.setData({
    type: "FeatureCollection",
    features: item
      ? [
          {
            type: "Feature",
            properties: { name: item.service_name },
            geometry: {
              type: "Point",
              coordinates: [item.longitude, item.latitude],
            },
          },
        ]
      : [],
  });
  candidateSource.setData({
    type: "FeatureCollection",
    features:
      item?.candidates.map((candidate, index) => ({
        type: "Feature",
        properties: {
          index,
          selected: index === selectedCandidateIndex,
          name: candidate.name,
          distance_m: candidate.distance_m,
        },
        geometry: candidate.geometry,
      })) ?? [],
  });
  draftSource.setData(draftFeatureCollection());

  if (!item || !fitMap) {
    return;
  }
  const coordinates: [number, number][] = [[item.longitude, item.latitude]];
  for (const candidate of item.candidates) {
    for (const position of candidate.geometry.coordinates[0] ?? []) {
      const longitude = position[0];
      const latitude = position[1];
      if (typeof longitude === "number" && typeof latitude === "number") {
        coordinates.push([longitude, latitude]);
      }
    }
  }
  const bounds = coordinates.reduce(
    (result, coordinate) => result.extend(coordinate),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds as LngLatBoundsLike, {
    padding: 80,
    maxZoom: 18,
    duration: 450,
  });
}

function draftFeatureCollection(): GeoJSON.FeatureCollection {
  if (draftCoordinates.length < 1) {
    return { type: "FeatureCollection", features: [] };
  }
  const first = draftCoordinates[0];
  if (!first) {
    return { type: "FeatureCollection", features: [] };
  }
  const closed = [...draftCoordinates, first];
  const features: GeoJSON.Feature[] = [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: draftCoordinates.length >= 3 ? closed : draftCoordinates,
      },
    },
    ...draftCoordinates.map(
      (coordinate): GeoJSON.Feature<GeoJSON.Point> => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: coordinate },
      }),
    ),
  ];
  if (draftCoordinates.length >= 3) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [closed] },
    });
  }
  return { type: "FeatureCollection", features };
}

function setPendingDecision(decision: PendingDecision): void {
  drawing = false;
  map.doubleClickZoom.enable();
  pendingDecision = decision;
  draftCoordinates =
    decision.boundary?.coordinates[0]?.slice(0, -1) as [number, number][] | undefined ??
    [];
  renderPendingDecision();
  updateMapSelection();
}

function renderPendingDecision(): void {
  pendingElement.textContent = pendingDecision?.label ?? "No decision selected.";
  const activeStatus = drawing ? "manual-boundary" : pendingDecision?.status;
  const buttons: Array<[HTMLButtonElement, TriageStatus]> = [
    [acceptCandidateButton, "accepted-candidate"],
    [drawBoundaryButton, "manual-boundary"],
    [keepApproximateButton, "keep-approximate"],
    [deferButton, "deferred"],
  ];
  for (const [button, status] of buttons) {
    const isActive = activeStatus === status;
    button.classList.toggle("decision-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function setStatus(message: string, isError = false): void {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#a31b45" : "";
}

function finalizeManualBoundary(): boolean {
  const coordinates = draftCoordinates.filter(
    (coordinate, index) =>
      index === 0 ||
      coordinate[0] !== draftCoordinates[index - 1]?.[0] ||
      coordinate[1] !== draftCoordinates[index - 1]?.[1],
  );
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (
    first &&
    last &&
    coordinates.length > 1 &&
    first[0] === last[0] &&
    first[1] === last[1]
  ) {
    coordinates.pop();
  }
  if (new Set(coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`)).size < 3) {
    setStatus("A manual boundary requires at least three distinct points.", true);
    return false;
  }
  const boundaryStart = coordinates[0];
  if (!boundaryStart) {
    return false;
  }

  drawing = false;
  map.doubleClickZoom.enable();
  draftCoordinates = coordinates;
  setPendingDecision({
    status: "manual-boundary",
    boundary: {
      type: "Polygon",
      coordinates: [[...coordinates, boundaryStart]],
    },
    label: "Use the manually drawn premises boundary.",
  });
  setStatus("Manual boundary ready. Add an evidence note and save.");
  return true;
}

function acceptSelectedCandidate(): void {
  const candidate = currentItem()?.candidates[selectedCandidateIndex];
  if (!candidate) {
    setStatus("Select an OSM candidate first.", true);
    return;
  }
  setPendingDecision({
    status: "accepted-candidate",
    boundary: candidate.geometry,
    selectedOsmUrl: candidate.osm_url,
    label: `Use candidate ${selectedCandidateIndex + 1}: ${candidate.name || candidate.address || "unnamed building"}`,
  });
}

acceptCandidateButton.addEventListener("click", acceptSelectedCandidate);

drawBoundaryButton.addEventListener("click", () => {
  drawing = true;
  pendingDecision = null;
  draftCoordinates = [];
  map.doubleClickZoom.disable();
  updateMapSelection();
  renderPendingDecision();
  setStatus(
    "Click each premises corner, then double-click the final point or click Save.",
  );
});

keepApproximateButton.addEventListener("click", () => {
  setPendingDecision({
    status: "keep-approximate",
    boundary: null,
    label: "Keep the point-based 150 m circle and uncertainty area.",
  });
});

deferButton.addEventListener("click", () => {
  setPendingDecision({
    status: "deferred",
    boundary: null,
    label: "Defer this location for further research.",
  });
});

map.on("click", (event) => {
  if (!drawing) {
    return;
  }
  draftCoordinates.push([event.lngLat.lng, event.lngLat.lat]);
  updateMapSelection(false);
});

map.on("dblclick", (event) => {
  if (!drawing) {
    return;
  }
  event.preventDefault();
  finalizeManualBoundary();
});

saveButton.addEventListener("click", async () => {
  const item = currentItem();
  const note = noteElement.value.trim();
  if (drawing && !finalizeManualBoundary()) {
    return;
  }
  if (!item || !pendingDecision) {
    setStatus("Choose a footprint, draw a boundary, keep approximate, or defer.", true);
    return;
  }
  if (!note) {
    setStatus("An evidence or decision note is required.", true);
    return;
  }
  const updatedOverrides = structuredClone(overrides);
  const existing = updatedOverrides.locations[item.service_id];
  updatedOverrides.locations[item.service_id] = {
    ...existing,
    boundary: pendingDecision.boundary,
    triage_status: pendingDecision.status,
    ...(pendingDecision.selectedOsmUrl
      ? { selected_osm_url: pendingDecision.selectedOsmUrl }
      : { selected_osm_url: undefined }),
    note,
    reviewed_at: new Date().toISOString(),
  };
  saveButton.disabled = true;
  setStatus("Writing decision to data/curation-overrides.json...");
  try {
    overrides = await writeRepositoryOverrides(updatedOverrides);
    setStatus("Decision saved to data/curation-overrides.json.");
    renderProgress();
    rebuildQueue();
    selectNextUnreviewed(item.service_id);
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to save the decision.",
      true,
    );
  } finally {
    saveButton.disabled = false;
  }
});

function selectNextUnreviewed(afterId: string): void {
  const currentIndex = triageItems.findIndex((item) => item.service_id === afterId);
  for (let offset = 1; offset <= triageItems.length; offset += 1) {
    const candidate = triageItems[(currentIndex + offset) % triageItems.length];
    if (candidate && !isReviewed(candidate)) {
      selectedId = candidate.service_id;
      if (filterElement.value === "reviewed") {
        filterElement.value = "all";
      }
      rebuildQueue();
      return;
    }
  }
  rebuildQueue();
}

function moveSelection(direction: -1 | 1): void {
  if (queue.length === 0) {
    return;
  }
  const index = queue.findIndex((item) => item.service_id === selectedId);
  const nextIndex = index < 0 ? 0 : (index + direction + queue.length) % queue.length;
  const next = queue[nextIndex];
  if (next) {
    selectItem(next.service_id);
  }
}

requiredElement<HTMLButtonElement>("previous-triage").addEventListener("click", () =>
  moveSelection(-1),
);
requiredElement<HTMLButtonElement>("next-triage").addEventListener("click", () =>
  moveSelection(1),
);
filterElement.addEventListener("change", rebuildQueue);

requiredElement<HTMLButtonElement>("export-triage").addEventListener("click", () => {
  const blob = new Blob([`${JSON.stringify(overrides, null, 2)}\n`], {
    type: "application/json",
  });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "curation-overrides.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  setStatus("Overrides exported as a backup.");
});

requiredElement<HTMLInputElement>("import-triage").addEventListener(
  "change",
  async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    try {
      const imported = JSON.parse(await file.text()) as CurationOverrides;
      if (
        imported.version !== 1 ||
        !imported.locations ||
        !Array.isArray(imported.additions)
      ) {
        throw new Error("Unsupported overrides file");
      }
      overrides = await writeRepositoryOverrides(imported);
      rebuildQueue();
      setStatus("Overrides imported into data/curation-overrides.json.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Unable to import overrides.",
        true,
      );
    } finally {
      input.value = "";
    }
  },
);

requiredElement<HTMLButtonElement>("reset-local-triage").addEventListener(
  "click",
  async () => {
    try {
      overrides = await loadRepositoryOverrides();
      filterElement.value = "unreviewed";
      rebuildQueue();
      setStatus("Reloaded data/curation-overrides.json.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Unable to reload overrides.",
        true,
      );
    }
  },
);

async function loadTriageTool(): Promise<void> {
  const repositoryOverrides = await loadRepositoryOverrides();
  const migration = await migrateLegacyBrowserOverrides(repositoryOverrides);
  overrides = migration.document;

  map.addSource("triage-current-point", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("triage-candidates", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource("triage-draft", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "triage-candidate-fill",
    type: "fill",
    source: "triage-candidates",
    paint: {
      "fill-color": [
        "case",
        ["get", "selected"],
        "#f1b82d",
        "#8ca5aa",
      ],
      "fill-opacity": ["case", ["get", "selected"], 0.38, 0.18],
    },
  });
  map.addLayer({
    id: "triage-candidate-line",
    type: "line",
    source: "triage-candidates",
    paint: {
      "line-color": [
        "case",
        ["get", "selected"],
        "#8a5900",
        "#587178",
      ],
      "line-width": ["case", ["get", "selected"], 3, 1.5],
    },
  });
  map.addLayer({
    id: "triage-draft-fill",
    type: "fill",
    source: "triage-draft",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#b42352", "fill-opacity": 0.28 },
  });
  map.addLayer({
    id: "triage-draft-line",
    type: "line",
    source: "triage-draft",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#b42352", "line-width": 3 },
  });
  map.addLayer({
    id: "triage-draft-points",
    type: "circle",
    source: "triage-draft",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": "#ffffff",
      "circle-radius": 5,
      "circle-stroke-color": "#b42352",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "triage-current-point",
    type: "circle",
    source: "triage-current-point",
    paint: {
      "circle-color": "#b42352",
      "circle-radius": 8,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });

  rebuildQueue();
  setStatus(
    migration.migrated
      ? "Previous browser progress migrated to data/curation-overrides.json."
      : "Triage queue loaded. Decisions save directly to the repository file.",
  );
}

map.once("load", () => {
  loadTriageTool().catch((error: unknown) => {
    setStatus(
      error instanceof Error ? error.message : "Unable to load footprint triage.",
      true,
    );
  });
});
