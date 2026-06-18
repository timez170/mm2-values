#!/usr/bin/env node
/**
 * update-values.mjs — MM2 value auto-updater
 * ------------------------------------------------------------------------------------------------
 * Scrapes Supreme Values (server-rendered, the authoritative source), reconciles the FULL table
 * for each tier against the current values.json, and writes an updated values.json + CHANGELOG.md
 * ONLY when something actually changed. Designed to be robust and low-maintenance:
 *
 *   • Per-tier fetch with timeout + retries. One tier failing never aborts the others.
 *   • Multi-strategy parsing (embedded JSON first, then a labeled-text regex).
 *   • FAIL-SAFE validation: if a tier yields too few items or values look wrong, that tier is
 *     skipped and its previous data is kept — a parser break degrades gracefully, never corrupts.
 *   • MM2Values values, aliases, ranges and placeholder flags are carried over from the existing
 *     values.json (Supreme is authoritative for value/demand/rarity/trend; MM2 is a manual cross-check).
 *   • Full diff written to CHANGELOG.md; exit code + git status drive the optional commit step.
 *
 * Usage:
 *   node update-values.mjs              # scrape, reconcile, write values.json if changed
 *   node update-values.mjs --dry        # do everything except write (prints the diff)
 *   node update-values.mjs --verbose    # log per-tier extraction details
 *
 * NOTE ON PARSING: I authored extractItems() against Supreme's observed layout, but you should run
 * `node update-values.mjs --dry --verbose` once and confirm the per-tier item counts look right.
 * If a tier reports far fewer items than expected, tune ITEM_RE / the JSON probe in extractItems()
 * — the validation below will refuse to write bad data until you do, so nothing breaks in the meantime.
 * ------------------------------------------------------------------------------------------------
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL(".", import.meta.url).pathname;
const VALUES_PATH = ROOT + "values.json";
const CHANGELOG_PATH = ROOT + "CHANGELOG.md";

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry");
const VERBOSE = ARGS.has("--verbose");

/* ----- config ----- */
const BASE = "https://supremevalues.com/mm2/";
const TIERS = [               // page slug -> app category label
  ["godlies", "Godly"], ["chromas", "Chroma"], ["ancients", "Ancient"],
  ["legendaries", "Legendary"], ["pets", "Pet"], ["sets", "Set"],
  ["uniques", "Unique"], ["vintages", "Vintage"],
  ["rares", "Rare"], ["uncommons", "Uncommon"], ["commons", "Common"],
];
// minimum plausible item counts per category — below this we treat the scrape as failed for that tier
const MIN_ITEMS = { Godly: 60, Chroma: 25, Ancient: 8, Legendary: 3, Pet: 6, Set: 30, Unique: 1, Vintage: 6, Rare: 2, Uncommon: 1, Common: 1 };
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRIES = 3;
const UA = "Mozilla/5.0 (compatible; LifenzMM2ValueBot/1.0; +https://github.com/)";
const TREND_OK = new Set(["Stable","Rising","Doing Well","Improving","Overpaid For","Underpaid For","Decreasing","Fluctuating","Untradable","Receding"]);

/* ----- logging ----- */
const ts = () => new Date().toISOString().replace("T"," ").replace("Z","");
const log  = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);
const err  = (...a) => console.error(`[${ts()}] ERROR`, ...a);
const vlog = (...a) => { if (VERBOSE) console.log(`[${ts()}]  ·`, ...a); };

/* ----- helpers (slug MUST match the app's slug()) ----- */
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const num = s => { if (s == null) return null; const n = Number(String(s).replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : null; };
const today = () => new Date().toISOString().slice(0, 10);

/* ----- fetch with timeout + retry ----- */
async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA, "accept": "text/html" } });
      clearTimeout(to);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      warn(`fetch ${url} attempt ${attempt}/${FETCH_RETRIES} failed: ${e.message}`);
      if (attempt < FETCH_RETRIES) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

