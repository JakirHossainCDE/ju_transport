import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatTime, validateData } from "../js/core.js";
const root = new URL("../", import.meta.url);
const { routes } = validateData(
  JSON.parse(await readFile(new URL("data/routes.json", root), "utf8")),
);
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const rows = routes
  .map(
    (r) =>
      `<tr><td>${r.id}</td><td><strong>${esc(r.name)}</strong><small lang="bn">${esc(r.nameBn)}</small></td><td>${r.toCampus.map(formatTime).join(" · ")}</td><td>${r.fromCampus.map(formatTime).join(" · ")}</td></tr>`,
  )
  .join("\n");
const file = new URL("timetable.html", root);
const source = await readFile(file, "utf8");
await writeFile(
  file,
  source.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${rows}</tbody>`),
);
console.log(`Updated ${fileURLToPath(file)} from data/routes.json`);
