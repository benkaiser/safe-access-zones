export type FacilityCategory = "clinic" | "doctor" | "hospital";

export interface FacilityProperties {
  id: string;
  name: string;
  category: FacilityCategory;
  service_type: string;
  suburb: string;
  state: string;
  postcode: string;
  phone: string;
  website: string;
  appointment_required: boolean;
  geometry_source: "manual" | "openstreetmap" | "point";
  boundary_status: "manual" | "matched" | "unmatched";
  zone_basis: "manual-premises" | "osm-containing-building" | "point-radius";
  zone_confidence: "reviewed" | "building-match" | "approximate";
  legal_note: string;
  osm_url?: string;
  data_source: string;
  data_source_url: string;
  source_synced_at: string;
}

export interface GeoJsonFeature<
  P = Record<string, unknown>,
  G extends GeoJSON.Geometry = GeoJSON.Geometry,
> extends GeoJSON.Feature<G, P> {
  id?: string | number;
}

export type FacilityFeature = GeoJsonFeature<FacilityProperties, GeoJSON.Point>;
export type FacilityCollection = GeoJSON.FeatureCollection<GeoJSON.Point, FacilityProperties>;

export interface CurationDecision {
  category?: FacilityCategory;
  removed?: boolean;
  boundary?: GeoJSON.Polygon | null;
  triage_status?:
    | "accepted-candidate"
    | "manual-boundary"
    | "keep-approximate"
    | "deferred";
  selected_osm_url?: string;
  source_issue_url?: string;
  note: string;
  reviewed_at: string;
}

export interface ManualAddition {
  id: string;
  name: string;
  category: FacilityCategory;
  state: string;
  suburb: string;
  latitude: number;
  longitude: number;
  note: string;
  added_at: string;
  source_issue_url?: string;
}

export interface CurationOverrides {
  version: 1;
  locations: Record<string, CurationDecision>;
  additions: ManualAddition[];
}
