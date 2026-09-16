import type { StyleSpecification } from "maplibre-gl";

const tileUrl = import.meta.env.DEV
  ? `${window.location.origin}/osm-tiles/{z}/{x}/{y}.png`
  : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const rasterMapStyle: StyleSpecification = {
  version: 8,
  name: "OpenStreetMap Standard",
  sources: {
    openstreetmap: {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#e9ece8",
      },
    },
    {
      id: "openstreetmap",
      type: "raster",
      source: "openstreetmap",
      paint: {
        "raster-opacity": 0.88,
        "raster-saturation": -0.2,
      },
    },
  ],
};
