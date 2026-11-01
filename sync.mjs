// Pulls your runs from Strava and merges them into data/runs.json.
// No dependencies: needs Node 18+ (built-in fetch).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret, STRAVA_REFRESH_TOKEN: refresh,
        GH_PAT, GITHUB_REPOSITORY, INCLUDE_NAMES } = process.env;
const API = process.env.STRAVA_API || "https://www.strava.com";   // overridable for tests
const OUT = process.env.OUT_FILE || "data/runs.json";
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

if (!id || !secret || !refresh) { console.error("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN."); process.exit(1); }

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// 1. Swap the refresh token for a short-lived access token.
const tok = await j(`${API}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: refresh }),
});

// Strava can rotate the refresh token; the old one then stops working, so save the new one.
if (tok.refresh_token && tok.refresh_token !== refresh) {
  if (GH_PAT && GITHUB_REPOSITORY) {
    try {
      execFileSync("gh", ["secret", "set", "STRAVA_REFRESH_TOKEN", "--repo", GITHUB_REPOSITORY], {
        input: tok.refresh_token, env: { ...process.env, GH_TOKEN: GH_PAT }, stdio: ["pipe", "inherit", "inherit"] });
      console.log("Saved Strava's new refresh token to the repo secret.");
    } catch (e) { console.error("::warning::Could not save the new refresh token:", e.message); }
  } else {
    console.error("::warning::Strava issued a new refresh token but GH_PAT is not set, so it was NOT saved. Add the GH_PAT secret (see README) or the next sync may fail.");
  }
}

// 2. Load what we already have, and only ask Strava for what's newer (minus a 14 day overlap to catch edits).
let store = { updated: null, runs: [] };
try { store = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const byId = new Map(store.runs.map(r => [r.id, r]));
const newest = store.runs.reduce((m, r) => Math.max(m, Date.parse(r.date) / 1000), 0);
const after = newest && process.env.FULL_SYNC !== "true" ? Math.floor(newest - 14 * 86400) : 0; // 0 = whole history

// 3. Page through activities.
let fetched = 0;
for (let page = 1; ; page++) {
  const list = await j(`${API}/api/v3/athlete/activities?per_page=200&page=${page}&after=${after}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  for (const a of list) {
    fetched++;
    if (!RUN_TYPES.has(a.sport_type || a.type)) continue;
    const run = {
      id: a.id,
      date: a.start_date_local,                 // local wall-clock time, e.g. 2026-11-01T08:12:00Z
      distance_m: Math.round(a.distance),
      moving_s: a.moving_time,
      elapsed_s: a.elapsed_time,
      elevation_m: Math.round(a.total_elevation_gain || 0),
      avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
      type: a.sport_type || a.type,
    };
    // Names often mention places, and this file may be public, so they're off unless you opt in.
    if (INCLUDE_NAMES === "true") run.name = a.name;
    // Deliberately NOT saved: GPS routes, start/end coordinates, gear, photos.
    byId.set(run.id, run);
  }
  if (list.length < 200) break;
}

const runs = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
// Only touch the file if the runs changed, so quiet days make no commit.
const same = JSON.stringify(runs) === JSON.stringify(store.runs);
if (!same) {
  await mkdir(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), runs }, null, 1) + "\n");
}
console.log(`Checked ${fetched} activities, ${runs.length} runs total${same ? " (no changes)" : " (updated)"}.`);
