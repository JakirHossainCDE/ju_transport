export const TIME_ZONE = "Asia/Dhaka";
export function formatTime(value) {
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}
export function matchesRoute(route, query) {
  const bnDigits = "০১২৩৪৫৬৭৮৯";
  const normalise = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[০-৯]/g, (n) => bnDigits.indexOf(n))
      .trim();
  const term = normalise(query);
  return (
    !term ||
    normalise(
      [
        route.id,
        `route ${route.id}`,
        `রুট ${route.id}`,
        route.name,
        route.nameBn,
        ...(route.aliases || []),
      ].join(" "),
    ).includes(term)
  );
}
export function routeLengthKm(coords) {
  const rad = (v) => (v * Math.PI) / 180;
  let distance = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const lat = rad(b[0] - a[0]),
      lon = rad(b[1] - a[1]);
    const h =
      Math.sin(lat / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(lon / 2) ** 2;
    distance += 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  return distance;
}
export function validateData(data) {
  if (!data || !Array.isArray(data.routes) || !data.routes.length)
    throw new Error("Route data is missing.");
  const ids = new Set();
  for (const route of data.routes) {
    if (
      !/^\d+$/.test(route.id) ||
      ids.has(route.id) ||
      !route.name ||
      !route.nameBn ||
      !/^#[0-9a-f]{6}$/i.test(route.color)
    )
      throw new Error("Invalid route details.");
    ids.add(route.id);
    if (
      !Array.isArray(route.coordinates) ||
      route.coordinates.length < 2 ||
      route.coordinates.some(
        (c) =>
          !Array.isArray(c) ||
          c.length !== 2 ||
          !c.every(Number.isFinite) ||
          Math.abs(c[0]) > 90 ||
          Math.abs(c[1]) > 180,
      )
    )
      throw new Error("Invalid route coordinates.");
    for (const key of ["toCampus", "fromCampus"]) {
      if (
        !Array.isArray(route[key]) ||
        !route[key].length ||
        route[key].some((t) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))
      )
        throw new Error("Invalid departure times.");
    }
  }
  return data;
}
export function timetableCsv(routes) {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ["JU Transport reference timetable — unverified operating days"],
    [
      "Source: original project, December 2025. Confirm with JU Transport Office before travelling.",
    ],
    [
      "Official schedule: https://www.juniv.edu/office/transport-office/program/bus-schedule",
    ],
    [
      "Route",
      "Dhaka departure point",
      "To JU Campus (Asia/Dhaka)",
      "From JU Campus (Asia/Dhaka)",
    ],
    ...routes.map((r) => [
      r.id,
      r.name,
      r.toCampus.map(formatTime).join(" | "),
      r.fromCampus.map(formatTime).join(" | "),
    ]),
  ];
  return "\ufeff" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
}
export function aqiDescription(value) {
  if (!Number.isFinite(value) || value < 0) return "Unavailable";
  if (value <= 50) return "Good";
  if (value <= 100) return "Moderate";
  if (value <= 150) return "Unhealthy for sensitive groups";
  if (value <= 200) return "Unhealthy";
  if (value <= 300) return "Very unhealthy";
  return "Hazardous";
}
export function weatherDescription(code) {
  if (code === 0) return "Clear sky";
  if ([1, 2].includes(code)) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Current model estimate";
}
