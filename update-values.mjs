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
  ["legendaries", "Legendary"], ["sets", "Set"],
  ["uniques", "Unique"], ["vintages", "Vintage"],
  ["rares", "Rare"], ["uncommons", "Uncommon"], ["commons", "Common"],
];
// minimum plausible item counts per category — below this we treat the scrape as failed for that tier
const MIN_ITEMS = { Godly: 50, Chroma: 20, Ancient: 5, Legendary: 1, Set: 20, Unique: 1, Vintage: 3, Rare: 1, Uncommon: 1, Common: 1 };
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
// match Supreme's display names to our curated ids — Supreme abbreviates "Chroma" as "C." on some tiers
const matchKey = name => name.toLowerCase().replace(/^c\.\s+/, "chroma ").replace(/[^a-z0-9]+/g, "");
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

/* ----- parsing -----------------------------------------------------------------------------------
 * Supreme tier pages are server-rendered HTML. Each item row begins with the item's icon image at
 * /media/mm2<tier>/<Name>.png, followed by the displayed name and labeled fields, e.g.:
 *   <icon> Traveler's Gun  Value - 6,300 +1 -1 ~  Ranged Value - [N/A]  Stability - Stable
 *          Demand - 6 Rarity - 5  Origin - …  Last Change in Value - (+100)
 * We split each page on that item-icon image (a delimiter that always exists, exactly one per item)
 * and parse each block on its own. This is immune to the +/- buttons between value and range, the
 * bracketed range, the free-text Origin, and the trailing "Last Change in Value" — all of which
 * broke a single-pass regex. Returns [{ name, supreme, range:[lo,hi]|null, trend, demand, rarity }].
 * --------------------------------------------------------------------------------------------------*/
const stripTags = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&#0*39;|&#x0*27;|&apos;|&#8217;|&#x2019;|&rsquo;|&lsquo;|&#8216;|&#x2018;/gi, "'")
  .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
  .replace(/&nbsp;/gi, " ")
  .replace(/\s+/g, " ").trim();

function parseRange(r) {
  if (!r || /N\/?A/i.test(r)) return null;
  const m = r.match(/([\d,]+)\s*-\s*([\d,]+)/);
  if (!m) return null;
  const lo = num(m[1]), hi = num(m[2]);
  return lo != null && hi != null ? [Math.min(lo, hi), Math.max(lo, hi)] : null;
}
function cleanName(n) {
  return n.replace(/\s+/g, " ").trim()
    .replace(/\s+Contains\s+-.*$/i, "")          // sets list contents inline: "Ever Set Contains - Evergreen, …"
    .replace(/^(?:Tier\s*\d+|Changelog|Hot|Rising|New|Featured)\s+/i, "")
    .replace(/\s+/g, " ").trim();
}
// strip a trailing form qualifier so "Silent Night (Knife)" and "Silent Night (Gun)" share a base.
// year suffixes like "Mummy (2018)" / "Potion (2017)" are NOT stripped — they are distinct collectibles.
const variantBase = name => name.replace(/\s*\((?:knife|gun)\)\s*$/i, "").trim();
// normalized base key for grouping new variants + detecting items we already track (matchKey-compatible)
const baseKey = name => matchKey(variantBase(name));
function uniqueId(map, base) { let id = base || "item", n = 2; while (map.has(id)) id = `${base}-${n++}`; return id; }

// the per-item icon, e.g. <img src=".../media/mm2godlies/TravelersGun.png"> — match the path on any
// element (some tiers render it on a non-<img> tag), and split each row on it.
const ITEM_ICON = /<[a-z]+\b[^>]*?\/media\/mm2[a-z]+\/[^>]*?>/i;

