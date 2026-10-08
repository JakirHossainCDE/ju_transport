// Two independent browsers exercise the real SQL migration through a local REST
// test adapter. Test GPS and identities never reach a production database.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PGlite } from "@electric-sql/pglite";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const db = new PGlite(),
  authority = "00000000-0000-4000-8000-000000000001";
await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 insert into auth.users values ('${authority}');`);
await db.exec(
  await readFile(
    path.join(root, "supabase/migrations/20261008192000_live_bus_tracking.sql"),
    "utf8",
  ),
);
await db.query("insert into ju_private.authorities(user_id) values ($1)", [
  authority,
]);
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ttf": "font/ttf",
};
const server = createServer(async (req, res) => {
  try {
    let name = new URL(req.url, "http://localhost").pathname.replace(
      /^\/ju_transport\//,
      "/",
    );
    if (name.endsWith("/")) name += "index.html";
    const file = path.resolve(root, "." + name);
    if (!file.startsWith(root + path.sep)) throw Error();
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "text/plain",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/ju_transport/`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const report = { checks: [], violations: [], errors: [] };
let authCount = 0,
  feedFails = false;
const sqlNames = {
  ju_live_buses: [],
  ju_share_identity: [],
  ju_start_share: ["p_session_id", "p_route_id", "p_direction", "p_bus_label"],
  ju_publish_location: [
    "p_session_id",
    "p_latitude",
    "p_longitude",
    "p_accuracy",
    "p_age_ms",
  ],
  ju_stop_share: ["p_session_id"],
};
async function prepare(context) {
  await context.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await context.route("https://*open-meteo.com/**", (r) => r.abort());
  await context.route("**/data/tracking-config.json", (r) =>
    r.fulfill({
      json: {
        enabled: true,
        supabaseUrl: "https://qa.supabase.co",
        publishableKey: "sb_publishable_testing",
        turnstileSiteKey: "",
      },
    }),
  );
  await context.route("https://qa.supabase.co/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      body = req.postDataJSON() || {};
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "apikey,authorization,content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    };
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    try {
      if (url.pathname.startsWith("/auth/")) {
        if (url.pathname.endsWith("/logout")) {
          await route.fulfill({ json: {} });
          return;
        }
        let user = authority;
        if (url.pathname.endsWith("/signup")) {
          user = crypto.randomUUID();
          authCount++;
          await db.query("insert into auth.users values ($1)", [user]);
        } else if (body.password !== "qa-only-password") {
          await route.fulfill({ status: 400, json: {} });
          return;
        }
        await route.fulfill({
          json: { access_token: user, refresh_token: user, expires_in: 3600 },
        });
        return;
      }
      const fn = url.pathname.split("/").at(-1),
        params = sqlNames[fn];
      if (!params) throw Error("Unknown RPC");
      if (fn === "ju_live_buses" && feedFails) {
        await route.fulfill({ status: 503, json: {} });
        return;
      }
      const user = req.headers().authorization?.replace("Bearer ", "");
      const result = await db.transaction(async (tx) => {
        await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
          user || "",
        ]);
        await tx.exec(`set local role ${user ? "authenticated" : "anon"}`);
        return (
          await tx.query(
            `select public.${fn}(${params.map((_, i) => "$" + (i + 1)).join(",")}) as result`,
            params.map((p) => body[p]),
          )
        ).rows[0].result;
      });
      await route.fulfill({ json: result, headers: cors });
    } catch (error) {
      await route.fulfill({
        status: 400,
        json: { code: error.code, message: error.message },
      });
    }
  });
}
async function pageFor(context) {
  const p = await context.newPage();
  p.on("pageerror", (e) => report.errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("supabase"))
      console.log(m.text());
  });
  await p.goto(base);
  await p
    .waitForSelector('#live-connection[data-state="ready"]', { timeout: 6000 })
    .catch(async (e) => {
      console.log(
        await p.evaluate(() => ({
          body: document.body.innerText,
          visibility: document.visibilityState,
        })),
      );
      throw e;
    });
  return p;
}
const waitBus = (p) => p.waitForSelector(".live-bus-row", { timeout: 16000 });
try {
  const sender = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
    geolocation: { latitude: 23.851, longitude: 90.31, accuracy: 10 },
    serviceWorkers: "block",
  });
  const viewer = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await prepare(sender);
  await prepare(viewer);
  const driver = await pageFor(sender),
    student = await pageFor(viewer);
  assert.equal(authCount, 0);
  assert.equal(await student.locator(".live-bus-row").count(), 0);
  await driver.locator("#open-tracking").click();
  await driver.locator("#tracking-label").fill("QA Bus 12");
  await driver.locator("#tracking-consent").check();
  await driver.locator("#start-sharing").click();
  await driver.waitForSelector('#sharing-status[data-state="sharing"]', {
    timeout: 15000,
  });
  await waitBus(student);
  assert.equal(authCount, 1);
  assert.match(
    await student.locator(".live-bus-row").textContent(),
    /Community · unverified/,
  );
  assert.equal(await student.locator(".live-map-bus").count(), 1);
  report.checks.push(
    "A consenting passenger publishes GPS; an independent student sees a bus without signing in",
  );
  await student.locator(".live-bus-row").click();
  await student.waitForSelector(".live-popup");
  assert.match(await student.locator(".live-popup").textContent(), /QA Bus 12/);
  await sender.setGeolocation({
    latitude: 23.86,
    longitude: 90.32,
    accuracy: 8,
  });
  await student.waitForFunction(
    () =>
      document.querySelector(".live-bus-row")?.textContent.includes("GPS ±8 m"),
    null,
    { timeout: 28000 },
  );
  assert.equal(
    (await db.query("select latitude from ju_private.bus_shares")).rows[0]
      .latitude,
    23.86,
  );
  report.checks.push("Later GPS fixes update the shared marker and accuracy");
  await student.locator('[data-direction="from-campus"]').click();
  assert.equal(await student.locator(".live-bus-row").count(), 0);
  await student.locator("#live-all-routes").check();
  assert.equal(await student.locator(".live-bus-row").count(), 1);
  report.checks.push("Route/direction filtering and all-buses view");
  for (const theme of ["light", "dark"]) {
    await student.locator(`button[data-theme="${theme}"]`).click();
    await student.addScriptTag({
      path: path.join(root, "node_modules/axe-core/axe.min.js"),
    });
    const audit = await student.evaluate(() =>
      axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      }),
    );
    report.violations.push(
      ...audit.violations.map((v) => ({
        theme,
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    );
    await student.screenshot({
      path: path.join(output, `live-${theme}.png`),
      fullPage: true,
    });
  }
  await driver.screenshot({
    path: path.join(output, "sharing-mobile.png"),
    fullPage: true,
  });
  await driver.addScriptTag({
    path: path.join(root, "node_modules/axe-core/axe.min.js"),
  });
  const dialogAudit = await driver.evaluate(() =>
    axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }),
  );
  report.violations.push(
    ...dialogAudit.violations.map((v) => ({
      view: "sharing-dialog",
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  );
  for (const width of [320, 390, 768, 1440]) {
    await driver.setViewportSize({ width, height: 900 });
    assert.equal(
      await driver.evaluate(() => document.documentElement.scrollWidth),
      width,
    );
    assert.equal(
      await driver
        .locator("#tracking-dialog")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
  }
  report.checks.push(
    "Day/Night live list and mobile sharing dialog: responsive layout and accessibility audit",
  );
  await driver.locator("#close-tracking").click();
  assert.equal(await driver.locator("#sharing-strip").isVisible(), true);
  await driver.locator("#table-tab").click();
  assert.equal(await driver.locator("#quick-stop-sharing").isVisible(), true);
  await driver.locator("#quick-stop-sharing").click();
  await student.waitForFunction(
    () => !document.querySelector(".live-bus-row"),
    null,
    { timeout: 16000 },
  );
  assert.equal(
    (await db.query("select count(*)::int as n from ju_private.bus_shares"))
      .rows[0].n,
    0,
  );
  report.checks.push(
    "Stop is available outside the dialog and removes the location for a second student session",
  );
  await driver.locator("#map-tab").click();
  await driver.locator("#open-tracking").click();
  await driver.locator("#authority-details summary").click();
  await driver.locator("#authority-email").fill("qa@example.test");
  await driver.locator("#authority-password").fill("qa-only-password");
  await driver.locator("#authority-login").click();
  await driver.waitForFunction(
    () =>
      document.querySelector("#sharing-identity").textContent ===
      "Verified authority account",
  );
  assert.equal(await driver.locator("#sharing-strip").isVisible(), false);
  await driver.locator("#tracking-consent").check();
  await driver.locator("#start-sharing").click();
  // Emit a new GPS measurement for the second trip. Browser emulation otherwise
  // retains the timestamp from the first trip, which the app correctly rejects.
  await sender.setGeolocation({
    latitude: 23.8601,
    longitude: 90.3201,
    accuracy: 8,
  });
  await driver.waitForSelector('#sharing-status[data-state="sharing"]');
  await waitBus(student);
  assert.match(
    await student.locator(".live-bus-row").textContent(),
    /Verified authority/,
  );
  report.checks.push(
    "Only the server-approved account receives the authority badge; sign-in alone does not start GPS",
  );
  feedFails = true;
  await student.waitForSelector('#live-connection[data-state="error"]', {
    timeout: 16000,
  });
  assert.equal(await student.locator(".live-map-bus").count(), 0);
  feedFails = false;
  await waitBus(student);
  report.checks.push(
    "Failed location reads hide unconfirmed markers and reconnect automatically",
  );
  await db.exec(
    "update ju_private.bus_shares set fix_at=now()-interval '3 minutes'",
  );
  await student.waitForFunction(
    () => !document.querySelector(".live-bus-row"),
    null,
    { timeout: 16000 },
  );
  report.checks.push(
    "A lost GPS signal expires on the server and disappears from the student view",
  );
  await driver.locator("#stop-sharing").click();
  await driver.waitForSelector('#sharing-status[data-state="idle"]');
  await driver.locator("#authority-signout").click();
  await driver.reload();
  await driver.waitForSelector('#live-connection[data-state="ready"]');
  assert.equal(await driver.locator("#sharing-strip").isVisible(), false);
  report.checks.push(
    "Reload does not restart location sharing or retain authority credentials",
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.violations, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(
    path.join(output, "tracking-browser-results.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await db.close();
  server.close();
}
