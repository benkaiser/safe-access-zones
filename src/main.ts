import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map,
} from "maplibre-gl";
import "./styles.css";
import { rasterMapStyle } from "./map-style";
import type {
  FacilityCategory,
  FacilityCollection,
  FacilityFeature,
  FacilityProperties,
} from "./types";

const CATEGORY_CONFIG: Record<
  FacilityCategory,
  { label: string; color: string }
> = {
  clinic: { label: "Abortion clinics", color: "#b42352" },
  doctor: { label: "Doctors and general practices", color: "#176f83" },
  hospital: { label: "Hospitals", color: "#6d4ab0" },
};

const categoryColor: ExpressionSpecification = [
  "match",
  ["get", "category"],
  "clinic",
  CATEGORY_CONFIG.clinic.color,
  "doctor",
  CATEGORY_CONFIG.doctor.color,
  "hospital",
  CATEGORY_CONFIG.hospital.color,
  "#53656c",
];

const map = new maplibregl.Map({
  container: "map",
  style: rasterMapStyle,
  center: [134.2, -26.5],
  zoom: 3.3,
  minZoom: 2.5,
  maxZoom: 19,
  attributionControl: false,
});
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
  }),
);
map.addControl(new maplibregl.NavigationControl(), "top-right");

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required map control is missing: ${selector}`);
  }
  return element;
}

const categoryFilters = requiredElement<HTMLDivElement>("#category-filters");
const status = requiredElement<HTMLDivElement>("#map-status");
const sourceSyncDate = requiredElement<HTMLTimeElement>("#source-sync-date");
const enabledCategories = new Set<FacilityCategory>(
  Object.keys(CATEGORY_CONFIG) as FacilityCategory[],
);
let allLocations: FacilityCollection = { type: "FeatureCollection", features: [] };

function categoryFilterExpression(): ExpressionSpecification {
  return [
    "in",
    ["get", "category"],
    ["literal", [...enabledCategories]],
  ];
}

function renderCategoryControls(): void {
  categoryFilters.replaceChildren();
  for (const [category, config] of Object.entries(CATEGORY_CONFIG) as [
    FacilityCategory,
    (typeof CATEGORY_CONFIG)[FacilityCategory],
  ][]) {
    const count = allLocations.features.filter(
      (feature) => feature.properties.category === category,
    ).length;
    if (count === 0) {
      enabledCategories.delete(category);
      continue;
    }

    const label = document.createElement("label");
    label.className = "toggle-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabledCategories.has(category);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        enabledCategories.add(category);
      } else {
        enabledCategories.delete(category);
      }
      applyCategoryFilters();
    });

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = config.color;

    const text = document.createElement("span");
    text.textContent = `${config.label} (${count})`;

    label.append(checkbox, swatch, text);
    categoryFilters.append(label);
  }
}

function applyCategoryFilters(): void {
  const locationSource = map.getSource("locations") as GeoJSONSource | undefined;
  if (locationSource) {
    locationSource.setData({
      type: "FeatureCollection",
      features: allLocations.features.filter((feature) =>
        enabledCategories.has(feature.properties.category),
      ),
    });
  }
  const expression = categoryFilterExpression();
  for (const layer of [
    "zones-fill",
    "zones-line",
    "uncertainty-fill",
    "buildings-fill",
    "buildings-line",
  ]) {
    if (map.getLayer(layer)) {
      map.setFilter(layer, expression);
    }
  }
}

function popupContent(properties: FacilityProperties): HTMLElement {
  const container = document.createElement("article");

  const category = document.createElement("p");
  category.className = "popup-category";
  category.textContent = CATEGORY_CONFIG[properties.category].label;

  const title = document.createElement("h3");
  title.className = "popup-title";
  title.textContent = properties.name;

  const location = document.createElement("p");
  location.className = "popup-meta";
  location.textContent = [properties.suburb, properties.state, properties.postcode]
    .filter(Boolean)
    .join(" ");

  const confidence = document.createElement("p");
  confidence.className = "popup-confidence";
  confidence.textContent =
    properties.boundary_status === "unmatched"
      ? "Approximate: 150 m from the listed point, with a 50 m uncertainty area."
      : properties.boundary_status === "manual"
        ? "Reviewed premises boundary with an indicative 150 m buffer."
        : "OSM building match with an indicative 150 m buffer.";

  const note = document.createElement("p");
  note.className = "popup-meta";
  note.textContent = properties.legal_note;

  container.append(category, title, location, confidence, note);

  if (properties.phone) {
    const phone = document.createElement("a");
    phone.href = `tel:${properties.phone.replace(/[^\d+]/g, "")}`;
    phone.textContent = properties.phone;
    container.append(phone);
  }
  if (properties.website) {
    const separator = document.createTextNode(properties.phone ? " · " : "");
    const website = document.createElement("a");
    website.href = properties.website;
    website.target = "_blank";
    website.rel = "noreferrer";
    website.textContent = "Provider website";
    container.append(separator, website);
  }
  if (properties.osm_url) {
    const paragraph = document.createElement("p");
    paragraph.className = "popup-meta";
    const osmLink = document.createElement("a");
    osmLink.href = properties.osm_url;
    osmLink.target = "_blank";
    osmLink.rel = "noreferrer";
    osmLink.textContent = "View matched building on OpenStreetMap";
    paragraph.append(osmLink);
    container.append(paragraph);
  }

  return container;
}

function openFacility(feature: FacilityFeature): void {
  const longitude = feature.geometry.coordinates[0];
  const latitude = feature.geometry.coordinates[1];
  if (typeof longitude !== "number" || typeof latitude !== "number") {
    return;
  }
  map.flyTo({ center: [longitude, latitude], zoom: 17 });
  new maplibregl.Popup({ offset: 16 })
    .setLngLat([longitude, latitude])
    .setDOMContent(popupContent(feature.properties))
    .addTo(map);
}

function addMapLayers(
  locations: FacilityCollection,
  zones: GeoJSON.FeatureCollection,
  uncertainty: GeoJSON.FeatureCollection,
  buildings: GeoJSON.FeatureCollection,
): void {
  map.addSource("uncertainty", { type: "geojson", data: uncertainty });
  map.addLayer({
    id: "uncertainty-fill",
    type: "fill",
    source: "uncertainty",
    minzoom: 11,
    paint: {
      "fill-color": categoryColor,
      "fill-opacity": 0.08,
      "fill-outline-color": categoryColor,
    },
  });

  map.addSource("zones", { type: "geojson", data: zones });
  map.addLayer({
    id: "zones-fill",
    type: "fill",
    source: "zones",
    minzoom: 10,
    paint: {
      "fill-color": categoryColor,
      "fill-opacity": 0.18,
    },
  });
  map.addLayer({
    id: "zones-line",
    type: "line",
    source: "zones",
    minzoom: 10,
    paint: {
      "line-color": categoryColor,
      "line-width": 2,
      "line-opacity": 0.75,
    },
  });

  map.addSource("buildings", { type: "geojson", data: buildings });
  map.addLayer({
    id: "buildings-fill",
    type: "fill",
    source: "buildings",
    minzoom: 14,
    paint: {
      "fill-color": categoryColor,
      "fill-opacity": 0.32,
    },
  });
  map.addLayer({
    id: "buildings-line",
    type: "line",
    source: "buildings",
    minzoom: 14,
    paint: {
      "line-color": categoryColor,
      "line-width": 2.5,
    },
  });

  map.addSource("locations", {
    type: "geojson",
    data: locations,
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 46,
  });
  map.addLayer({
    id: "clusters",
    type: "circle",
    source: "locations",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#22363e",
      "circle-radius": [
        "step",
        ["get", "point_count"],
        17,
        5,
        21,
        12,
        26,
      ],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "cluster-count",
    type: "symbol",
    source: "locations",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
    },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: "unclustered-point",
    type: "circle",
    source: "locations",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": categoryColor,
      "circle-radius": 7,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  map.on("click", "clusters", async (event) => {
    const cluster = map.queryRenderedFeatures(event.point, {
      layers: ["clusters"],
    })[0];
    const clusterId = cluster?.properties?.cluster_id as number | undefined;
    const coordinates =
      cluster?.geometry.type === "Point" ? cluster.geometry.coordinates : undefined;
    const source = map.getSource("locations") as GeoJSONSource;
    if (clusterId === undefined || !coordinates) {
      return;
    }
    const zoom = await source.getClusterExpansionZoom(clusterId);
    map.easeTo({ center: coordinates as [number, number], zoom });
  });

  map.on("click", "unclustered-point", (event) => {
    const rendered = event.features?.[0];
    if (!rendered || rendered.geometry.type !== "Point") {
      return;
    }
    const feature = allLocations.features.find(
      (candidate) => candidate.properties.id === rendered.properties?.id,
    );
    if (feature) {
      openFacility(feature);
    }
  });

  for (const layer of ["clusters", "unclustered-point"]) {
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
    });
  }
}

async function loadData(): Promise<void> {
  const [
    locationsResponse,
    zonesResponse,
    uncertaintyResponse,
    buildingsResponse,
    metadataResponse,
  ] =
    await Promise.all([
      fetch("./data/locations.geojson"),
      fetch("./data/zones.geojson"),
      fetch("./data/uncertainty-zones.geojson"),
      fetch("./data/buildings.geojson"),
      fetch("./data/metadata.json"),
    ]);
  for (const response of [
    locationsResponse,
    zonesResponse,
    uncertaintyResponse,
    buildingsResponse,
    metadataResponse,
  ]) {
    if (!response.ok) {
      throw new Error(`Unable to load ${response.url}: ${response.status}`);
    }
  }

  allLocations = (await locationsResponse.json()) as FacilityCollection;
  const zones = (await zonesResponse.json()) as GeoJSON.FeatureCollection;
  const uncertainty =
    (await uncertaintyResponse.json()) as GeoJSON.FeatureCollection;
  const buildings = (await buildingsResponse.json()) as GeoJSON.FeatureCollection;
  const metadata = (await metadataResponse.json()) as {
    source: { synced_at: string };
  };
  const syncedAt = new Date(metadata.source.synced_at);
  if (Number.isNaN(syncedAt.getTime())) {
    throw new Error("Source sync date is invalid");
  }
  sourceSyncDate.dateTime = syncedAt.toISOString();
  sourceSyncDate.textContent = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(syncedAt);

  addMapLayers(allLocations, zones, uncertainty, buildings);
  renderCategoryControls();
  status.textContent = `${allLocations.features.length} physical services loaded`;
  window.setTimeout(() => {
    status.hidden = true;
  }, 3500);
}

map.once("load", () => {
  loadData().catch((error: unknown) => {
    console.error(error);
    status.textContent =
      error instanceof Error ? error.message : "Unable to load map data";
  });
});