/* ----- parsing ----------------------------------------------------------------------------------
 * Strategy A: an embedded JSON array of item objects (covers hydrated/SSR-with-data pages).
 * Strategy B: labeled-text regex over the tag-stripped page.
 * Returns [{ name, supreme, range:[lo,hi]|null, trend, demand, rarity }]  (Supreme fields only).
 * ----------------------------------------------------------------------------------------------*/
const ITEM_RE = new RegExp(
  String.raw`(?<name>[A-Za-z0-9'’.()\- ]+?)\s*` +
  String.raw`Value\s*[-:]?\s*(?<value>[\d,]+)\s*` +
  String.raw`(?:Ranged Value\s*[-:]?\s*(?<range>[\d,]+\s*-\s*[\d,]+|N\/A)\s*)?` +
  String.raw`(?:Stability\s*[-:]?\s*(?<stab>[A-Za-z ]+?)\s*)?` +
  String.raw`Demand\s*[-:]?\s*(?<demand>\d+(?:\.\d+)?)\s*` +
  String.raw`Rarity\s*[-:]?\s*(?<rarity>\d+(?:\.\d+)?)`,
  "g"
);
const stripTags = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;|\s+/g, " ").trim();

function parseRange(r) {
  if (!r || /N\/?A/i.test(r)) return null;
  const m = r.match(/([\d,]+)\s*-\s*([\d,]+)/);
  if (!m) return null;
  const lo = num(m[1]), hi = num(m[2]);
  return lo != null && hi != null ? [Math.min(lo, hi), Math.max(lo, hi)] : null;
}
function cleanName(n) {
  return n.replace(/\s+/g, " ").trim()
    // drop leading tier/section words a greedy match may have grabbed
    .replace(/^(?:Tier\s*\d+|Hot|Rising|New|Featured)\s+/i, "").trim();
}

function extractFromJson(html) {
  // find array-ish blobs containing both a name and a value field
  const out = [];
  const re = /\{[^{}]*?"name"\s*:\s*"([^"]+)"[^{}]*?"value"\s*:\s*"?([\d,]+)"?[^{}]*?\}/gi;
  let m;
  while ((m = re.exec(html))) {
    const obj = m[0];
    const demand = (obj.match(/"demand"\s*:\s*"?([\d.]+)"?/i) || [])[1];
    const rarity = (obj.match(/"rarity"\s*:\s*"?([\d.]+)"?/i) || [])[1];
    const stab = (obj.match(/"stability"\s*:\s*"([^"]+)"/i) || [])[1];
    const range = (obj.match(/"range(?:d|dValue)?"\s*:\s*"([^"]+)"/i) || [])[1];
    out.push({ name: cleanName(m[1]), supreme: num(m[2]),
      range: parseRange(range), trend: stab || null, demand: num(demand), rarity: num(rarity) });
  }
  return out;
}
function extractFromText(html) {
  const text = stripTags(html);
  const out = [];
  let m;
  ITEM_RE.lastIndex = 0;
  while ((m = ITEM_RE.exec(text))) {
    const g = m.groups;
    const name = cleanName(g.name);
    if (!name || name.length > 40) continue;
    out.push({ name, supreme: num(g.value), range: parseRange(g.range),
      trend: g.stab ? g.stab.trim() : null, demand: num(g.demand), rarity: num(g.rarity) });
  }
  return out;
}
export function extractItems(html) {
  let items = extractFromJson(html);
  if (items.length < 5) items = extractFromText(html);   // fall back to text parsing
  // de-dupe by slug, keep first
  const seen = new Set(), uniq = [];
  for (const it of items) {
    const id = slug(it.name);
    if (!id || seen.has(id)) continue;
    seen.add(id); uniq.push(it);
  }
  return uniq;
}

