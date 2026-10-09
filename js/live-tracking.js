import {
  LIVE_LIMITS,
  BusSharer,
  normaliseFeed,
  visibleBuses,
  ageLabel,
} from "./tracking-core.js";
import { TrackingAPI, validateTrackingConfig } from "./tracking-api.js";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const busIcon = '<svg class="icon" aria-hidden="true"><use href="#bus"/></svg>';

export async function initTracking({
  map,
  routes,
  getSelection,
  focusBus,
  openDialog,
  closeDialog,
}) {
  let api,
    sharer,
    config,
    buses = [],
    receivedAt = 0,
    feedBusy = false,
    connection = "loading";
  let wakeLock,
    captchaToken = "",
    captchaWidget,
    captchaLoading = false;
  const markers = new Map(),
    layer = map && L.layerGroup().addTo(map);
  const routeName = (id) =>
    routes.find((r) => r.id === id)?.name || `Route ${id}`;
  const setConnection = (state, text) => {
    connection = state;
    if ($("#live-connection").textContent !== text)
      $("#live-connection").textContent = text;
    $("#live-connection").dataset.state = state;
  };
  const currentBuses = () =>
    visibleBuses(
      buses,
      performance.now() - receivedAt,
      $("#live-all-routes").checked ? {} : getSelection(),
    );
  function render() {
    const visible = connection === "ready" ? currentBuses() : [];
    $("#live-count").textContent = visible.length;
    const selection = getSelection();
    $("#live-empty").hidden = visible.length > 0;
    if (connection === "ready")
      $("#live-empty").textContent = $("#live-all-routes").checked
        ? "No buses are sharing right now. On board a bus? You can help by sharing its location."
        : `No shared locations for Route ${selection.route} ${selection.direction === "to-campus" ? "to" : "from"} campus. Try all routes, or share from your bus.`;
    else
      $("#live-empty").textContent =
        connection === "disabled"
          ? "The live-location service is not connected yet. Routes and timetables remain available."
          : connection === "loading"
            ? "Checking for buses sharing their location…"
            : "Live positions cannot be confirmed. Check your connection; updates will retry automatically.";
    // Preserve keyboard focus when a refresh updates the list.
    const focusedId = document.activeElement?.dataset?.liveBus;
    $("#live-bus-list").innerHTML = visible
      .map((b) => {
        const stale = b.ageMs > LIVE_LIMITS.freshMs;
        return `<li><button type="button" class="live-bus-row" data-live-bus="${b.id}" ${map ? "" : "disabled"} aria-label="Locate ${esc(b.bus_label)} on Route ${b.route_id}"><span class="live-bus-icon ${stale ? "stale" : ""}">${busIcon}</span><span class="live-bus-info"><strong>${esc(b.bus_label)}</strong><span>Route ${b.route_id} · ${esc(routeName(b.route_id))} · ${b.direction === "to-campus" ? "To campus" : "From campus"}</span><span class="live-source">${b.source === "authority" ? "Verified authority" : "Community · unverified"}</span></span><span class="live-bus-meta"><strong>${stale ? "Last seen" : "Updated"} ${ageLabel(b.ageMs)}</strong><span>GPS ±${Math.round(b.accuracy)} m</span><span class="live-locate">View on map ↗</span></span></button></li>`;
      })
      .join("");
    if (focusedId)
      $(`[data-live-bus="${focusedId}"]`)?.focus({ preventScroll: true });
    if (!map) return;
    const ids = new Set(visible.map((b) => b.id));
    for (const [id, marker] of markers)
      if (!ids.has(id)) {
        layer.removeLayer(marker);
        markers.delete(id);
      }
    visible.forEach((b) => {
      let marker = markers.get(b.id);
      if (!marker) {
        marker = L.marker([b.latitude, b.longitude], {
          icon: L.divIcon({
            className: "live-map-bus",
            html: busIcon,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
          }),
          title: `${b.bus_label} · live bus location`,
          zIndexOffset: 1000,
        }).addTo(layer);
        marker.bindPopup(document.createElement("div"));
        markers.set(b.id, marker);
      }
      marker.setLatLng([b.latitude, b.longitude]);
      marker
        .getElement()
        ?.classList.toggle("stale", b.ageMs > LIVE_LIMITS.freshMs);
      const content = document.createElement("div");
      content.className = "live-popup";
      content.innerHTML = `<strong>${esc(b.bus_label)}</strong><p>Route ${b.route_id} · ${esc(routeName(b.route_id))}<br>${b.direction === "to-campus" ? "To JU Campus" : "From JU Campus"}</p><p>${b.source === "authority" ? "Verified authority" : "Community report · unverified"}<br>${ageLabel(b.ageMs)} · GPS ±${Math.round(b.accuracy)} m</p>`;
      marker.setPopupContent(content);
    });
  }
  async function poll() {
    if (!api || feedBusy || document.hidden) return;
    if (!navigator.onLine) {
      buses = [];
      setConnection("offline", "Offline · live locations paused");
      render();
      return;
    }
    feedBusy = true;
    const requestedAt = performance.now();
    try {
      const feed = await api.feed();
      if (!navigator.onLine) return;
      // Count request transit time conservatively; a slow response must not
      // make an old location appear fresh on a student's device.
      const transitMs = performance.now() - requestedAt;
      buses = normaliseFeed(feed).map((bus) => ({
        ...bus,
        ageMs: bus.ageMs + transitMs,
      }));
      receivedAt = performance.now();
      setConnection("ready", "Live updates on · refreshes every 10 seconds");
    } catch {
      buses = [];
      setConnection("error", "Live connection unavailable · retrying");
    } finally {
      feedBusy = false;
      render();
    }
  }
  async function keepAwake() {
    if (!sharer?.active || document.hidden || wakeLock || !navigator.wakeLock)
      return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
      if (!sharer.active) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }
  function sharingState(state, message) {
    const busy = ["preparing", "waiting", "sharing", "stopping"].includes(
      state,
    );
    const running = ["preparing", "waiting", "sharing"].includes(state);
    $("#tracking-fields").disabled = busy || !api;
    $("#start-sharing").hidden = running || state === "stopping";
    $("#start-sharing").disabled = !api || busy;
    $("#stop-sharing").hidden = !running;
    $("#sharing-strip").hidden = !running;
    document.body.classList.toggle("is-sharing", running);
    if ($("#sharing-status").textContent !== message)
      $("#sharing-status").textContent = message;
    $("#sharing-status").dataset.state = state;
    $("#sharing-strip-status").textContent = message;
    if (sharer?.active) void keepAwake();
    else if (wakeLock) {
      void wakeLock.release();
      wakeLock = null;
    }
  }
  async function loadCaptcha() {
    if (
      !config?.turnstileSiteKey ||
      captchaLoading ||
      captchaWidget !== undefined
    )
      return;
    captchaLoading = true;
    $("#tracking-captcha").hidden = false;
    try {
      if (!window.turnstile)
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src =
            "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          script.onload = resolve;
          script.onerror = reject;
          document.head.append(script);
        });
      captchaWidget = window.turnstile.render("#tracking-captcha-widget", {
        sitekey: config.turnstileSiteKey,
        callback: (token) => {
          captchaToken = token;
        },
        "expired-callback": () => {
          captchaToken = "";
        },
        theme: "auto",
      });
    } catch {
      $("#sharing-status").textContent =
        "The verification check could not load. Check your connection and reopen this panel.";
    } finally {
      captchaLoading = false;
    }
  }
  function resetCaptcha() {
    captchaToken = "";
    if (captchaWidget !== undefined) window.turnstile?.reset(captchaWidget);
  }
  function open(trigger) {
    if (!sharer?.active && !sharer?.starting) {
      $("#tracking-route").value = getSelection().route;
      $("#tracking-direction").value = getSelection().direction;
    }
    openDialog("#tracking-dialog", trigger);
    void loadCaptcha();
  }
  $("#tracking-route").innerHTML = routes
    .map(
      (r) => `<option value="${r.id}">Route ${r.id} · ${esc(r.name)}</option>`,
    )
    .join("");
  $("#open-tracking").addEventListener("click", (e) => open(e.currentTarget));
  $("#manage-sharing").addEventListener("click", (e) => open(e.currentTarget));
  $("#close-tracking").addEventListener("click", () =>
    closeDialog("#tracking-dialog"),
  );
  $("#live-all-routes").addEventListener("change", render);
  $("#live-bus-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-live-bus]");
    const bus =
      button && currentBuses().find((b) => b.id === button.dataset.liveBus);
    if (bus && map) {
      focusBus(bus);
      requestAnimationFrame(() => markers.get(bus.id)?.openPopup());
    }
  });
  $("#tracking-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!sharer) return;
    if (!navigator.onLine) {
      sharingState(
        "error",
        "An internet connection is needed to share your location.",
      );
      return;
    }
    if (config.turnstileSiteKey && !captchaToken && !api.session) {
      sharingState("error", "Complete the verification check below first.");
      return;
    }
    const label =
      $("#tracking-label").value.trim() ||
      `Route ${$("#tracking-route").value} bus`;
    if (/[\x00-\x1f\x7f]/.test(label)) {
      sharingState("error", "Enter a bus number or short label.");
      return;
    }
    await sharer.start(
      {
        label,
        route: $("#tracking-route").value,
        direction: $("#tracking-direction").value,
      },
      captchaToken,
    );
    resetCaptcha();
  });
  for (const id of ["#stop-sharing", "#quick-stop-sharing"])
    $(id).addEventListener("click", () => {
      $("#tracking-consent").checked = false;
      void sharer?.stop();
    });
  sharingState("idle", "Location sharing is off.");
  let configurationError = false;
  try {
    const response = await fetch("data/tracking-config.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Tracking configuration unavailable");
    config = validateTrackingConfig(await response.json());
    if (config) api = new TrackingAPI(config);
  } catch {
    config = null;
    configurationError = true;
  }
  if (!api) {
    setConnection("disabled", "Live tracking is being connected");
    $("#tracking-unavailable").hidden = false;
    render();
    if (configurationError) {
      setConnection("error", "Live service unavailable · reload to retry");
      const message =
        "Connect to the internet and reload this page to retry live tracking. Routes and timetables remain available.";
      $("#live-empty").textContent = message;
      $("#tracking-unavailable").textContent = message;
    }
    return { refresh: render };
  }
  sharer = new BusSharer({
    api,
    geolocation: navigator.geolocation,
    onState: sharingState,
    onPublish: poll,
  });
  sharingState("idle", "Location sharing is off.");
  void poll();
  setInterval(poll, LIVE_LIMITS.pollMs);
  setInterval(render, 5000);
  window.addEventListener("offline", () => {
    buses = [];
    setConnection("offline", "Offline · live locations paused");
    render();
  });
  window.addEventListener("online", poll);
  window.addEventListener("pagehide", () => sharer.leave());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void poll();
      void keepAwake();
    }
  });
  return { refresh: render };
}
