export function validateTrackingConfig(config) {
  if (config?.enabled !== true) return null;
  const url = new URL(config.supabaseUrl);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Invalid tracking service configuration.");
  const key = config.publishableKey;
  let safe =
    typeof key === "string" && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (typeof key === "string" && key.startsWith("eyJ")) {
    try {
      safe =
        JSON.parse(
          atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        ).role === "anon";
    } catch {}
  }
  if (!safe)
    throw new Error(
      "Tracking needs a public API key. Never use a secret or service-role key.",
    );
  return { ...config, supabaseUrl: url.origin };
}

// Small REST adapter: no build step, CDN SDK, public write table or stored passwords.
// Auth tokens live only in memory and are refreshed during an active browser session.
export class TrackingAPI {
  constructor(config, fetchFn = fetch) {
    this.config = config;
    // Native browser fetch requires its Window receiver; calling it as an
    // unbound class property can throw "Illegal invocation" before networking.
    this.fetch = fetchFn.bind(globalThis);
    this.session = null;
    this.refreshing = null;
  }
  async request(path, body = {}, { token, keepalive = false } = {}) {
    const headers = {
      "Content-Type": "application/json",
      apikey: this.config.publishableKey,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.fetch(this.config.supabaseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        response.status === 429
          ? "Too many attempts. Please wait a few minutes and try again."
          : data?.code === "P0002"
            ? "This sharing session ended or was replaced on another device. Start again."
            : path.includes("/auth/")
              ? "Sign-in failed. Check your details, verification check, or contact the project owner."
              : response.status === 401
                ? "Your session expired. Sign in or start sharing again."
                : "The live-location service could not complete this request. Please try again.",
      );
      error.fatal =
        response.status === 401 ||
        response.status === 403 ||
        data?.code === "P0002";
      throw error;
    }
    return data;
  }
  saveSession(data) {
    if (!data?.access_token || !data?.refresh_token)
      throw new Error("Sign-in did not return a session.");
    this.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
  }
  async token() {
    if (!this.session) throw new Error("Start sharing or sign in first.");
    if (this.session.expiresAt - Date.now() < 90000) {
      if (!this.refreshing)
        this.refreshing = this.request(
          "/auth/v1/token?grant_type=refresh_token",
          { refresh_token: this.session.refreshToken },
        )
          .then((data) => this.saveSession(data))
          .finally(() => {
            this.refreshing = null;
          });
      await this.refreshing;
    }
    return this.session.accessToken;
  }
  async ensureSession(captchaToken) {
    if (this.session) {
      await this.token();
      return;
    }
    this.saveSession(
      await this.request(
        "/auth/v1/signup",
        captchaToken
          ? { gotrue_meta_security: { captcha_token: captchaToken } }
          : {},
      ),
    );
  }
  async login(email, password, captchaToken) {
    const body = { email, password };
    if (captchaToken)
      body.gotrue_meta_security = { captcha_token: captchaToken };
    this.saveSession(
      await this.request("/auth/v1/token?grant_type=password", body),
    );
    return this.rpc("ju_share_identity", {});
  }
  async logout() {
    const token = this.session?.accessToken;
    this.session = null;
    if (token)
      await this.request("/auth/v1/logout?scope=local", {}, { token }).catch(
        () => {},
      );
  }
  async rpc(name, body) {
    return this.request(`/rest/v1/rpc/${name}`, body, {
      token: await this.token(),
    });
  }
  feed() {
    return this.request("/rest/v1/rpc/ju_live_buses");
  }
  start(sessionId, trip) {
    return this.rpc("ju_start_share", {
      p_session_id: sessionId,
      p_route_id: trip.route,
      p_direction: trip.direction,
      p_bus_label: trip.label,
    });
  }
  publish(sessionId, position, ageMs) {
    return this.rpc("ju_publish_location", {
      p_session_id: sessionId,
      p_latitude: position.coords.latitude,
      p_longitude: position.coords.longitude,
      p_accuracy: position.coords.accuracy,
      p_age_ms: ageMs,
    });
  }
  stop(sessionId) {
    return this.rpc("ju_stop_share", { p_session_id: sessionId });
  }
  stopOnLeave(sessionId) {
    if (this.session)
      this.request(
        "/rest/v1/rpc/ju_stop_share",
        { p_session_id: sessionId },
        { token: this.session.accessToken, keepalive: true },
      ).catch(() => {});
  }
}