/* ----- merge + validate + diff ----- */
function sanitizeTrend(t) {
  if (!t) return null;
  const norm = t.trim();
  // tolerate minor casing/words; only keep if it maps to a known tag
  const hit = [...TREND_OK].find(x => x.toLowerCase() === norm.toLowerCase());
  return hit || (TREND_OK.has(norm) ? norm : null);
}
function validItem(it) {
  return it && typeof it.name === "string" && it.name.length > 0 &&
    (it.supreme == null || (Number.isFinite(it.supreme) && it.supreme >= 0 && it.supreme < 100_000_000)) &&
    (it.demand == null || (it.demand >= 1 && it.demand <= 11)) &&
    (it.rarity == null || (it.rarity >= 1 && it.rarity <= 11)) &&
    (it.range == null || (Array.isArray(it.range) && it.range.length === 2 && it.range[0] <= it.range[1]));
}
/** Merge one tier's scrape into the working item map (keyed by id). Returns count merged. */
function mergeTier(map, scraped, category) {
  let n = 0;
  for (const s of scraped) {
    const id = slug(s.name);
    const prev = map.get(id) || {};
    const merged = {
      id, name: s.name, category,
      supreme: s.supreme,
      mm2: prev.mm2 ?? null,                         // carry MM2 cross-check (not auto-scraped)
      demand: Math.round(s.demand ?? prev.demand ?? null) || (s.demand ?? prev.demand ?? null),
      rarity: Math.round(s.rarity ?? prev.rarity ?? null) || (s.rarity ?? prev.rarity ?? null),
      trend: sanitizeTrend(s.trend) ?? prev.trend ?? null,
      range: s.range ?? prev.range ?? null,
      aliases: prev.aliases,                          // carry curated aliases
      placeholder: prev.placeholder,                  // carry placeholder flag
    };
    if (!validItem(merged)) { vlog(`skip invalid ${category}/${id}`, merged); continue; }
    // round demand/rarity to integers (Supreme uses whole; MM2 sometimes .5)
    if (merged.demand != null) merged.demand = Math.round(merged.demand);
    if (merged.rarity != null) merged.rarity = Math.round(merged.rarity);
    if (merged.aliases == null) delete merged.aliases;
    if (!merged.placeholder) delete merged.placeholder;
    map.set(id, merged);
    n++;
  }
  return n;
}
function diffItems(oldArr, newArr) {
  const o = new Map(oldArr.map(i => [i.id, i]));
  const changes = [];
  for (const ni of newArr) {
    const oi = o.get(ni.id);
    if (!oi) { changes.push({ id: ni.id, kind: "added", to: ni.supreme }); continue; }
    for (const f of ["supreme", "mm2", "demand", "rarity", "trend"]) {
      if ((oi[f] ?? null) !== (ni[f] ?? null)) changes.push({ id: ni.id, kind: f, from: oi[f] ?? null, to: ni[f] ?? null });
    }
    const orng = JSON.stringify(oi.range ?? null), nrng = JSON.stringify(ni.range ?? null);
    if (orng !== nrng) changes.push({ id: ni.id, kind: "range", from: orng, to: nrng });
  }
  const n = new Set(newArr.map(i => i.id));
  for (const oi of oldArr) if (!n.has(oi.id)) changes.push({ id: oi.id, kind: "removed", from: oi.supreme });
  return changes;
}

/* ----- notification (optional, portable, never throws) -----
 * Fires only when values changed AND a webhook env var is set, so runs without it are silent.
 *   DISCORD_WEBHOOK_URL  → posts a formatted message to a Discord channel
 *   NOTIFY_WEBHOOK_URL   → posts raw JSON to any endpoint (Slack/ntfy/Zapier/your own)
 */
