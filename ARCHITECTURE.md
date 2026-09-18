# Architecture

## Overview

The project separates source data, reviewed decisions, generated geospatial
assets and the static browser application:

```text
pregnancy_termination_services.json
data/source-metadata.json
data/osm/building-boundaries.json
data/curation-overrides.json
                 │
                 ▼
        scripts/build-data.mjs
                 │
                 ▼
 public/data/{locations,zones,buildings,uncertainty-zones}.geojson
                 │
                 ▼
     Vite + TypeScript + MapLibre
                 │
                 ▼
            static dist/
```

`src/main.ts` is the deployable public map. `src/admin.ts` is the public
contribution editor: it prepares a structured GitHub issue rather than writing
repository data from the browser. `src/triage.ts` remains a local-only curation
tool.

## Data processing

The build performs these steps:

1. Validate that the supplied source is an array.
2. Exclude virtual records and records without finite coordinates.
3. Merge manual additions and per-location overrides.
4. Classify each record as `clinic`, `doctor` or `hospital`.
5. Select manual premises geometry, otherwise an accepted OSM containing
   building, otherwise the source point.
6. Generate a 150 metre Turf buffer with 48 steps.
7. Generate a 200 metre uncertainty polygon only for unmatched point records.
8. Attach Healthdirect NHSD attribution and the source sync timestamp.
9. Write compact static GeoJSON and build metadata.

No browser request is made to Healthdirect, AURIN, OSM or Overpass. All provider
and zone data is generated before deployment. The Healthdirect scraper updates
`data/source-metadata.json` after a completed sync; rebuilding map assets does
not change that source timestamp.

## Building matching

`scripts/fetch-buildings.mjs` sends one batched Overpass query for buildings
within 80 metres of each physical service. It supports OSM ways and closed outer
members of multipolygon relations.

A candidate is automatically accepted when the supplied service point is
inside its polygon. If multiple buildings contain the point, the smallest
polygon is selected. The matcher also accepts a nearby named shopping centre
when its meaningful name tokens match the provider name, using the whole centre
building as a conservative site boundary. Other nearby-but-not-containing
buildings are deliberately not accepted because dense urban locations make
nearest-centroid matching unsafe.

Each accepted match retains:

- service ID and name
- OSM object type and ID
- OSM URL and name, if present
- match method and timestamp
- source polygon

The local editor can replace any automatic footprint with reviewed premises
geometry. For unmatched records it displays up to five nearby candidate
footprints, their edge distance and OSM links. A reviewer may load the nearest
candidate as a draft boundary or draw a different premises polygon.

## Map behavior

MapLibre loads a local raster style backed by the standard OpenStreetMap tile
endpoint and four local overlay sources:

- `locations`: clustered points used at national/regional zooms
- `zones`: indicative 150 metre polygons visible from zoom 10
- `uncertainty`: translucent 200 metre point buffers for unmatched records
- `buildings`: matched or manual premises visible from zoom 14

Category changes update the clustered source itself so cluster counts reflect
only enabled categories. Empty categories are omitted from the controls, and
polygon layers use equivalent MapLibre filters. Zone, building and uncertainty
layers are always enabled because they are the map's primary output.

The application provides keyboard-accessible category controls and explicit
confidence descriptions. On mobile the map occupies the first 72% of the
viewport and precedes the explanatory controls.

## Curation model

`data/curation-overrides.json` is the reviewed audit layer:

```json
{
  "version": 1,
  "locations": {
    "source-service-id": {
      "category": "clinic",
      "removed": false,
      "boundary": {
        "type": "Polygon",
        "coordinates": []
      },
      "note": "Required evidence and reason",
      "reviewed_at": "ISO-8601 timestamp"
    }
  },
  "additions": []
}
```

Source records are not modified or destructively deleted. An override with
`removed: true` suppresses publication while preserving the decision. The
editor requires notes for every saved correction, removal and addition.

The dedicated triage page reads and atomically writes this file through a
development-only Vite endpoint. The endpoint accepts only the fixed
`data/curation-overrides.json` path and is absent from the production build;
the GitHub Pages application remains static and read-only.

Public edit and addition proposals encode a versioned request into a pre-filled
GitHub issue. An issue-triggered workflow validates the service ID, category,
coordinates and optional polygon, applies the request to the curation file,
regenerates public data and opens a pull request. The workflow never executes
issue text as code, and merging remains a repository-maintainer action.

## Legal geometry status

Every generated zone is labelled indicative and carries a jurisdiction-specific
note. The current implementation intentionally uses one simplified geometric
operation while exposing its evidence:

- `manual-premises`: reviewed polygon buffered by 150 metres
- `osm-containing-building`: containing OSM building buffered by 150 metres
- `point-radius`: 150 metre circle plus a 200 metre uncertainty area

Future jurisdiction modules can replace this simplification with NSW access
points, Queensland entrances, South Australian public-area intersections and
ACT declared polygons without changing the map data contract.

## Candidate source staging

External state directories are normalized privately before a source-neutral
publication artifact enters the public data pipeline:

```text
data/source-requests/{SCHEMA.json,sources.json,...}
                 │
                 ▼
 scripts/collect-provider-sources.mjs or reviewed state PROMPT.txt
                 │
                 ▼
 data/source-staging/<state>/providers.json  (git-ignored)
                 │
                 ▼
 scripts/build-supplemental-locations.mjs
                 │
                 ▼
 data/supplemental-locations.json
```

Machine-readable collection retains only physical facilities explicitly
flagged for medical or surgical abortion. Normalization drops source contact
details and notes, named clinicians, pharmacies, virtual-only and referral-only
records, and unrelated services. Prose extraction follows the same schema and
must retain a short source evidence statement for each record. The validator
checks identifiers, state codes, coordinates, facility status, evidence and
excluded contact patterns.

No staging file is read by `scripts/build-data.mjs`. The supplemental builder
requires private permission status, applies coordinate overrides, removes
source identity and evidence, excludes contact fields and named practitioners,
and deduplicates against Healthdirect before deduplicating same-premises
supplemental records. Only the resulting source-neutral file is public.

`scripts/fetch-buildings.mjs` preserves existing automatic and reviewed
footprints, batches only unresolved combined-service points through Overpass,
and writes the remaining queue for local triage. Supplemental records never
receive Healthdirect attribution; Healthdirect provenance remains attached only
to the original source features.

## Deployment

`npm run build` regenerates public data, checks TypeScript and creates `dist/`.
GitHub Pages serves only static files and has no API keys, editing endpoint or
runtime database. The contribution editor is a second production entry; the
triage tool and its local write endpoint are excluded.
