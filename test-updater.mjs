import { extractItems, __test } from "./update-values.mjs";
const { parseRange, sanitizeTrend, validItem, mergeTier, diffItems, slug, matchKey, variantBase } = __test;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : (fail++, fails.push(m)); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- fixture mimicking Supreme's real server-rendered rows (icon + buttons + bracketed range + trailing fields) ---
const row = (icon, name, val, range, stab, dem, rar, last) =>
  `<table><tr><td><img src="https://supremevalues.com/media/mm2godlies/${icon}.png" alt="${icon}"></td>` +
  `<td>${name} <img src="https://supremevalues.com/media/experimental.png" title="extra"> ` +
  `Value - <b>${val}</b> <button>+1</button> <button>-1</button> <button>~</button> ` +
  `Ranged Value - [<b>${range}</b>] ` +
  `Stability - <b>${stab}</b> <img src="https://supremevalues.com/media/stability/${stab}.png" alt="Item Stability"> ` +
  `Demand - <b>${dem}</b> Rarity - <b>${rar}</b> ` +
  `Origin - Some Crate (Unboxed) Last Change in Value - (<b>${last}</b>)</td></tr></table>`;
const FIXTURE = `<html><body><h2>Tier 3</h2>
${row("TravelersGun", "Traveler's Gun", "6,300", "N/A", "Doing Well", "6", "5", "+100")}
${row("RainbowGun", "Rainbow Gun", "380", "380-410", "Overpaid For", "5", "3", "-20")}
${row("Darkbringer", "Darkbringer", "38", "N/A", "Stable", "1", "2", "-2")}
</body></html>`;

// --- extraction ---
const items = extractItems(FIXTURE);
ok(items.length === 3, "extracts all 3 fixture rows (got " + items.length + ")");
const db = items.find(i => slug(i.name) === "darkbringer");
ok(db && db.supreme === 38 && db.demand === 1 && db.rarity === 2 && db.trend === "Stable", "Darkbringer parsed: 38 / D1 / R2 / Stable");
const rg = items.find(i => slug(i.name) === "rainbow-gun");
ok(rg && rg.supreme === 380 && eq(rg.range, [380, 410]) && rg.trend === "Overpaid For", "Rainbow Gun parsed: 380, range [380,410], Overpaid For");
const tg = items.find(i => slug(i.name) === "traveler-s-gun");
ok(tg && tg.supreme === 6300 && tg.range === null && tg.demand === 6, "Traveler's Gun parsed: 6300, no range, D6");

// --- helpers ---
ok(eq(parseRange("380 - 410"), [380, 410]) && parseRange("N/A") === null && parseRange("") === null, "parseRange handles range + N/A");
ok(sanitizeTrend("doing well") === "Doing Well" && sanitizeTrend("STABLE") === "Stable" && sanitizeTrend("nonsense") === null, "sanitizeTrend normalizes + rejects junk");
ok(validItem({ name: "x", supreme: 100, demand: 5, rarity: 3 }) === true, "validItem accepts good item");
ok(validItem({ name: "x", supreme: -5 }) === false, "validItem rejects negative value");
ok(validItem({ name: "x", demand: 20 }) === false, "validItem rejects demand>11");
ok(validItem({ name: "x", range: [5, 3] }) === false, "validItem rejects inverted range");

// --- merge: update-only, matches by normalized name, preserves MM2 + aliases, no duplicates ---
const existing = [{ id: "chroma-traveler-s-gun", name: "Chroma Traveler's Gun", category: "Chroma", supreme: 225000, mm2: 230000, demand: 9, rarity: 10, trend: "Stable", aliases: ["ctg"] }];
const map = new Map(existing.map(i => [i.id, { ...i }]));
const keyToId = new Map(existing.map(i => [i.category + "|" + matchKey(i.name), i.id]));
ok(matchKey("C. Traveler's Gun") === matchKey("Chroma Traveler's Gun"), "matchKey collapses 'C.' to 'Chroma'");
const r1 = mergeTier(map, [{ name: "C. Traveler's Gun", supreme: 220000, demand: 9, rarity: 10, trend: "Stable", range: null }], "Chroma", keyToId);
const merged = map.get("chroma-traveler-s-gun");
ok(r1.updated === 1 && merged.supreme === 220000, "mergeTier updates value via abbreviated 'C.' name (225000→220000)");
ok(merged.mm2 === 230000 && eq(merged.aliases, ["ctg"]), "mergeTier preserves MM2 + curated aliases");
ok(merged.name === "Chroma Traveler's Gun" && map.size === 1, "mergeTier keeps canonical name — no 'C.' duplicate created");
const r2 = mergeTier(map, [{ name: "Totally New Item", supreme: 5, demand: 1, rarity: 1, trend: "Stable" }], "Godly", keyToId);
ok(map.size === 2 && r2.added === 1 && map.has("totally-new-item"), "unknown scraped item is now ADDED (add-new-items mode)");
const addedItem = map.get("totally-new-item");
ok(addedItem && addedItem.supreme === 5 && addedItem.mm2 === null && addedItem.category === "Godly" && eq(addedItem.aliases, []), "added item carries Supreme value, mm2 null, empty aliases");

