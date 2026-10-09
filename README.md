# JU Transport

A responsive route and timetable guide for Jahangirnagar University, built by **Md. Jakir Hossain**.

**Use the app:** https://jakirhossaincde.github.io/ju_transport/

## What works

- Seven interactive route maps with the original geographic paths preserved.
- Search by route number, English name, Bengali name or spelling alias.
- Directions to and from campus, complete departure lists and mapped route lengths.
- Saved routes stored on the current device, shareable route links and all-routes overview.
- Accessible Day/Night themes, keyboard controls and responsive mobile layouts.
- Optional, one-time private display of your own location, separate from explicit public bus sharing.
- Full timetable, CSV download, printing and a [no-JavaScript timetable](https://jakirhossaincde.github.io/ju_transport/timetable.html).
- Campus weather and modelled US AQI from Open-Meteo/CAMS, with timestamps, error states and retry controls.
- Offline access to routes and timetables after a successful first visit. Basemap tiles and refreshed weather still need a network connection.

## Data status: read before using for a journey

The 7 route paths and all 21 departure times are preserved from repository commit `86fc363d0ab0d07be64af6dc2bc7b4f0831cd452` (December 9, 2025). The spelling “Khilghet” is normalised to “Khilkhet” and retained as a search alias. No stops, operational ETAs or service days have been invented.

**This is a reference timetable, not a verified current operating schedule.** Days of operation, holiday exceptions, exact boarding points and current route changes must be confirmed with the [JU Transport Office](https://www.juniv.edu/office/transport-office) and its [official timetable](https://www.juniv.edu/office/transport-office/program/bus-schedule). The official student PDF linked by that page at review appeared to be a historical schedule; it was not silently substituted for the project’s data.

Map polylines are indicative. Both directions use the original geometry; actual return roads may differ. Mapped distances are geometric lengths, not journey-time estimates.

## Live bus location sharing

The new live-tracking feature includes GPS sharing for any student or bus driver without a sign-in form, student bus markers, source labels, GPS accuracy, update age, route/direction filtering and a persistent Stop button. Both Day and Night modes are supported.

**Backend activation is pending:** `data/tracking-config.json` is deliberately disabled until a Supabase project is created and verified. The website shows an honest connection notice and never shows demonstration buses as live transport.

See [the live-tracking guide](docs/LIVE_TRACKING.md) for passenger/student instructions, backend activation, privacy, data retention and testing. GitHub Pages hosts the frontend; authenticated Supabase database functions share current positions across devices. No private account information is included in the student feed.

## Local development

No build step or dependency installation is required to serve the app. Serve this folder over HTTP:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Direct `file://` opening cannot load the JSON data or ES modules reliably.

## Project structure

| File                   | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `index.html`           | Main application and accessible dialogs                         |
| `css/style.css`        | Layout, themes, responsive and print styles                     |
| `js/main.js`           | Map, interactions, local preferences and environmental requests |
| `js/core.js`           | Time formatting, data validation, searching and CSV helpers     |
| `js/theme.js`          | Apply the theme before first paint                              |
| `data/routes.json`     | The single editable route/time dataset, with provenance         |
| `timetable.html`       | Static timetable fallback for JavaScript-disabled browsers      |
| `vendor/leaflet/`      | Locally bundled Leaflet 1.9.4 and its licence                   |
| `sw.js`                | Same-origin app cache; never caches third-party tiles           |
| `manifest.webmanifest` | Installation metadata for supported browsers                    |
| `tests/`               | Regression checks for transport data and core behaviours        |

## Tests

Run `npm ci` followed by `npm test` for route, GPS-lifecycle and PostgreSQL authorization tests. For the two-browser sharing test, run `npx playwright install chromium`, then `npm run test:browser`. Development dependencies are not downloaded by site visitors.

## Updating routes and departures

1. Obtain an authoritative transport-office notice and confirm the operating days.
2. Edit `data/routes.json`: use 24-hour `HH:mm` times and `[latitude, longitude]` coordinate pairs. Preserve unique string route IDs.
3. Update source metadata. Do not mark the schedule as verified without an actual notice and a service calendar; update the UI's reference wording only when verification is complete.
4. Run `node scripts/generate-timetable.mjs` to synchronise the no-JavaScript timetable, then `node --test tests/core.test.mjs`.
5. Increment the cache version in `sw.js` when publishing app or data changes, so offline users receive the new assets.
6. Check both directions, map extent and all departure times in a browser.

## Links and themes

A route can be opened directly with `?route=7&direction=from-campus`. Add `&view=timetable` for the full schedule or `&theme=night` / `&theme=day` for an explicit theme. Theme and saved routes persist locally; no account is required.

## External services and attribution

- Noto Sans Bengali is bundled locally for reliable Bengali text rendering, under the SIL Open Font License in `vendor/fonts/OFL.txt`.
- [Leaflet 1.9.4](https://leafletjs.com/), BSD-2-Clause; licence retained under `vendor/leaflet/LICENSE`.
- [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles and contributors, visibly credited on the map. Uses the standard HTTPS endpoint and browser caching, without tile prefetching or offline tile downloads. The Night theme applies a CSS filter to the same tiles. Follow the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and use a suitable hosted provider if traffic grows.
- [Open-Meteo weather API](https://open-meteo.com/en/docs): temperature in °C, 10 m wind speed in km/h and today's maximum precipitation probability.
- [Open-Meteo air-quality API](https://open-meteo.com/en/docs/air-quality-api) / CAMS: modelled US AQI for the campus area, not an on-site sensor. Weather results are cached locally for 15 minutes when both services succeed. These are public APIs subject to provider availability and terms; review those terms before a commercial or high-volume deployment.

## Deploying

The existing GitHub Pages site uses **main → / (root)**. Commit the files to that source branch; there is no build step. Keep `.nojekyll`, relative paths and the Google site-verification file. HTTPS is needed for geolocation, clipboard, installation and service workers (localhost is an exception).

For a release, verify route/direction selection, favourites, English/Bengali search, route links, CSV and print, no-data/no-network states, location-denied handling, both themes and 320–1440 px layouts. A successful software release does not certify the underlying timetable.
