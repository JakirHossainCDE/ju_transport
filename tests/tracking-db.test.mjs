import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const alice = "00000000-0000-4000-8000-000000000001",
  bob = "00000000-0000-4000-8000-000000000002";
const session = "11111111-1111-4111-8111-111111111111",
  next = "22222222-2222-4222-8222-222222222222";
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    insert into auth.users values ('${alice}'),('${bob}');`);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/20261008192000_live_bus_tracking.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
after(() => db.close());
beforeEach(() =>
  db.exec("truncate ju_private.bus_shares, ju_private.authorities;"),
);
async function asUser(user, sql, params = []) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    user || "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}
const start = (user = alice, id = session) =>
  asUser(user, "select public.ju_start_share($1,$2,$3,$4)", [
    id,
    "1",
    "to-campus",
    "JU Bus 12",
  ]);
const publish = (
  user = alice,
  id = session,
  lat = 23.85,
  lng = 90.3,
  accuracy = 12,
  age = 100,
) =>
  asUser(user, "select public.ju_publish_location($1,$2,$3,$4,$5) as result", [
    id,
    lat,
    lng,
    accuracy,
    age,
  ]);
const feed = async () =>
  (await asUser(null, "select public.ju_live_buses() as result"))[0].result;

test("Public students can read, but cannot start or access private identities/locations", async () => {
  assert.deepEqual((await feed()).buses, []);
  await assert.rejects(start(null), /permission denied/);
  await assert.rejects(
    asUser(null, "select * from ju_private.bus_shares"),
    /permission denied/,
  );
  await assert.rejects(
    asUser(alice, "insert into ju_private.authorities values ($1,now())", [
      alice,
    ]),
    /permission denied/,
  );
  await db.exec(
    "set role authenticated; select set_config('request.jwt.claim.sub','',false);",
  );
  try {
    await assert.rejects(
      db.query("select public.ju_start_share($1,$2,$3,$4)", [
        session,
        "1",
        "to-campus",
        "Bus",
      ]),
      /Sign in required/,
    );
  } finally {
    await db.exec("reset role");
  }
});
test("Sharing publishes only the latest point and no private user fields", async () => {
  await start();
  await publish();
  const data = await feed();
  assert.equal(data.buses.length, 1);
  assert.equal(data.buses[0].bus_label, "JU Bus 12");
  assert.equal(data.buses[0].source, "community");
  assert.ok(!JSON.stringify(data).includes(alice));
  assert.deepEqual(
    Object.keys(data.buses[0]).sort(),
    [
      "id",
      "route_id",
      "direction",
      "bus_label",
      "latitude",
      "longitude",
      "accuracy",
      "fix_at",
      "source",
    ].sort(),
  );
});
test("Another sharer cannot overwrite or stop an existing bus", async () => {
  await start();
  await publish();
  await assert.rejects(publish(bob), /Sharing session ended/);
  await asUser(bob, "select public.ju_stop_share($1)", [session]);
  assert.equal((await feed()).buses.length, 1);
});
test("Authority badge is derived from the private approval table and revokes immediately", async () => {
  await start();
  await publish();
  assert.equal(
    (await asUser(alice, "select public.ju_share_identity() as kind"))[0].kind,
    "community",
  );
  await db.query("insert into ju_private.authorities(user_id) values ($1)", [
    alice,
  ]);
  assert.equal((await feed()).buses[0].source, "authority");
  await db.exec("delete from ju_private.authorities");
  assert.equal((await feed()).buses[0].source, "community");
});
test("Stop prevents delayed updates from recreating a bus", async () => {
  await start();
  await publish();
  await asUser(alice, "select public.ju_stop_share($1)", [session]);
  await assert.rejects(publish(), /Sharing session ended/);
  assert.deepEqual((await feed()).buses, []);
});
test("An old device cannot change or delete a replacement sharing session", async () => {
  await start();
  await publish();
  await start(alice, next);
  await publish(alice, next);
  await asUser(alice, "select public.ju_stop_share($1)", [session]);
  await assert.rejects(publish(), /Sharing session ended/);
  assert.equal((await feed()).buses[0].id, next);
});
test("Server rejects out-of-area, invalid, inaccurate and old GPS data", async () => {
  await start();
  for (const args of [
    [0, 90.3, 12, 0],
    [23.8, 0, 12, 0],
    [NaN, 90.3, 12, 0],
    [23.8, 90.3, 201, 0],
    [23.8, 90.3, -1, 0],
    [23.8, 90.3, 12, 21000],
    [23.8, 90.3, 12, -1],
    [null, 90.3, 12, 0],
  ])
    await assert.rejects(
      publish(alice, session, ...args),
      /Invalid or old GPS fix/,
    );
});
test("Only valid routes, directions and nonempty public labels may start a session", async () => {
  for (const values of [
    ["99", "to-campus", "Bus"],
    ["1", "wrong", "Bus"],
    ["1", "to-campus", "  "],
    ["1", "to-campus", "x".repeat(33)],
    ["1", "to-campus", "Bus\nFake"],
  ])
    await assert.rejects(
      asUser(alice, "select public.ju_start_share($1,$2,$3,$4)", [
        session,
        ...values,
      ]),
      /check constraint/,
    );
});
test("Publishing is throttled and expiry uses server timestamps", async () => {
  await start();
  await publish();
  const duplicate = await publish(alice, session, 23.86);
  assert.equal(duplicate[0].result.accepted, false);
  assert.equal((await feed()).buses[0].latitude, 23.85);
  await db.exec(
    "update ju_private.bus_shares set fix_at=now()-interval '121 seconds'",
  );
  assert.deepEqual((await feed()).buses, []);
  await db.exec(
    "update ju_private.bus_shares set started_at=now()-interval '5 hours',fix_at=now()",
  );
  assert.deepEqual((await feed()).buses, []);
  await assert.rejects(publish(), /Sharing session ended/);
});