async function notify(changes, updatedAt) {
  const discord = process.env.DISCORD_WEBHOOK_URL;
  const generic = process.env.NOTIFY_WEBHOOK_URL;
  if (!discord && !generic) return;
  const top = changes.slice(0, 15).map(c => `• ${c.id} — ${c.kind}: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("\n");
  const more = changes.length > 15 ? `\n…and ${changes.length - 15} more` : "";
  const summary = `**MM2 values updated — ${updatedAt}** (${changes.length} change${changes.length === 1 ? "" : "s"})\n${top}${more}`;
  const post = async (url, body) => {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) warn(`notify → HTTP ${res.status}`); else log("notification sent");
    } catch (e) { warn(`notify failed (non-fatal): ${e.message}`); }
  };
  if (discord) await post(discord, { content: summary.slice(0, 1900), username: "MM2 Values" });
  if (generic) await post(generic, { event: "mm2_values_updated", updatedAt, count: changes.length, changes });
}

/* ----- main ----- */
async function main() {
  if (!existsSync(VALUES_PATH)) { err(`values.json not found at ${VALUES_PATH} — cannot run safely.`); process.exit(1); }
  const existing = JSON.parse(await readFile(VALUES_PATH, "utf8"));
  if (!Array.isArray(existing.items) || existing.items.length < 100) { err("existing values.json looks invalid; aborting to avoid data loss."); process.exit(1); }
  log(`loaded values.json — ${existing.items.length} items, updatedAt ${existing.updatedAt}`);

  const map = new Map(existing.items.map(i => [i.id, { ...i }]));   // start from current data
  let tiersOK = 0, tiersFailed = 0;

  for (const [page, category] of TIERS) {
    const url = BASE + page;
    try {
      const html = await fetchText(url);
      const scraped = extractItems(html).filter(s => s.supreme != null);   // numeric-value rows only
      vlog(`${category}: extracted ${scraped.length} items`);
      if (scraped.length < (MIN_ITEMS[category] ?? 1)) {
        warn(`${category}: only ${scraped.length} items (< min ${MIN_ITEMS[category]}). Keeping previous data for this tier.`);
        tiersFailed++; continue;
      }
      const n = mergeTier(map, scraped, category);
      log(`${category}: merged ${n} items`);
      tiersOK++;
    } catch (e) {
      warn(`${category}: scrape failed (${e.message}). Keeping previous data for this tier.`);
      tiersFailed++;
    }
  }

  if (tiersOK === 0) { err("no tiers scraped successfully — leaving values.json untouched."); process.exit(1); }

  const newItems = [...map.values()];
  // global safety net: never shrink the catalogue by more than 10%
  if (newItems.length < existing.items.length * 0.9) {
    err(`refusing to write: item count dropped ${existing.items.length} → ${newItems.length} (>10%). Likely a parse problem.`);
    process.exit(1);
  }

  const changes = diffItems(existing.items, newItems);
  log(`reconcile complete — tiersOK=${tiersOK} tiersFailed=${tiersFailed} changes=${changes.length}`);

  if (changes.length === 0) { log("no value changes. values.json is current."); return; }

  // summarize
  for (const c of changes.slice(0, 50))
    log(`  ~ ${c.id} ${c.kind}: ${c.from ?? "—"} → ${c.to ?? "—"}`);
  if (changes.length > 50) log(`  …and ${changes.length - 50} more`);

  if (DRY) { log("--dry: not writing."); return; }

  const out = {
    schema: 1, updatedAt: today(), generatedBy: "auto-scrape",
    source: existing.source, notes: existing.notes,
    count: newItems.length,
    items: newItems.sort((a, b) => (b.supreme ?? 0) - (a.supreme ?? 0)),
  };
  await writeFile(VALUES_PATH, JSON.stringify(out, null, 2) + "\n");
  const entry = `\n## ${today()} — ${changes.length} change(s) [tiersOK ${tiersOK}, failed ${tiersFailed}]\n` +
    changes.map(c => `- \`${c.id}\` **${c.kind}**: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("\n") + "\n";
  await appendFile(CHANGELOG_PATH, entry);
  log(`wrote values.json (${newItems.length} items) and appended CHANGELOG.md`);
  await notify(changes, out.updatedAt);
}

export const __test = { slug, num, parseRange, cleanName, sanitizeTrend, validItem, mergeTier, diffItems };

// only run when invoked directly (so the test file can import the pure functions)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { err(e.stack || e.message); process.exit(1); });
}
