import { initTracking } from "./live-tracking.js";
import { BASEMAPS, validBasemap, resolveBasemap } from "./basemaps.js";
import {
  TIME_ZONE,
  formatTime,
  matchesRoute,
  routeLengthKm,
  validateData,
  timetableCsv,
  aqiDescription,
  weatherDescription,
} from "./core.js";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const svg = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function readStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
let tracker;
let routes = [],
  map,
  tileLayer,
  routeLayer,
  positionLayer,
  accuracyLayer,
  showAll = false;
let selectedId = "1",
  direction = "to-campus",
  currentView = "map",
  savedOnly = false;
const requestedBasemap = new URLSearchParams(location.search).get("basemap"),
  storedBasemap = readStored("ju-basemap", "auto");
let basemapPreference = validBasemap(requestedBasemap)
  ? requestedBasemap
  : validBasemap(storedBasemap)
    ? storedBasemap
    : "auto";
const stored = readStored("ju-saved-routes", []);
const saved = new Set(
  Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [],
);
let toastTimer,
  activeDialogTrigger,
  weatherBusy = false;
function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
}
function updateClock() {
  const date = new Date();
  $("#dhaka-clock").textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .toUpperCase();
  $("#dhaka-clock").dateTime = date.toISOString();
  $("#dhaka-date").textContent =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(date) + " · Dhaka";
}
updateClock();
setInterval(updateClock, 30000);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $$("[data-theme]")
    .filter((e) => e.tagName === "BUTTON")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  try {
    localStorage.setItem("ju-theme", theme);
  } catch {}
  $('meta[name="theme-color"]').content =
    theme === "dark" ? "#111e19" : "#174d40";
  if (map && basemapPreference === "auto") updateBasemap();
}
setTheme(document.documentElement.dataset.theme || "light");
$$("button[data-theme]").forEach((button) =>
  button.addEventListener("click", () => {
    setTheme(button.dataset.theme);
    const url = new URL(location.href);
    url.searchParams.set(
      "theme",
      button.dataset.theme === "dark" ? "night" : "day",
    );
    history.replaceState(null, "", url);
  }),
);
function openDialog(id, trigger) {
  activeDialogTrigger = trigger;
  $(id).showModal();
}
function closeDialog(id) {
  $(id).close();
  activeDialogTrigger?.focus();
}
$$("[data-open-about]").forEach((b) =>
  b.addEventListener("click", () => openDialog("#about-dialog", b)),
);
$("#close-about").addEventListener("click", () => closeDialog("#about-dialog"));
$("#close-share").addEventListener("click", () => closeDialog("#share-dialog"));
$$("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        closeDialog("#" + dialog.id);
    }
  }),
);
function connectivity() {
  $("#offline-note").hidden = navigator.onLine;
}
window.addEventListener("offline", connectivity);
window.addEventListener("online", () => {
  connectivity();
  if (tileLayer) tileLayer.redraw();
  fetchWeather();
});
connectivity();
function parseUrl() {
  const params = new URLSearchParams(location.search);
  selectedId = routes.some((r) => r.id === params.get("route"))
    ? params.get("route")
    : routes[0].id;
  direction =
    params.get("direction") === "from-campus" ? "from-campus" : "to-campus";
  currentView = params.get("view") === "timetable" ? "timetable" : "map";
}
function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("route", selectedId);
  url.searchParams.set("direction", direction);
  if (currentView === "map") url.searchParams.delete("view");
  else url.searchParams.set("view", currentView);
  history.replaceState(null, "", url);
}
function selectedRoute() {
  return routes.find((r) => r.id === selectedId);
}
function timesFor(route) {
  return direction === "to-campus" ? route.toCampus : route.fromCampus;
}
function endpoints(route) {
  return direction === "to-campus"
    ? [route.name, "JU Campus"]
    : ["JU Campus", route.name];
}
function renderRoutes() {
  const visible = routes.filter(
    (r) =>
      matchesRoute(r, $("#route-search").value) &&
      (!savedOnly || saved.has(r.id)),
  );
  $("#route-count").textContent =
    `${visible.length} route${visible.length === 1 ? "" : "s"}`;
  $("#route-list").innerHTML = visible
    .map((r) => {
      const [from, to] = endpoints(r),
        times = timesFor(r);
      return `<div class="route-row ${r.id === selectedId ? "selected" : ""}" style="--route-color:${r.color}"><button type="button" class="route-select" data-route="${r.id}" aria-pressed="${r.id === selectedId}" aria-label="Route ${r.id}: ${esc(from)} to ${esc(to)}"><span class="route-badge">${r.id}</span><span class="route-text"><strong>${esc(r.name)}</strong><small lang="bn">${esc(r.nameBn)}</small><small class="route-destination">${formatTime(times[0])}${times.length > 1 ? ` + ${times.length - 1} more` : ""} · ${direction === "to-campus" ? "to campus" : "from campus"}</small></span></button><button type="button" class="save-route" data-save="${r.id}" aria-pressed="${saved.has(r.id)}" aria-label="${saved.has(r.id) ? "Unsave" : "Save"} route ${r.id}, ${esc(r.name)}">${svg("star")}</button></div>`;
    })
    .join("");
  $("#empty-routes").hidden = visible.length > 0;
}
function renderDetails() {
  tracker?.refresh();
  const route = selectedRoute(),
    [from, to] = endpoints(route),
    times = timesFor(route);
  $("#map-heading").textContent = showAll
    ? "All seven routes"
    : `Route ${route.id} · ${route.name}`;
  $("#route-detail").innerHTML =
    `<div class="detail-head" style="--route-color:${route.color}"><span class="route-badge">${route.id}</span><div><p class="eyebrow">${direction === "to-campus" ? "DHAKA → CAMPUS" : "CAMPUS → DHAKA"}</p><h2 id="route-title">${esc(route.name)}</h2></div><div class="detail-actions"><button type="button" class="share-button" id="share-route">${svg("share")}Share route</button></div></div><div class="detail-body" style="--route-color:${route.color}"><div class="journey"><div><span class="journey-dot" aria-hidden="true"></span><div><small>FROM</small><strong>${esc(from)}</strong></div></div><div><span class="journey-dot" aria-hidden="true"></span><div><small>TO</small><strong>${esc(to)}</strong></div></div></div><div class="departures"><p class="eyebrow">LISTED DEPARTURES · DHAKA TIME</p><div class="departure-times">${times.map((t) => `<span class="time-chip">${formatTime(t)}</span>`).join("")}</div><p>Reference times · check service days before travelling.</p></div></div><div class="detail-footer"><span class="route-distance">${svg("map-icon")}Approx. ${routeLengthKm(route.coordinates).toFixed(1)} km mapped path</span><a href="https://www.google.com/maps/search/?api=1&query=${(direction === "to-campus" ? route.coordinates[0] : route.coordinates.at(-1)).join(",")}" target="_blank" rel="noopener noreferrer">Departure point ↗</a></div>`;
}
function renderTable() {
  $("#timetable-body").innerHTML = routes
    .map(
      (r) =>
        `<tr><td><span class="route-badge" style="--route-color:${r.color}">${r.id}</span></td><td><strong>${esc(r.name)}</strong><small lang="bn">${esc(r.nameBn)}</small></td>${[r.toCampus, r.fromCampus].map((times) => `<td><div class="times-wrap">${times.map((t) => `<span class="time-chip">${formatTime(t)}</span>`).join("")}</div></td>`).join("")}<td><button type="button" class="text-button" data-table-route="${r.id}" aria-label="View route ${r.id} ${esc(r.name)} on map">View map ↗</button></td></tr>`,
    )
    .join("");
}
function selectRoute(id, focusMap = false) {
  if (!routes.some((r) => r.id === id)) return;
  selectedId = id;
  showAll = false;
  $("#all-routes").setAttribute("aria-pressed", "false");
  $("#all-routes").textContent = "Show all routes";
  renderRoutes();
  renderDetails();
  drawRoutes();
  updateUrl();
  if (focusMap) $(`[data-route="${id}"]`)?.focus({ preventScroll: true });
  if (focusMap && innerWidth <= 680)
    $(".map-card").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
}
function selectDirection(value) {
  direction = value;
  $$("[data-direction]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.direction === direction)),
  );
  renderRoutes();
  renderDetails();
  drawRoutes();
  updateUrl();
}
function selectView(view, focus = false) {
  currentView = view;
  $$("[data-view]").forEach((b) => {
    const active = b.dataset.view === view;
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
    if (active && focus) b.focus();
  });
  $("#map-view").hidden = view !== "map";
  $("#table-view").hidden = view !== "timetable";
  if (view === "map" && map)
    requestAnimationFrame(() => {
      map.invalidateSize();
      fitRoutes();
    });
  updateUrl();
}
function updateBasemap() {
  const id = resolveBasemap(
      basemapPreference,
      document.documentElement.dataset.theme,
    ),
    basemap = BASEMAPS[id];
  $("#map").dataset.basemap = id;
  $("#basemap-select").value = basemapPreference;
  $("#basemap-description").textContent = basemap.description;
  // Light and dark are styled street tiles; keep loaded tiles and map position.
  if (tileLayer?.options.sourceUrl === basemap.url) return;
  if (tileLayer) {
    // Leaflet's remove handlers detach map/zoom listeners and attribution.
    // Let them run before clearing this layer's remaining callbacks.
    map.removeLayer(tileLayer);
    tileLayer.off();
  }
  $("#tile-status").hidden = true;
  $("#tile-status").textContent =
    id === "satellite"
      ? "Satellite imagery unavailable. Choose another basemap or try again later. Route paths are still shown."
      : "Background map unavailable. Route paths are still shown.";
  let errors = 0,
    loaded = 0;
  tileLayer = L.tileLayer(basemap.url, {
    attribution: basemap.attribution,
    sourceUrl: basemap.url,
    maxNativeZoom: basemap.maxNativeZoom,
    maxZoom: 19,
    className: "map-tiles",
    keepBuffer: 1,
  });
  tileLayer.on("tileload", () => {
    loaded++;
    if (loaded > 2) $("#tile-status").hidden = true;
  });
  tileLayer.on("tileerror", () => {
    errors++;
    if (errors > 3 && loaded < 3) $("#tile-status").hidden = false;
  });
  tileLayer.addTo(map);
}
$("#basemap-select").addEventListener("change", (event) => {
  if (!map || !validBasemap(event.target.value)) return;
  basemapPreference = event.target.value;
  remember("ju-basemap", basemapPreference);
  const url = new URL(location.href);
  if (basemapPreference === "auto") url.searchParams.delete("basemap");
  else url.searchParams.set("basemap", basemapPreference);
  history.replaceState(null, "", url);
  updateBasemap();
});
function initMap() {
  if (!window.L) {
    $("#map-failure").hidden = false;
    $$(".map-toolbar button").forEach((b) => (b.disabled = true));
    $("#all-routes").disabled = true;
    $("#basemap-select").disabled = true;
    return;
  }
  map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: false,
    preferCanvas: true,
  }).setView([23.82, 90.335], 11);
  L.control.zoom({ position: "topright" }).addTo(map);
  updateBasemap();
  routeLayer = L.featureGroup().addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe($("#map"));
  drawRoutes();
}
function fitRoutes() {
  if (!map || !routes.length) return;
  const coords = showAll
    ? routes.flatMap((r) => r.coordinates)
    : selectedRoute().coordinates;
  map.fitBounds(L.latLngBounds(coords), {
    padding: [40, 45],
    maxZoom: 13,
    animate: false,
  });
}
function drawRoutes() {
  if (!map) return;
  routeLayer.clearLayers();
  if (showAll)
    routes
      .filter((r) => r.id !== selectedId)
      .forEach((r) => {
        L.polyline(r.coordinates, { color: r.color, weight: 3, opacity: 0.6 })
          .addTo(routeLayer)
          .bindTooltip(`Route ${r.id} · ${r.name}`)
          .on("click", () => selectRoute(r.id));
      });
  const route = selectedRoute();
  L.polyline(route.coordinates, {
    color: "#fff",
    weight: 8,
    opacity: 0.8,
    interactive: false,
  }).addTo(routeLayer);
  L.polyline(route.coordinates, { color: route.color, weight: 4.5, opacity: 1 })
    .addTo(routeLayer)
    .bindTooltip(`Route ${route.id} · ${route.name}`);
  const points = [
    { coords: route.coordinates[0], label: route.name, campus: false },
    { coords: route.coordinates.at(-1), label: "JU Campus", campus: true },
  ];
  points.forEach((point) => {
    const icon = L.divIcon({
      className: `endpoint ${point.campus ? "campus" : ""}`,
      html: "",
      iconSize: [15, 15],
      iconAnchor: [7, 7],
    });
    const marker = L.marker(point.coords, {
      icon,
      keyboard: true,
      title: `${point.label} — mapped route endpoint`,
    }).addTo(routeLayer);
    marker.getElement().style.setProperty("--route-color", route.color);
    marker.bindTooltip(point.label, {
      permanent: true,
      direction: point.campus ? "right" : "left",
      offset: point.campus ? [9, 0] : [-9, 0],
    });
    const content = document.createElement("p");
    content.textContent = `${point.label} · Route ${route.id} endpoint. Confirm the exact boarding point before travelling.`;
    marker.bindPopup(content);
  });
  fitRoutes();
}
function locateMe() {
  const status = $("#location-status"),
    button = $("#locate-me");
  status.hidden = false;
  if (!navigator.geolocation) {
    status.textContent =
      "This browser does not support location. You can still explore every route.";
    return;
  }
  status.textContent =
    "Finding your location… Allow access when your browser asks.";
  button.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      button.disabled = false;
      const { latitude, longitude, accuracy } = position.coords;
      if (![latitude, longitude, accuracy].every(Number.isFinite)) {
        status.textContent = "Location unavailable. Try again.";
        return;
      }
      if (positionLayer) map.removeLayer(positionLayer);
      if (accuracyLayer) map.removeLayer(accuracyLayer);
      accuracyLayer = L.circle([latitude, longitude], {
        radius: Math.max(accuracy, 0),
        color: "#2860a6",
        weight: 1,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
      positionLayer = L.circleMarker([latitude, longitude], {
        radius: 7,
        color: "#fff",
        weight: 3,
        fillColor: "#2860a6",
        fillOpacity: 1,
      })
        .addTo(map)
        .bindPopup("Your approximate location. Visible only in this browser.");
      map.setView([latitude, longitude], 14);
      status.textContent = `Your location is shown (accuracy about ${Math.round(accuracy)} m). Select “Fit selected route” to return to your route.`;
    },
    (error) => {
      button.disabled = false;
      status.textContent =
        error.code === 1
          ? "Location access was declined. You can allow it in your browser settings, or continue using the route map."
          : error.code === 3
            ? "Location took too long to respond. Please try again outdoors or with a stronger connection."
            : "Your location is currently unavailable. All routes and timetables still work.";
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
  );
}
$("#route-list").addEventListener("click", (event) => {
  const route = event.target.closest("[data-route]"),
    save = event.target.closest("[data-save]");
  if (route) selectRoute(route.dataset.route, true);
  if (save) {
    const id = save.dataset.save;
    const removing = saved.has(id);
    if (removing) saved.delete(id);
    else saved.add(id);
    remember("ju-saved-routes", [...saved]);
    renderRoutes();
    const replacement = $(`[data-save="${id}"]`);
    (replacement || $("#saved-filter")).focus();
    notify(
      removing
        ? "Route removed from saved routes."
        : "Route saved on this device.",
    );
  }
});
$("#route-search").addEventListener("input", renderRoutes);
$("#saved-filter").addEventListener("click", () => {
  savedOnly = !savedOnly;
  $("#saved-filter").setAttribute("aria-pressed", String(savedOnly));
  renderRoutes();
});
$("#clear-filters").addEventListener("click", () => {
  $("#route-search").value = "";
  savedOnly = false;
  $("#saved-filter").setAttribute("aria-pressed", "false");
  renderRoutes();
  $("#route-search").focus();
});
$$("[data-direction]").forEach((b) =>
  b.addEventListener("click", () => selectDirection(b.dataset.direction)),
);
$$("[data-view]").forEach((b, i, all) => {
  b.addEventListener("click", () => selectView(b.dataset.view));
  b.addEventListener("keydown", (event) => {
    let target;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft")
      target = all[(i + 1) % all.length];
    if (event.key === "Home") target = all[0];
    if (event.key === "End") target = all.at(-1);
    if (target) {
      event.preventDefault();
      selectView(target.dataset.view, true);
    }
  });
});
$("#all-routes").addEventListener("click", () => {
  showAll = !showAll;
  $("#all-routes").setAttribute("aria-pressed", String(showAll));
  $("#all-routes").textContent = showAll
    ? "Selected route only"
    : "Show all routes";
  renderDetails();
  drawRoutes();
});
$("#fit-route").addEventListener("click", fitRoutes);
$("#locate-me").addEventListener("click", locateMe);
$("#route-detail").addEventListener("click", (event) => {
  const button = event.target.closest("#share-route");
  if (button) {
    updateUrl();
    $("#share-url").value = location.href;
    $("#copy-status").textContent = "";
    openDialog("#share-dialog", button);
  }
});
$("#copy-share-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#share-url").value);
    $("#copy-status").textContent =
      "Link copied. You can paste it into a message.";
  } catch {
    $("#share-url").focus();
    $("#share-url").select();
    $("#copy-status").textContent =
      "Select and copy the link above with your browser’s copy command.";
  }
});
$("#timetable-body").addEventListener("click", (event) => {
  const b = event.target.closest("[data-table-route]");
  if (b) {
    selectRoute(b.dataset.tableRoute);
    selectView("map", true);
    if (innerWidth <= 680) $(".map-card").scrollIntoView();
  }
});
$("#download-csv").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([timetableCsv(routes)], { type: "text/csv;charset=utf-8;" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "JU_Transport_Reference_Timetable.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#print-table").addEventListener("click", () => window.print());
window.addEventListener("popstate", () => {
  if (!routes.length) return;
  parseUrl();
  selectDirection(direction);
  selectView(currentView);
});
async function getJson(url, timeout = 10000) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Service unavailable");
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
const WEATHER =
  "https://api.open-meteo.com/v1/forecast?latitude=23.8789&longitude=90.2679&current=temperature_2m,weather_code,wind_speed_10m&daily=precipitation_probability_max&wind_speed_unit=kmh&timezone=Asia%2FDhaka&forecast_days=1";
const AIR =
  "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=23.8789&longitude=90.2679&current=us_aqi&timezone=Asia%2FDhaka&forecast_days=1";
function showWeather(data) {
  const current = data?.current;
  if (
    !Number.isFinite(current?.temperature_2m) ||
    !Number.isFinite(current?.wind_speed_10m)
  )
    throw new Error("Weather response incomplete");
  $("#weather-temp").textContent = `${Math.round(current.temperature_2m)}°C`;
  $("#weather-wind").textContent = `${Math.round(current.wind_speed_10m)} km/h`;
  const rain = data.daily?.precipitation_probability_max?.[0];
  $("#weather-rain").textContent = Number.isFinite(rain)
    ? `${Math.round(rain)}%`
    : "—";
  $("#weather-condition").textContent = weatherDescription(
    current.weather_code,
  );
  const timestamp = current.time;
  $("#weather-updated").textContent =
    typeof timestamp === "string"
      ? `Weather: ${timestamp.slice(5, 10)} ${timestamp.slice(11, 16)} Dhaka`
      : "Weather updated";
}
async function fetchWeather(force = false) {
  if (weatherBusy || $("#app").hidden) return;
  weatherBusy = true;
  $("#refresh-weather").disabled = true;
  try {
    const cached = readStored("ju-weather-v1", null);
    if (
      !force &&
      cached &&
      Date.now() - cached.savedAt >= 0 &&
      Date.now() - cached.savedAt < 15 * 60 * 1000
    ) {
      try {
        showWeather(cached.weather);
        showAir(cached.air);
        return;
      } catch {}
    }
    const result = await Promise.allSettled([getJson(WEATHER), getJson(AIR)]);
    let weather, air;
    try {
      if (result[0].status !== "fulfilled") throw result[0].reason;
      showWeather(result[0].value);
      weather = result[0].value;
    } catch {
      ["#weather-temp", "#weather-wind", "#weather-rain"].forEach(
        (id) => ($(id).textContent = "—"),
      );
      $("#weather-condition").textContent = "Weather unavailable";
      $("#weather-updated").textContent = "Use Refresh data to retry";
    }
    try {
      if (result[1].status !== "fulfilled") throw result[1].reason;
      showAir(result[1].value);
      air = result[1].value;
    } catch {
      $("#weather-aqi").textContent = "—";
      $("#aqi-label").textContent = "Air quality unavailable";
    }
    if (weather && air)
      remember("ju-weather-v1", { weather, air, savedAt: Date.now() });
  } finally {
    weatherBusy = false;
    $("#refresh-weather").disabled = false;
  }
}
function showAir(data) {
  const aqi = data?.current?.us_aqi;
  if (!Number.isFinite(aqi) || aqi < 0)
    throw new Error("Air quality response incomplete");
  $("#weather-aqi").textContent = Math.round(aqi);
  $("#aqi-label").textContent = aqiDescription(aqi);
  $("#weather-aqi").title = data.current.time
    ? `Model estimate at ${data.current.time.replace("T", " ")} Dhaka time`
    : "Model estimate";
}
$("#refresh-weather").addEventListener("click", () => fetchWeather(true));
$("#reload-data").addEventListener("click", loadApp);
async function loadApp() {
  $("#data-error").hidden = true;
  $("#app-loading").hidden = false;
  try {
    const data = validateData(await getJson("data/routes.json"));
    routes = data.routes;
    parseUrl();
    renderRoutes();
    renderTable();
    renderDetails();
    $("#app").hidden = false;
    $("#app-loading").hidden = true;
    $$("[data-direction]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.direction === direction)),
    );
    initMap();
    selectView(currentView);
    initTracking({
      map,
      routes,
      getSelection: () => ({ route: selectedId, direction }),
      focusBus: (bus) => {
        selectDirection(bus.direction);
        selectRoute(bus.route_id);
        selectView("map");
        requestAnimationFrame(() => {
          map?.setView([bus.latitude, bus.longitude], 15);
          $(".map-card").scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        });
      },
      openDialog,
      closeDialog,
    })
      .then((result) => {
        tracker = result;
      })
      .catch(() => {
        $("#live-connection").textContent =
          "Live locations unavailable. Please reload to retry.";
      });
    fetchWeather();
  } catch {
    $("#app-loading").hidden = true;
    $("#data-error").hidden = false;
  }
}
loadApp();
if (
  "serviceWorker" in navigator &&
  ["https:", "http:"].includes(location.protocol)
)
  navigator.serviceWorker.register("sw.js").catch(() => {});
let deferredInstall;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  $("#install-app").hidden = false;
});
$("#install-app").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("#install-app").hidden = true;
});
