// Pulls your runs from Strava and merges them into data/runs.json.
// No dependencies: needs Node 18+ (built-in fetch).
//
// v2 (for the RunAudio run drawer): also stores km splits, cadence, calories and heart-rate zones,
// and, ONLY if you set INCLUDE_ROUTES=true, a privacy-trimmed route.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { webcrypto as wc } from "node:crypto";

const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret, STRAVA_REFRESH_TOKEN: refresh,
        GH_PAT, GITHUB_REPOSITORY, INCLUDE_NAMES, INCLUDE_ROUTES, ROUTE_KEY } = process.env;
const API = process.env.STRAVA_API || "https://www.strava.com";   // overridable for tests
const OUT = process.env.OUT_FILE || "data/runs.json";
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
const MAX_DETAIL = Number(process.env.MAX_DETAIL || 40);          // detail fetches per sync (Strava allows 100 requests / 15 min)
// Metres cut from both ends of every saved route. Default 400 for plain routes; 0 when ROUTE_KEY encrypts them.
const TRIM_M = Number(process.env.ROUTE_TRIM_M ?? (ROUTE_KEY ? 0 : 400));

// --- Optional encryption (AES-256-GCM, key from the ROUTE_KEY passphrase via PBKDF2). The app decrypts on your phone. ---
const te = new TextEncoder();
let aesKey = null;
async function seal(text) {
  if (!aesKey) {
    const base = await wc.subtle.importKey("raw", te.encode(ROUTE_KEY), "PBKDF2", false, ["deriveKey"]);
    aesKey = await wc.subtle.deriveKey({ name: "PBKDF2", salt: te.encode("runaudio-route-v1"), iterations: 200000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  }
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, te.encode(text)));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return Buffer.from(all).toString("base64");
}

if (!id || !secret || !refresh) { console.error("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN."); process.exit(1); }

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { const e = new Error(`${r.status} ${url.split("?")[0]}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e; }
  return r.json();
}

// --- Google encoded polyline, so a route can be trimmed and saved compactly ---
function decode(s) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const axis of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
function encode(pts) {
  let out = "", pl = 0, pg = 0;
  for (const [la, ln] of pts) {
    for (const v of [Math.round(la * 1e5) - pl, Math.round(ln * 1e5) - pg]) {
      let n = v < 0 ? ~(v << 1) : v << 1;
      while (n >= 32) { out += String.fromCharCode((32 | (n & 31)) + 63); n >>= 5; }
      out += String.fromCharCode(n + 63);
    }
    pl = Math.round(la * 1e5); pg = Math.round(ln * 1e5);
  }
  return out;
}
const hav = (a, b) => { const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dg = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dg / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
// Cuts TRIM_M metres off both ends so your home / usual start point isn't published. Too-short routes are dropped.
function trimRoute(poly) {
  const pts = decode(poly); if (pts.length < 2) return null;
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1]; if (total < TRIM_M * 2 + 300) return null;
  const kept = pts.filter((_, i) => cum[i] >= TRIM_M && cum[i] <= total - TRIM_M);
  return kept.length > 1 ? encode(kept) : null;
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
const auth = { headers: { Authorization: `Bearer ${tok.access_token}` } };

// 2. Load what we already have, and only ask Strava for what's newer (minus a 14 day overlap to catch edits).
let store = { updated: null, runs: [] };
try { store = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const byId = new Map(store.runs.map(r => [r.id, r]));
const newest = store.runs.reduce((m, r) => Math.max(m, Date.parse(r.date) / 1000), 0);
const after = newest && process.env.FULL_SYNC !== "true" ? Math.floor(newest - 14 * 86400) : 0; // 0 = whole history

// 3. Page through activities.
let fetched = 0;
for (let page = 1; ; page++) {
  const list = await j(`${API}/api/v3/athlete/activities?per_page=200&page=${page}&after=${after}`, auth);
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
    byId.set(run.id, { ...(byId.get(run.id) || {}), ...run });   // keep splits / route already fetched for this run
  }
  if (list.length < 200) break;
}

// 4. Fetch details (km splits, cadence, calories, zones, optionally the route) for runs that don't have them yet, newest first.
const wantRoute = INCLUDE_ROUTES === "true";
if (ROUTE_KEY) for (const r of byId.values()) if (r.polyline) { r.route_enc = await seal(r.polyline); delete r.polyline; }  // encrypt any plain routes saved earlier
const todo = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date))
  .filter(r => !r.splits || (wantRoute && r.route_done !== true)).slice(0, MAX_DETAIL);
let zonesOk = true, detailed = 0;
for (const r of todo) {
  try {
    const d = await j(`${API}/api/v3/activities/${r.id}`, auth);
    r.splits = (d.splits_metric || []).map(s => ({ distance_m: Math.round(s.distance), moving_s: s.moving_time,
      avg_hr: s.average_heartrate ? Math.round(s.average_heartrate) : null, elevation_difference: Math.round((s.elevation_difference || 0) * 10) / 10 }));
    if (d.average_cadence) r.avg_cadence = Math.round(d.average_cadence * 2);   // Strava reports one foot; steps/min is double
    if (d.calories) r.calories = Math.round(d.calories);
    if (wantRoute) {
      const p = d.map && (d.map.summary_polyline || d.map.polyline);
      const t = p ? trimRoute(p) : null;
      if (t) { if (ROUTE_KEY) r.route_enc = await seal(t); else r.polyline = t; }
      r.route_done = true;
    }
    if (zonesOk && r.avg_hr) {
      try {
        const z = await j(`${API}/api/v3/activities/${r.id}/zones`, auth);
        const hr = (z || []).find(x => x.type === "heartrate");
        if (hr && hr.distribution_buckets) r.hr_zones = hr.distribution_buckets.map(b => b.time || 0);
      } catch (e) { if (e.status === 402 || e.status === 403) zonesOk = false; else if (e.status === 429) throw e; }
    }
    detailed++;
  } catch (e) {
    if (e.status === 429) { console.error("::warning::Strava rate limit hit; the rest will be filled in on the next sync."); break; }
    console.error(`::warning::No detail for run ${r.id}: ${e.message}`);
  }
}

const runs = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
// Only touch the file if the runs changed, so quiet days make no commit.
const same = JSON.stringify(runs) === JSON.stringify(store.runs);
if (!same) {
  await mkdir(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), runs }, null, 1) + "\n");
}
console.log(`Checked ${fetched} activities, ${runs.length} runs total, ${detailed} detailed${same ? " (no changes)" : " (updated)"}.`);
