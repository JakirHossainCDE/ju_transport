# Live bus location sharing

The frontend is connected to the dedicated Supabase Free-plan project `ju-transport` in **Singapore** (`ap-southeast-1`, project reference `ltzfvxqizpefwshimtpu`). The database functions and per-minute expired-location cleanup are installed. Only the public project URL and publishable key are included in `data/tracking-config.json`.

**One owner setting remains:** open [Authentication → Sign In / Providers](https://supabase.com/dashboard/project/ltzfvxqizpefwshimtpu/auth/providers), enable **Allow anonymous sign-ins**, and save. The connected management tools cannot change this Auth setting. Until it is enabled, viewing the feed works, but Start sharing explains that guest sharing needs owner activation. No redeployment is needed after changing the setting.

The website never shows simulated buses as live transport. An empty feed means nobody is currently sharing a recent location.

## Passenger or bus operator

1. Open the site on a phone **on board the bus** and select **Share bus location**.
2. Choose the route and direction. The bus number/label is optional; leaving it blank uses a neutral label such as “Route 1 bus”. Do not enter personal details.
3. Read and tick the public-location consent, then select **Start sharing live location** and allow location access.
4. Keep the page open and the phone awake with an internet connection. Supported browsers request a screen wake lock, but battery settings, locking the phone or changing apps may still suspend GPS. This is browser tracking, not a guaranteed background fleet tracker.
5. Select **Stop sharing** before leaving the bus. This control is also visible outside the sharing dialog, including on the timetable view.

**Students and drivers use the same no-sign-in form. No email, password, registration or authority approval is required.** A temporary guest session is created automatically after Start is tapped, using Supabase anonymous Auth behind the scenes. This protects each person’s updates without asking them to sign in. Session tokens stay in memory; reloading never resumes GPS sharing automatically.

## Students

Open **Route explorer** to see bus icons and the **Live bus locations** list. The selected route and direction filter both. Select **All routes & directions** to see other shared buses; select a bus row to centre it on the map. Students do not need accounts or location permission.

Each bus shows its source, latest GPS update age and accuracy. Community positions are unverified reports; multiple passengers may report the same bus. There are no inferred arrivals/ETAs.

Updates upload at most once every 12 seconds and student views refresh every 10 seconds while visible. This is polling, not a continuous video-like feed. Network delay and GPS availability affect how soon a position appears. At 45 seconds without a new fix it is labelled **Last seen**; at 120 seconds it disappears. A failed read clears unconfirmed markers until reconnection. No live data is cached for offline viewing.

## Re-create the backend for another deployment

1. Select the intended Supabase organization, review the project cost, and create a project named `ju-transport`. This deployment uses the **Free plan and Singapore**, as selected by the owner. Supabase's server location is separate from the Dhaka–Savar map and service area.
2. Apply the SQL files in `supabase/migrations/` in filename order to the new project's database as its owner. The first creates the `ju_private` schema and five `ju_*` public RPC wrappers; the second enables Cron and schedules expired-location cleanup. Keep `ju_private` **out of the Data API's exposed schemas**. Do not re-run the initial schema migration on the already configured project.
3. Enable **anonymous sign-ins** in Supabase Authentication. This is a one-time site-owner setting; students and drivers do not sign into Supabase. Set the site's URL to `https://jakirhossaincde.github.io/ju_transport/`.
4. For public anonymous sharing, configure Cloudflare Turnstile in Supabase Auth and add its **public site key** below. Keep the CAPTCHA secret in Supabase's Auth settings. The browser supports a verification check for guest sharing without an account. Retain Supabase Auth's signup rate limits and monitor usage.
5. Copy the project's URL and **publishable** key into `data/tracking-config.json`:

   ```json
   {
     "enabled": true,
     "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
     "publishableKey": "sb_publishable_YOUR_PUBLIC_KEY",
     "turnstileSiteKey": "YOUR_PUBLIC_TURNSTILE_SITE_KEY"
   }
   ```

   If CAPTCHA is not enabled in Supabase, leave `turnstileSiteKey` empty. Do not enable server-side CAPTCHA without configuring the browser's matching site key. **Never put a service-role key, secret key, database password or Supabase access token in this repository.** The public key is deliberately browser-visible; database authorization protects writes.

6. Confirm the Cron job below is active, then run the security/performance advisors. Private tables have RLS enabled and deliberately have no public row policies: all access goes through the restricted functions. The [RLS-enabled/no-policy informational notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) is expected for these closed tables. A new project may also report an [unused index](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) before receiving traffic.
7. Commit the config to `main`, wait for GitHub Pages to deploy, and reload the website. Verify one real phone publishing and a second device viewing, then Stop. Check network errors and denied location permission too. Never leave test coordinates in production.

### Data retention

The app stores **one point per current sharer**, never a journey trail. Stop deletes it. Read-time expiry always hides an old point even when the phone closes unexpectedly. Schedule physical cleanup of abandoned sessions in Supabase Cron as the project owner:

```sql
select cron.schedule(
  'ju-expired-bus-shares',
  '* * * * *',
  $$delete from ju_private.bus_shares
    where coalesce(fix_at, started_at) < now() - interval '2 minutes'
       or started_at < now() - interval '4 hours';$$
);
```

The cleanup migration already installs this job for the Singapore project. A phone paused for more than two minutes will need to start a new session after cleanup. Supabase database backups and Auth records follow the project's retention settings. Anonymous Auth accounts are not automatically deleted by this app; monitor and maintain them in a dedicated project. Do not indiscriminately delete users from a project shared with other applications.

## Access model

| Operation                    | Access                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| Read recent bus locations    | Anyone, using the public read RPC; no owner IDs or account details returned |
| Start/update/stop sharing    | Authenticated contributor; only their own session                           |
| Read/write underlying tables | Denied to browser roles; RLS and table grants stay closed                   |

Public wrappers use `SECURITY INVOKER`. Their private implementations set an empty search path and check `auth.uid()` for every mutation. The public read function intentionally permits anonymous reads of only the current public fields. Route, direction, label, coordinates, accuracy and GPS age are validated on the server. Fix timestamps are generated from the server clock. A session lasts at most four hours. Updates are throttled on both sides. A stopped session cannot be recreated by a delayed update; a newer session cannot be changed by an older device's token.

The service area is bounded to latitude 23.4–24.2 and longitude 90.05–90.7. GPS accuracy must be 200 m or better, and fixes must be no older than 20 seconds. These checks cannot prove that a contributor is physically on a bus or defeat GPS spoofing. The source label makes that limit explicit.

## Testing

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Database tests run the actual migration in PGlite/PostgreSQL, including unauthorized writes, authority approval, expiry, throttling and delayed-write races. Browser tests use two separate browser contexts with a local REST test adapter backed by that same migration. They test drivers and students sharing without credentials, optional bus labels, moving GPS, filters, Stop, loss of connection, expiry, reload behaviour, responsive layouts and accessibility. They never send test locations to production. Results/screenshots go to ignored `test-results/`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing compatible Chromium binary.

Local tests do not substitute for checking the deployed Supabase Auth configuration, API grants, CAPTCHA, rate limits and a real mobile browser before operational use.

## Service references

- [Supabase anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase database functions and permissions](https://supabase.com/docs/guides/database/functions)
- [Public and secret API keys](https://supabase.com/docs/guides/api/api-keys)
- [CAPTCHA configuration](https://supabase.com/docs/guides/auth/auth-captcha)
- [Supabase Cron](https://supabase.com/docs/guides/cron)

For larger audiences, monitor polling/database usage and hosting quotas before adding more frequent updates. GitHub Pages continues to host the frontend; Supabase supplies the shared data and authentication.