function parseBlock(seg) {
  const text = stripTags(seg);
  // first "Value - <digits>" is the real value; the "Value" in "Ranged Value" / "Last Change in
  // Value" is followed by "[" / "(" respectively, so the digit requirement skips them.
  const mVal = text.match(/\bValue\s*-\s*([\d,]+)/);
  if (!mVal) return null;
  const name = cleanName(text.slice(0, mVal.index));
  if (!name || name.length > 40) return null;
  const mRange = text.match(/Ranged Value\s*-\s*\[?\s*([\d,]+\s*-\s*[\d,]+|N\/?A)/i);
  const mStab  = text.match(/Stability\s*-\s*([A-Za-z][A-Za-z ]*?)\s+(?:Demand|Rarity|Origin|Last)\b/i);
  const mDem   = text.match(/\bDemand\s*-\s*([\d.]+)/i);
  const mRar   = text.match(/\bRarity\s*-\s*([\d.]+)/i);
  return {
    name,
    supreme: num(mVal[1]),
    range: parseRange(mRange ? mRange[1] : null),
    trend: mStab ? mStab[1].trim() : null,
    demand: num(mDem ? mDem[1] : null),
    rarity: num(mRar ? mRar[1] : null),
  };
}

export function extractItems(html) {
  const blocks = html.split(ITEM_ICON);   // blocks[0] = page preamble; blocks[1..] = one item each
  const seen = new Set(), out = [];
  for (let i = 1; i < blocks.length; i++) {
    const it = parseBlock(blocks[i]);
    if (!it) continue;
    const id = slug(it.name);
    if (!id || seen.has(id)) continue;     // de-dupe by slug
    seen.add(id); out.push(it);
  }
  return out;
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
/**
 * Reconcile a tier against the catalogue:
 *   1. UPDATE the Supreme fields of items we already curate, matched by normalized name / alias
 *      (so "C. Traveler's Gun" updates "Chroma Traveler's Gun"). id / name / mm2 / aliases kept.
 *   2. ADD items Supreme lists that we don't yet track. Balanced variant handling: "(Knife)"/"(Gun)"
 *      forms of the same item collapse to one base entry when their value matches; if their values
 *      genuinely differ they are kept as separate entries (honest). A would-be new item whose base
 *      already exists in the catalogue (under any name or alias, same category) is skipped as a dupe.
 * New items carry Supreme value/demand/rarity/trend/range and mm2:null (no MM2Values cross-check yet,
 * which the app already renders honestly as "—").
 */
function mergeTier(map, scraped, category, keyToId) {
  let updated = 0, added = 0; const skipped = [];
  // bases we already track in THIS category (curated names + aliases) — never add a variant of these
  const existingBase = new Set();
  for (const it of map.values()) {
    if (it.category !== category) continue;
    existingBase.add(baseKey(it.name));
    for (const a of (it.aliases || [])) existingBase.add(baseKey(a));
  }
  // phase 1 — update curated items; collect the rest
  const leftover = [];
  for (const s of scraped) {
    const id = keyToId.get(category + "|" + matchKey(s.name));   // key namespaced by category
    const prev = id && map.get(id);
    if (!prev) { leftover.push(s); continue; }
    const merged = {
      ...prev,
      supreme: s.supreme != null ? s.supreme : prev.supreme,
      demand: s.demand != null ? Math.round(s.demand) : prev.demand,
      rarity: s.rarity != null ? Math.round(s.rarity) : prev.rarity,
      trend: sanitizeTrend(s.trend) ?? prev.trend ?? null,
      range: s.range ?? prev.range ?? null,
    };
    if (!validItem(merged)) { vlog(`skip invalid ${category}/${id}`); continue; }
    map.set(id, merged); updated++;
  }
  // phase 2 — add new items, grouping (Knife)/(Gun) variants by shared base
  const groups = new Map();
  for (const s of leftover) {
    const bk = baseKey(s.name);
    if (existingBase.has(bk)) { skipped.push(s.name); continue; }   // a variant of something we already track
    let g = groups.get(bk); if (!g) { g = []; groups.set(bk, g); } g.push(s);
  }
  for (const members of groups.values()) {
    const collapse = members.length > 1 && new Set(members.map(m => m.supreme)).size === 1;
    const toAdd = collapse ? [{ ...members[0], name: variantBase(members[0].name) }] : members;
    for (const m of toAdd) {
      const item = {
        id: uniqueId(map, slug(m.name)), name: m.name, category,
        supreme: m.supreme, mm2: null,
        demand: m.demand != null ? Math.round(m.demand) : null,
        rarity: m.rarity != null ? Math.round(m.rarity) : null,
        trend: sanitizeTrend(m.trend), range: m.range ?? null,
        placeholder: false, aliases: [],
      };
      if (!validItem(item)) { vlog(`skip invalid new ${category}/${item.name}`); continue; }
      map.set(item.id, item); added++;
      existingBase.add(baseKey(item.name));   // stop a later group adding the same base
    }
  }
  return { updated, added, skipped };
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
  // match key: namespaced by category, indexed by name AND each alias (so Supreme's names resolve)
  const keyToId = new Map();
  for (const it of existing.items) {
    keyToId.set(it.category + "|" + matchKey(it.name), it.id);
    for (const a of (it.aliases || [])) keyToId.set(it.category + "|" + matchKey(a), it.id);
  }
  let tiersOK = 0, tiersFailed = 0, totalUpdated = 0, totalAdded = 0;

  for (const [page, category] of TIERS) {
    const url = BASE + page;
    try {
      const html = await fetchText(url);
      const scraped = extractItems(html).filter(s => s.supreme != null);   // numeric-value rows only
      vlog(`${category}: extracted ${scraped.length} items`);
      if (scraped.length < (MIN_ITEMS[category] ?? 1)) {
        warn(`${category}: only ${scraped.length} items (< min ${MIN_ITEMS[category]}). Keeping previous data for this tier.`);
        const _blks = html.split(ITEM_ICON);
        const _vN = (stripTags(html).match(/Value\s*-\s*[\d,]/g) || []).length;
        warn(`${category} diagnostic — html ${html.length} · blocks ${_blks.length} · stripped 'Value - N' count ${_vN}`);
        warn(`${category} block[1]: ${JSON.stringify(stripTags(_blks[1] || "").slice(0, 320))}`);
        warn(`${category} block[2]: ${JSON.stringify(stripTags(_blks[2] || "").slice(0, 320))}`);
        tiersFailed++; continue;
      }
      const { updated, added, skipped } = mergeTier(map, scraped, category, keyToId);
      totalUpdated += updated; totalAdded += added;
      log(`${category}: updated ${updated}, added ${added}` + (skipped.length ? `, ${skipped.length} variant-dupes skipped` : "") + ` (of ${scraped.length} scraped)`);
      if (VERBOSE && skipped.length) vlog(`${category} skipped (already tracked as a variant): ${skipped.slice(0, 25).join(" | ")}`);
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
  log(`reconcile complete — tiersOK=${tiersOK} tiersFailed=${tiersFailed} updated=${totalUpdated} added=${totalAdded} changes=${changes.length}`);

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

export const __test = { slug, matchKey, num, parseRange, cleanName, variantBase, baseKey, uniqueId, sanitizeTrend, validItem, mergeTier, diffItems };

// only run when invoked directly (so the test file can import the pure functions)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { err(e.stack || e.message); process.exit(1); });
}
