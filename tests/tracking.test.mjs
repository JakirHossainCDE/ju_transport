import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BusSharer,
  checkPosition,
  normaliseFeed,
  visibleBuses,
  LIVE_LIMITS,
} from "../js/tracking-core.js";
import { validateTrackingConfig, TrackingAPI } from "../js/tracking-api.js";
const point = (now = 100000, accuracy = 10) => ({
  timestamp: now,
  coords: { latitude: 23.85, longitude: 90.3, accuracy },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(overrides = {}) {
  let now = 100000,
    success,
    failure,
    cleared = 0,
    tick;
  const calls = [],
    states = [];
  const api = {
    ensureSession: async () => {},
    start: async () => {},
    publish: async (id, p) => {
      calls.push(p);
      return { accepted: true };
    },
    stop: async () => {},
    stopOnLeave: () => {},
    ...overrides,
  };
  const sharer = new BusSharer({
    api,
    now: () => now,
    onState: (...s) => states.push(s),
    geolocation: {
      watchPosition: (s, f) => {
        success = s;
        failure = f;
        return 0;
      },
      clearWatch: () => cleared++,
    },
    setIntervalFn: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalFn: () => {},
  });
  return {
    api,
    sharer,
    calls,
    states,
    send: (p) => success(p),
    fail: (e) => failure(e),
    advance: (ms) => {
      now += ms;
      tick?.();
    },
    get cleared() {
      return cleared;
    },
  };
}
test("GPS must be recent, precise and inside the Dhaka–Savar service area", () => {
  assert.equal(checkPosition(point(), 100000), null);
  assert.match(checkPosition(point(1), 100000), /fresh GPS/);
  assert.match(checkPosition(point(100000, 500), 100000), /accuracy/);
  assert.match(
    checkPosition(
      { ...point(), coords: { latitude: 0, longitude: 0, accuracy: 1 } },
      100000,
    ),
    /outside/,
  );
});
test("Feed uses server time despite student clock skew; stale and malformed entries are discarded", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const b = {
    id: "11111111-1111-4111-8111-111111111111",
    route_id: "1",
    direction: "to-campus",
    source: "community",
    bus_label: "Bus",
    latitude: 23.85,
    longitude: 90.3,
    accuracy: 10,
    fix_at: new Date(now - 30000).toISOString(),
  };
  const rows = normaliseFeed({
    server_time: new Date(now).toISOString(),
    buses: [b, { ...b, id: "bad" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ageMs, 30000);
  assert.equal(visibleBuses(rows, 91000).length, 0);
  assert.equal(visibleBuses(rows, 0, { route: "2" }).length, 0);
  assert.equal(
    normaliseFeed({
      server_time: new Date(now).toISOString(),
      buses: [{ ...b, fix_at: new Date(now + 10000).toISOString() }],
    }).length,
    0,
  );
});
test("GPS does not start until explicit Start; Stop cancels watch ID zero and ignores late callbacks", async () => {
  const h = harness();
  assert.equal(h.sharer.active, false);
  await h.sharer.start({});
  h.send(point());
  await flush();
  assert.equal(h.calls.length, 1);
  await h.sharer.stop();
  assert.equal(h.cleared, 1);
  h.send(point(120000));
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sharer.active, false);
});
test("Repeated old fixes do not create false fresh locations; new fixes are throttled", async () => {
  const h = harness();
  await h.sharer.start({});
  h.send(point());
  await flush();
  h.advance(13000);
  h.send(point());
  await flush();
  assert.equal(h.calls.length, 1);
  h.send(point(113000));
  await flush();
  assert.equal(h.calls.length, 2);
  await h.sharer.stop();
});
test("Cancel while Start is pending cleans up without ever starting GPS", async () => {
  let resolveStart,
    stopped = 0;
  const h = harness({
    start: () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    stop: async () => stopped++,
  });
  const pending = h.sharer.start({});
  await flush();
  await h.sharer.stop();
  resolveStart();
  await pending;
  assert.equal(h.sharer.active, false);
  assert.equal(stopped, 1);
  assert.equal(h.calls.length, 0);
});
test("Stop waits for an in-flight upload, then removes the location", async () => {
  let resolvePublish;
  const order = [];
  const h = harness({
    publish: () =>
      new Promise((resolve) => {
        resolvePublish = () => {
          order.push("publish");
          resolve({ accepted: true });
        };
      }),
    stop: async () => order.push("stop"),
  });
  await h.sharer.start({});
  h.send(point());
  const stopped = h.sharer.stop();
  assert.equal(h.sharer.active, false);
  resolvePublish();
  await stopped;
  assert.deepEqual(order, ["publish", "stop"]);
  assert.equal(h.states.at(-1)[0], "idle");
});
test("Permission denied and the four-hour session limit both stop GPS", async () => {
  const h = harness();
  await h.sharer.start({});
  h.fail({ code: 1 });
  await flush();
  assert.equal(h.sharer.active, false);
  assert.match(h.states.at(-1)[1], /declined/);
  const other = harness();
  await other.sharer.start({});
  other.advance(LIVE_LIMITS.sessionMs);
  await flush();
  assert.equal(other.sharer.active, false);
  assert.match(other.states.at(-1)[1], /four-hour/);
});
test("A failed Stop never keeps GPS running and explains public expiry", async () => {
  const h = harness({
    stop: async () => {
      throw new Error("offline");
    },
  });
  await h.sharer.start({});
  await h.sharer.stop();
  assert.equal(h.sharer.active, false);
  assert.equal(h.cleared, 1);
  assert.match(h.states.at(-1)[1], /two minutes/);
});
test("Configuration refuses secret keys and non-Supabase destinations", () => {
  const config = {
    enabled: true,
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
  };
  assert.equal(validateTrackingConfig(config).supabaseUrl, config.supabaseUrl);
  assert.equal(validateTrackingConfig({ enabled: false }), null);
  assert.throws(() =>
    validateTrackingConfig({ ...config, publishableKey: "sb_secret_secret" }),
  );
  assert.throws(() =>
    validateTrackingConfig({ ...config, supabaseUrl: "https://other.example" }),
  );
  const jwt = "eyJ." + btoa(JSON.stringify({ role: "service_role" })) + ".fake";
  assert.throws(() =>
    validateTrackingConfig({ ...config, publishableKey: jwt }),
  );
});
test("Public feed uses only the public API key; credentials are sent only to auth", async () => {
  const requests = [];
  const api = new TrackingAPI(
    {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    },
    async (url, options) => {
      requests.push({ url, ...options });
      return {
        ok: true,
        json: async () => ({ server_time: "2026-10-08", buses: [] }),
      };
    },
  );
  await api.feed();
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].cache, "no-store");
});

test("Guest sharing creates a session automatically without email or password", async () => {
  const calls = [];
  const api = new TrackingAPI(
    {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    },
    async (url, options) => {
      calls.push({ url, ...options });
      return {
        ok: true,
        json: async () => ({
          access_token: "guest-token",
          refresh_token: "guest-refresh",
          expires_in: 3600,
        }),
      };
    },
  );
  await api.ensureSession();
  await api.ensureSession();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/auth\/v1\/signup$/);
  assert.deepEqual(JSON.parse(calls[0].body), {});
  assert.equal(api.session.accessToken, "guest-token");
  assert.equal(api.login, undefined);
});