// --- cross-tier name collision is rejected (category guard) ---
const ex2 = [{ id: "aurora-gun", name: "Aurora Gun", category: "Godly", supreme: 45, mm2: null, demand: 3, rarity: 4, trend: "Stable" }];
const m2 = new Map(ex2.map(i => [i.id, { ...i }]));
const k2 = new Map(ex2.map(i => [i.category + "|" + matchKey(i.name), i.id]));
mergeTier(m2, [{ name: "Aurora Gun", supreme: 1, demand: 1, rarity: 1, trend: "Stable" }], "Common", k2);
ok(m2.get("aurora-gun").supreme === 45, "cross-tier collision rejected: Common does not overwrite Godly");
mergeTier(m2, [{ name: "Aurora Gun", supreme: 50, demand: 3, rarity: 4, trend: "Stable" }], "Godly", k2);
ok(m2.get("aurora-gun").supreme === 50, "same-category scrape updates correctly");

// --- set "Contains - …" suffix is stripped so set names match ---
const setItems = extractItems(`<table><tr><td><img src="/media/mm2sets/SparkleSet.png" alt="Sparkle Set"></td><td>Sparkle Set Contains - Sparkles 1-10 Value - <b>5,850</b> Ranged Value - [<b>N/A</b>] Stability - <b>Stable</b> Demand - <b>5</b> Rarity - <b>5</b></td></tr></table>`);
ok(setItems.length === 1 && slug(setItems[0].name) === "sparkle-set" && setItems[0].supreme === 5850, "set name strips 'Contains - …' suffix");

// --- variant base: (Knife)/(Gun) collapse to a shared base; year suffixes stay distinct ---
ok(variantBase("Silent Night (Knife)") === "Silent Night" && variantBase("Silent Night (Gun)") === "Silent Night", "variantBase strips (Knife)/(Gun)");
ok(variantBase("Mummy 2018") === "Mummy 2018" && variantBase("Potion (2017)") === "Potion (2017)", "variantBase keeps year-suffix items distinct");

// --- add-mode: equal-value (Knife)/(Gun) variants collapse to ONE base entry ---
const mAdd = new Map(), kAdd = new Map();
const rc = mergeTier(mAdd, [
  { name: "Glacier (Knife)", supreme: 100, demand: 2, rarity: 3, trend: "Stable" },
  { name: "Glacier (Gun)",   supreme: 100, demand: 2, rarity: 3, trend: "Stable" },
], "Rare", kAdd);
ok(rc.added === 1 && mAdd.has("glacier") && !mAdd.has("glacier-gun"), "equal-value (Knife)/(Gun) collapse to a single 'Glacier'");

// --- add-mode: differing-value variants are kept SEPARATE (honest) ---
const mSplit = new Map(), kSplit = new Map();
const rs = mergeTier(mSplit, [
  { name: "Ember (Knife)", supreme: 90, demand: 2, rarity: 3, trend: "Stable" },
  { name: "Ember (Gun)",   supreme: 70, demand: 2, rarity: 3, trend: "Stable" },
], "Rare", kSplit);
ok(rs.added === 2 && mSplit.has("ember-knife") && mSplit.has("ember-gun"), "differing-value variants kept separate");

// --- add-mode: a new variant of an item we ALREADY track (by alias) is skipped, not duplicated ---
const exDup = [{ id: "frost-knife", name: "Frost (Knife)", category: "Rare", supreme: 40, mm2: null, demand: 2, rarity: 3, trend: "Stable", aliases: ["frost"] }];
const mDup = new Map(exDup.map(i => [i.id, { ...i }]));
const kDup = new Map();
for (const it of exDup) { kDup.set(it.category + "|" + matchKey(it.name), it.id); for (const a of it.aliases) kDup.set(it.category + "|" + matchKey(a), it.id); }
const rd = mergeTier(mDup, [{ name: "Frost (Gun)", supreme: 38, demand: 2, rarity: 3, trend: "Stable" }], "Rare", kDup);
ok(rd.added === 0 && rd.skipped.length === 1 && mDup.size === 1, "new variant of an already-tracked item is skipped (no 'Frost' dupe)");

// --- namespaced match key resolves the Sunset (Godly) vs Sun Set (Set) collision ---
const ex3 = [{ id: "sunset", name: "Sunset", category: "Godly", supreme: 500, mm2: null, demand: 4, rarity: 3, trend: "Stable" }, { id: "sun-set", name: "Sun Set", category: "Set", supreme: 1200, mm2: null, demand: 4, rarity: 4, trend: "Stable" }];
const m3 = new Map(ex3.map(i => [i.id, { ...i }]));
const k3 = new Map(ex3.map(i => [i.category + "|" + matchKey(i.name), i.id]));
mergeTier(m3, [{ name: "Sunset", supreme: 450, demand: 4, rarity: 3, trend: "Stable" }], "Godly", k3);
mergeTier(m3, [{ name: "Sun Set", supreme: 1150, demand: 4, rarity: 4, trend: "Stable" }], "Set", k3);
ok(m3.get("sunset").supreme === 450 && m3.get("sun-set").supreme === 1150, "namespaced keys resolve Sunset vs Sun Set collision");

