const streets = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
};

export const BASEMAPS = Object.freeze({
  street: { ...streets, description: "Street map · roads and place names." },
  light: {
    ...streets,
    description: "Light map · a quieter background for your route.",
  },
  dark: {
    ...streets,
    description: "Dark map · a low-glare view of roads and places.",
  },
  satellite: {
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg",
    attribution:
      '<a href="https://maps.eox.at">EOX Maps</a> · <a href="https://cloudless.eox.at">EOxCloudless</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2025) · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>',
    maxNativeZoom: 14,
    description:
      "Sentinel-2 · 2025 composite · 10 m detail. This imagery is not live.",
  },
});

export function validBasemap(value) {
  return value === "auto" || Object.hasOwn(BASEMAPS, value);
}

export function resolveBasemap(value, theme) {
  return value === "auto" || !validBasemap(value)
    ? theme === "dark"
      ? "dark"
      : "street"
    : value;
}
