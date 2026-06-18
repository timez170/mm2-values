import { extractItems, __test } from "./update-values.mjs";
const { parseRange, sanitizeTrend, validItem, mergeTier, diffItems, slug } = __test;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : (fail++, fails.push(m)); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- fixture mimicking Supreme's labeled rows (tag-stripped equivalent) ---
const FIXTURE = `
<html><body>
<div class="card">Darkbringer Value - 38 Ranged Value - N/A Stability - Stable Demand - 1 Rarity - 2</div>
<div class="card">Rainbow Gun Value - 380 Ranged Value - 380 - 410 Stability - Overpaid For Demand - 5 Rarity - 3</div>
<div class="card">Traveler's Gun Value - 6300 Stability - Doing Well Demand - 6 Rarity - 5</div>
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

// --- merge preserves MM2 + aliases, updates Supreme fields ---
const map = new Map([["darkbringer", { id: "darkbringer", name: "Darkbringer", category: "Godly", supreme: 40, mm2: 43, demand: 1, rarity: 2, trend: "Stable", aliases: ["cdb"] }]]);
mergeTier(map, [{ name: "Darkbringer", supreme: 38, demand: 1, rarity: 2, trend: "Stable", range: null }], "Godly");
const merged = map.get("darkbringer");
ok(merged.supreme === 38, "mergeTier updates Supreme value (40→38)");
ok(merged.mm2 === 43, "mergeTier preserves MM2 cross-check value");
ok(eq(merged.aliases, ["cdb"]), "mergeTier preserves curated aliases");

// --- diff detects the change ---
const changes = diffItems(
  [{ id: "darkbringer", supreme: 40, mm2: 43, demand: 1, rarity: 2, trend: "Stable" }],
  [{ id: "darkbringer", supreme: 38, mm2: 43, demand: 1, rarity: 2, trend: "Stable" }]
);
ok(changes.length === 1 && changes[0].kind === "supreme" && changes[0].from === 40 && changes[0].to === 38, "diffItems reports supreme 40→38");
const noChange = diffItems([{ id: "a", supreme: 5 }], [{ id: "a", supreme: 5 }]);
ok(noChange.length === 0, "diffItems reports nothing when identical");

console.log(`\n${pass} passed, ${fail} failed of ${pass + fail}`);
if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
else console.log("UPDATER PIPELINE: ALL CLEAR ✓");
