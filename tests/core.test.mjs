import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatTime,
  matchesRoute,
  routeLengthKm,
  validateData,
  timetableCsv,
  aqiDescription,
} from "../js/core.js";
const data = JSON.parse(
  await readFile(new URL("../data/routes.json", import.meta.url), "utf8"),
);
test("All seven reference routes retain the original 21 departures", () => {
  validateData(data);
  assert.equal(data.routes.length, 7);
  assert.deepEqual(
    data.routes.map((r) => r.toCampus),
    [
      ["07:00"],
      ["07:30"],
      ["07:30"],
      ["07:00"],
      ["07:15"],
      ["07:15"],
      ["07:15", "17:00", "18:00", "19:30", "20:30"],
    ],
  );
  assert.deepEqual(
    data.routes.map((r) => r.fromCampus),
    [
      ["15:30"],
      ["15:30"],
      ["15:30"],
      ["15:30", "17:00"],
      ["17:00"],
      ["17:00"],
      ["15:00", "17:00", "20:00"],
    ],
  );
  assert.equal(data.meta.verifiedOperatingSchedule, false);
  assert.equal(data.meta.serviceDays, null);
});
test("Midnight, noon and evening departures display correctly", () => {
  assert.equal(formatTime("00:00"), "12:00 AM");
  assert.equal(formatTime("12:00"), "12:00 PM");
  assert.equal(formatTime("20:30"), "8:30 PM");
});
test("Routes can be found by English, Bengali, number and legacy spelling", () => {
  assert.ok(matchesRoute(data.routes[4], "  KHILGHET  "));
  assert.ok(matchesRoute(data.routes[4], "খিলক্ষেত"));
  assert.ok(matchesRoute(data.routes[1], "মিরপুর ১২"));
  assert.ok(matchesRoute(data.routes[6], "route 7"));
  assert.ok(!matchesRoute(data.routes[6], "airport"));
});
test("Bad coordinates, duplicate IDs and impossible departure times are rejected", () => {
  for (const mutate of [
    (d) => (d.routes[0].coordinates[0][0] = 200),
    (d) => (d.routes[1].id = "1"),
    (d) => (d.routes[0].toCampus = ["25:00"]),
  ]) {
    const copy = structuredClone(data);
    mutate(copy);
    assert.throws(() => validateData(copy));
  }
});
test("Geometric length uses kilometres with known equatorial distance", () => {
  assert.equal(
    routeLengthKm([
      [0, 0],
      [0, 0],
    ]),
    0,
  );
  assert.ok(
    Math.abs(
      routeLengthKm([
        [0, 0],
        [0, 1],
      ]) - 111.195,
    ) < 0.01,
  );
  for (const r of data.routes)
    assert.ok(
      routeLengthKm(r.coordinates) > 5 && routeLengthKm(r.coordinates) < 100,
    );
});
test("CSV keeps every departure and makes its unverified status explicit", () => {
  const csv = timetableCsv(data.routes);
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /unverified operating days/);
  assert.match(csv, /7:15 AM \| 5:00 PM \| 6:00 PM \| 7:30 PM \| 8:30 PM/);
  assert.match(csv, /3:00 PM \| 5:00 PM \| 8:00 PM/);
});
test("US AQI category boundaries do not mislabel unhealthy air", () => {
  assert.equal(aqiDescription(50), "Good");
  assert.equal(aqiDescription(51), "Moderate");
  assert.equal(aqiDescription(101), "Unhealthy for sensitive groups");
  assert.equal(aqiDescription(151), "Unhealthy");
  assert.equal(aqiDescription(301), "Hazardous");
  assert.equal(aqiDescription(null), "Unavailable");
});