// --- alias-aware matching: scraped bare name resolves to the curated "(Knife)" item ---
const ex4 = [{ id: "sunset-knife", name: "Sunset (Knife)", category: "Godly", supreme: 500, mm2: null, demand: 4, rarity: 3, trend: "Stable", aliases: ["sunset"] }];
const m4 = new Map(ex4.map(i => [i.id, { ...i }]));
const k4 = new Map();
for (const it of ex4) { k4.set(it.category + "|" + matchKey(it.name), it.id); for (const a of (it.aliases || [])) k4.set(it.category + "|" + matchKey(a), it.id); }
mergeTier(m4, [{ name: "Sunset", supreme: 480, demand: 4, rarity: 3, trend: "Stable" }], "Godly", k4);
ok(m4.get("sunset-knife").supreme === 480, "alias-aware match: scraped 'Sunset' updates 'Sunset (Knife)' via alias");

// --- diff detects the change ---
const changes = diffItems(
  [{ id: "darkbringer", supreme: 40, mm2: 43, demand: 1, rarity: 2, trend: "Stable" }],
  [{ id: "darkbringer", supreme: 38, mm2: 43, demand: 1, rarity: 2, trend: "Stable" }]
);
ok(changes.length === 1 && changes[0].kind === "supreme" && changes[0].from === 40 && changes[0].to === 38, "diffItems reports supreme 40→38");
const noChange = diffItems([{ id: "a", supreme: 5 }], [{ id: "a", supreme: 5 }]);
ok(noChange.length === 0, "diffItems reports nothing when identical");

// --- anomaly detection: large single-cycle moves are flagged, normal/tiny ones are not ---
const { isAnomalous, updateHistory, buildDiscordEmbed } = __test;
ok(isAnomalous({ kind: "supreme", from: 1000, to: 2000 }), "100% jump flagged as anomalous");
ok(!isAnomalous({ kind: "supreme", from: 1000, to: 1100 }), "10% move not flagged");
ok(!isAnomalous({ kind: "supreme", from: 5, to: 12 }), "tiny absolute move on a cheap item not flagged");
ok(!isAnomalous({ kind: "added", from: null, to: 9999 }), "added/removed never flagged as anomalous");

// --- history time-series: append, same-day overwrite, alignment, trim ---
let H = updateHistory(null, [{ id: "x", supreme: 100 }, { id: "y", supreme: 50 }], "2026-06-18");
ok(H.dates.length === 1 && H.values.x[0] === 100 && H.values.y[0] === 50, "history seeds day 1");
H = updateHistory(H, [{ id: "x", supreme: 110 }, { id: "y", supreme: 50 }], "2026-06-19");
ok(H.dates.length === 2 && eq(H.values.x, [100, 110]), "history appends a new day");
H = updateHistory(H, [{ id: "x", supreme: 115 }, { id: "y", supreme: 55 }], "2026-06-19");
ok(H.dates.length === 2 && H.values.x[1] === 115, "same-day rerun overwrites the day's point (no new day)");
H = updateHistory(H, [{ id: "x", supreme: 120 }, { id: "z", supreme: 7 }], "2026-06-20");
ok(H.values.z.length === 3 && H.values.z[0] === null && H.values.z[1] === null && H.values.z[2] === 7, "late-appearing item is left-padded with nulls and aligned");
ok(H.values.y[2] === null && H.values.y.length === 3, "absent item gets a null for the day, series stay aligned");
const trimmed = updateHistory({ schema: 1, dates: ["d1", "d2", "d3"], values: { a: [1, 2, 3] } }, [{ id: "a", supreme: 4 }], "d4", 2);
ok(trimmed.dates.length === 2 && eq(trimmed.values.a, [3, 4]), "history trims to maxDays");

// --- Discord embed: categorizes rising/falling/new/anomaly, sets color + payload shape ---
const embedPayload = buildDiscordEmbed([
  { id: "up-item", kind: "supreme", from: 100, to: 130 },
  { id: "down-item", kind: "supreme", from: 200, to: 150 },
  { id: "new-item", kind: "added", to: 12 },
  { id: "spiker", kind: "supreme", from: 100, to: 500, anomaly: true },
], "2026-06-20", { updated: 3, added: 1 });
ok(Array.isArray(embedPayload.embeds) && embedPayload.embeds.length === 1, "embed payload has one embed");
const E = embedPayload.embeds[0];
const fieldNames = E.fields.map(f => f.name).join(" | ");
ok(/Rising/.test(fieldNames) && /Falling/.test(fieldNames) && /New items/.test(fieldNames) && /verify/.test(fieldNames), "embed has rising/falling/new/anomaly fields");
ok(typeof E.color === "number" && E.description.includes("2026-06-20"), "embed carries color + dated description");
ok(E.fields.every(f => f.value.length <= 1024), "no embed field exceeds Discord's 1024-char limit");

console.log(`\n${pass} passed, ${fail} failed of ${pass + fail}`);
if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
else console.log("UPDATER PIPELINE: ALL CLEAR ✓");