test("Disabled guest sharing explains owner setup without requesting a sign-in", async () => {
  const api = new TrackingAPI(
    {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    },
    async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error_code: "anonymous_provider_disabled" }),
    }),
  );
  await assert.rejects(api.ensureSession(), /You do not need an account/);
});

test("Start replaces an expired guest session without credentials, but never retries a network failure as a signup", async () => {
  const paths = [];
  let refreshStatus = 503;
  const api = new TrackingAPI(
    {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    },
    async (url, options) => {
      paths.push(new URL(url).pathname);
      if (url.includes("grant_type=refresh_token"))
        return {
          ok: false,
          status: refreshStatus,
          json: async () => ({}),
        };
      assert.deepEqual(JSON.parse(options.body), {});
      return {
        ok: true,
        json: async () => ({
          access_token: "new-guest",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      };
    },
  );
  api.session = { accessToken: "old", refreshToken: "old", expiresAt: 0 };
  await assert.rejects(api.ensureSession());
  assert.equal(api.session.accessToken, "old");
  assert.deepEqual(paths, ["/auth/v1/token"]);
  refreshStatus = 400;
  await api.ensureSession();
  assert.equal(api.session.accessToken, "new-guest");
  assert.deepEqual(paths, [
    "/auth/v1/token",
    "/auth/v1/token",
    "/auth/v1/signup",
  ]);
});

test("An invalid guest token stops sharing and the next Start can create a fresh session", async () => {
  const paths = [];
  const api = new TrackingAPI(
    {
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "sb_publishable_test",
    },
    async (url) => {
      paths.push(new URL(url).pathname);
      const signup = url.endsWith("/signup");
      return {
        ok: signup,
        status: signup ? 200 : 401,
        json: async () =>
          signup
            ? {
                access_token: "new-guest",
                refresh_token: "new-refresh",
                expires_in: 3600,
              }
            : {},
      };
    },
  );
  api.saveSession({ access_token: "rejected", refresh_token: "old" });
  await assert.rejects(api.start("test", {}), (error) => error.fatal === true);
  assert.equal(api.session, null);
  assert.deepEqual(paths, ["/rest/v1/rpc/ju_start_share"]);
  await api.ensureSession();
  assert.equal(api.session.accessToken, "new-guest");
});
