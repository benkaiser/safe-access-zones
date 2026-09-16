# Safe Access Zones Australia

A static MapLibre map of indicative safe-access areas around physical
pregnancy-termination services in Australia. It is designed for GitHub Pages and
includes a local editor for reviewing classifications, removals and premises
boundaries.

The map is a planning and research aid, not legal advice. Safe-access-zone
definitions differ between Australian jurisdictions. In particular, the ACT
uses declared protected areas, Queensland ordinarily measures from entrances,
NSW also covers pedestrian access points, and South Australia limits parts of
its zone to qualifying public areas. The current automated output intentionally
does not model those walkway, entrance or public-area details.

## Current dataset

`pregnancy_termination_services.json` contains 36 Healthdirect pregnancy
termination service records:

- 31 physical services displayed on the map
- 5 virtual or telephone services excluded from location-based zones
- 18 records initially classified as clinics
- 13 initially classified as doctors or general practices
- no hospital-classified records in the current export

`data/source-metadata.json` records the Healthdirect NHSD attribution and the
time the source was last synced. `scrape_healthdirect.py` updates that record
only after a scrape completes; ordinary map builds preserve the source sync
date and record a separate build timestamp.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run build:data
npm run dev
```

Vite prints the local URL. The public map is at `/`; the public contribution
editor is at `/admin.html`, and dedicated unmatched-footprint triage is at
`/triage.html`. The production build includes the contribution editor but
excludes the local triage tool and its curation notes.

## Building footprints

Fetch OSM buildings near every physical service and accept only a footprint
that contains the supplied service point:

```bash
npm run fetch:buildings
npm run build:data
```

The current snapshot has a footprint for all 31 physical services: 18 initial
automatic matches and 13 reviewed triage decisions. Automatic matches are
stored in `data/osm/building-boundaries.json` with their OSM identifiers and
attribution. A nearby named shopping-centre footprint can also be accepted when
its place name matches the service name, supporting confirmed tenancies without
absorbing an unrelated centre into the zone.

Refreshing OSM data writes unmatched records and their five closest mapped
buildings within 80 metres to
`data/osm/unmatched-building-candidates.json`. Reviewed decisions in
`data/curation-overrides.json` resolve the current candidate queue.

For a matched or manually drawn boundary, the build creates an indicative
150 metre buffer. For unmatched records, it creates:

- a 150 metre point-radius zone; and
- a translucent 200 metre area representing the additional 50 metres of
  positional/premises uncertainty requested by the design.

## Curation workflow

1. Run `npm run build:data && npm run dev`.
2. Open `/triage.html` for maintainer footprint curation.
3. Select a facility, choose or draw its premises, and add the required note.
4. The triage tool writes each successful save directly to
   `data/curation-overrides.json`; export is available as an optional backup.
5. Run `npm run build:data` and review the public map.

Additions require a name, state, coordinates and evidence note. Removals remain
in the override audit file rather than being deleted from the source.

The public contribution editor begins with an edit-or-add choice and opens a
pre-filled issue in `benkaiser/safe-access-zones`. A GitHub Actions workflow
validates its embedded change request, updates the override file, rebuilds the
map data and opens a pull request. Repository settings must allow GitHub Actions
to create pull requests. Changes remain subject to review and manual merge.

The triage tool provides reason-based queue filters, candidate footprint cards,
map comparison, manual drawing, accept/approximate/defer decisions, required
notes, and previous/next navigation. Its read/write endpoint exists only in the
Vite development server and is not included in the GitHub Pages build.

## Commands

```bash
npm run dev              # public map and local editor
npm run fetch:buildings  # refresh best-effort OSM footprint matches
npm run build:data       # regenerate static GeoJSON
npm test                 # data transformation tests
npm run typecheck        # TypeScript checks
npm run build            # complete production build
npm run preview          # preview dist/
```

## Attribution

Location data is attributed to Healthdirect Australia's National Health
Services Directory (NHSD), with the last source sync date displayed in the
public map footer and retained on each generated feature.

Building geometry and the OpenFreeMap basemap contain OpenStreetMap data:
`© OpenStreetMap contributors`, available under the
[Open Database Licence](https://www.openstreetmap.org/copyright).

The pilot basemap uses the standard OpenStreetMap raster endpoint through the
style in `src/map-style.ts`. Local development routes tiles through Vite's
same-origin `/osm-tiles` proxy to avoid cross-origin browser-cache conflicts;
production browsers request OSM directly. The map requests only tiles actively
viewed by a user and relies on normal browser caching, as required by the
[OSMF tile policy](https://operations.osmfoundation.org/policies/tiles/). A
higher-traffic deployment should have a planned PMTiles or contracted
tile-hosting path rather than relying indefinitely on a best-effort community
endpoint.
