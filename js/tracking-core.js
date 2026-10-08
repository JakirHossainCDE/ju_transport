export const LIVE_LIMITS = Object.freeze({
  pollMs: 10000,
  publishMs: 12000,
  freshMs: 45000,
  expireMs: 120000,
  fixMaxAgeMs: 20000,
  accuracyM: 200,
  sessionMs: 4 * 60 * 60 * 1000,
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function inServiceArea(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 23.4 &&
    lat <= 24.2 &&
    lng >= 90.05 &&
    lng <= 90.7
  );
}
export function checkPosition(position, now = Date.now()) {
  const c = position?.coords;
  if (!c || !inServiceArea(c.latitude, c.longitude))
    return "Location is outside the Dhaka–Savar service area. Start sharing when you are on the bus.";
  if (
    !Number.isFinite(c.accuracy) ||
    c.accuracy < 0 ||
    c.accuracy > LIVE_LIMITS.accuracyM
  )
    return "GPS accuracy is too low. Move near a window or outdoors; waiting for a clearer location.";
  const age = now - position.timestamp;
  if (!Number.isFinite(age) || age < -1000 || age > LIVE_LIMITS.fixMaxAgeMs)
    return "Waiting for a fresh GPS location. Keep this page open.";
  return null;
}
export function normaliseFeed(payload) {
  const serverTime = Date.parse(payload?.server_time);
  if (!Number.isFinite(serverTime) || !Array.isArray(payload.buses))
    throw new Error("Invalid location feed");
  const seen = new Set();
  return payload.buses.flatMap((b) => {
    const ageMs = serverTime - Date.parse(b.fix_at);
    if (
      !uuid.test(b.id) ||
      seen.has(b.id) ||
      !/^[1-7]$/.test(b.route_id) ||
      !["to-campus", "from-campus"].includes(b.direction) ||
      !["community", "authority"].includes(b.source) ||
      typeof b.bus_label !== "string" ||
      b.bus_label.length < 1 ||
      b.bus_label.length > 64 ||
      !inServiceArea(b.latitude, b.longitude) ||
      !Number.isFinite(b.accuracy) ||
      b.accuracy < 0 ||
      b.accuracy > LIVE_LIMITS.accuracyM ||
      !Number.isFinite(ageMs) ||
      ageMs < -1000 ||
      ageMs >= LIVE_LIMITS.expireMs
    )
      return [];
    seen.add(b.id);
    return [{ ...b, ageMs: Math.max(0, ageMs) }];
  });
}
export function visibleBuses(buses, elapsedMs = 0, filter = {}) {
  return buses
    .map((b) => ({ ...b, ageMs: b.ageMs + Math.max(0, elapsedMs) }))
    .filter(
      (b) =>
        b.ageMs < LIVE_LIMITS.expireMs &&
        (!filter.route || b.route_id === filter.route) &&
        (!filter.direction || b.direction === filter.direction),
    );
}
export function ageLabel(ageMs) {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  return seconds < 5 ? "just now" : `${seconds}s ago`;
}

// Owns GPS independently of the dialog. Closing a dialog never silently enables GPS.
export class BusSharer {
  constructor({
    api,
    geolocation,
    onState = () => {},
    onPublish = () => {},
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    Object.assign(this, {
      api,
      geolocation,
      onState,
      onPublish,
      now,
      setIntervalFn,
      clearIntervalFn,
    });
    this.setIntervalFn = setIntervalFn.bind(globalThis);
    this.clearIntervalFn = clearIntervalFn.bind(globalThis);
    this.generation = 0;
    this.active = false;
    this.starting = false;
    this.watchId = null;
  }
  async start(trip, captchaToken) {
    if (this.active || this.starting || this.stopping) return;
    if (!this.geolocation) {
      this.onState("error", "This browser cannot share GPS location.");
      return;
    }
    this.starting = true;
    const generation = ++this.generation,
      sessionId = crypto.randomUUID();
    this.onState("preparing", "Connecting your sharing session…");
    try {
      await this.api.ensureSession(captchaToken);
      if (generation !== this.generation) return;
      await this.api.start(sessionId, trip);
      if (generation !== this.generation) {
        await this.api.stop(sessionId).catch(() => {});
        return;
      }
      this.sessionId = sessionId;
      this.active = true;
      this.startedAt = this.now();
      this.latest = null;
      this.lastAttempt = -Infinity;
      this.lastFixSent = -Infinity;
      this.lastPublished = 0;
      this.onState(
        "waiting",
        "Allow location access. Waiting for an accurate GPS fix…",
      );
      this.watchId = this.geolocation.watchPosition(
        (position) => {
          if (generation !== this.generation || !this.active) return;
          const error = checkPosition(position, this.now());
          if (error) {
            this.onState("waiting", error);
            return;
          }
          this.latest = position;
          this.tick();
        },
        (error) => {
          if (generation !== this.generation || !this.active) return;
          if (error.code === 1) {
            void this.stop(
              "Location permission was declined. Allow it in your browser settings, then start again.",
            );
          } else
            this.onState(
              "waiting",
              "GPS is unavailable. Keep this page open near a window; retrying…",
            );
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
      this.timer = this.setIntervalFn(() => this.tick(), 1000);
    } catch (error) {
      if (generation === this.generation) {
        if (this.sessionId) await this.stop(error.message);
        else
          this.onState(
            "error",
            error.message || "Could not start sharing. Please try again.",
          );
      }
    } finally {
      this.starting = false;
    }
  }
  tick() {
    if (!this.active) return;
    if (this.now() - this.startedAt >= LIVE_LIMITS.sessionMs) {
      void this.stop(
        "Your four-hour sharing session ended. Start again if you are still on the bus.",
      );
      return;
    }
    if (
      this.lastPublished &&
      this.now() - this.lastPublished > LIVE_LIMITS.freshMs
    )
      this.onState(
        "waiting",
        "Updates are paused. Check GPS and internet; old locations will disappear automatically.",
      );
    const p = this.latest;
    if (
      !p ||
      this.pending ||
      p.timestamp <= this.lastFixSent ||
      checkPosition(p, this.now()) ||
      this.now() - this.lastAttempt < LIVE_LIMITS.publishMs
    )
      return;
    const generation = this.generation,
      sessionId = this.sessionId;
    this.lastAttempt = this.now();
    this.pending = this.api
      .publish(sessionId, p, Math.max(0, Math.round(this.now() - p.timestamp)))
      .then((result) => {
        if (generation !== this.generation) return;
        if (result.accepted) {
          this.lastFixSent = p.timestamp;
          this.lastPublished = this.now();
          this.onState(
            "sharing",
            `Sharing with students · GPS accuracy ±${Math.round(p.coords.accuracy)} m.`,
          );
          this.onPublish();
        }
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        if (error.fatal) {
          void this.stop(error.message);
          return;
        }
        this.onState(
          "waiting",
          "Upload paused. Check your internet connection; retrying while this page is open.",
        );
      })
      .finally(() => {
        this.pending = null;
      });
  }
  async stop(
    message = "Sharing stopped. Your phone is no longer sending its location.",
  ) {
    if (this.stopping) return;
    this.stopping = true;
    ++this.generation;
    this.active = false;
    if (this.watchId !== null) this.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.latest = null;
    this.clearIntervalFn(this.timer);
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.onState("stopping", "Stopping GPS sharing…");
    let removed = true;
    if (sessionId) {
      // Ordered cleanup also covers a GPS request already in flight.
      await this.pending?.catch(() => {});
      try {
        await this.api.stop(sessionId);
      } catch {
        removed = false;
      }
    }
    this.stopping = false;
    this.onState(
      "idle",
      removed
        ? message
        : `${message} The last public point may remain for up to two minutes because the connection is unavailable.`,
    );
    this.onPublish();
  }
  leave() {
    const sessionId = this.sessionId;
    ++this.generation;
    this.active = false;
    this.sessionId = null;
    if (this.watchId !== null) this.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.clearIntervalFn(this.timer);
    if (sessionId) this.api.stopOnLeave(sessionId);
    this.onState(
      "idle",
      "Sharing stopped when you left this page. Start again to share another journey.",
    );
  }
}
