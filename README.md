# MM2 Trade Calculator — Auto-Updater

Keeps the calculator's value list current by scraping **Supreme Values** (the authoritative,
server-rendered source) on a schedule, reconciling the **entire** table against `values.json`,
and committing changes only when something actually moved. The calculator pulls `values.json` on
load, caches it, and falls back to its embedded list if the source is ever unavailable.

```
mm2-auto-updater/
├─ values.json                      # the live value list the app loads (seeded, accurate as of Jun 17 2026)
├─ update-values.mjs                # the scraper / reconciler / differ (Node 18+, zero deps)
├─ test-updater.mjs                 # offline unit test of the parse→merge→diff→validate pipeline
├─ CHANGELOG.md                     # auto-appended log of every value change (created on first change)
└─ .github/workflows/update-values.yml   # runs the scraper every 6h and commits if changed
```

## How it fits together

1. **`update-values.mjs`** fetches each Supreme tier page, extracts every item, and merges the
   scraped fields (value, demand, rarity, trend, range) over the existing `values.json`. MM2Values
   numbers, curated aliases, and placeholder flags are **carried over** from the existing file —
   Supreme is authoritative for value/demand/rarity/trend; MM2 is a manual cross-check that isn't
   auto-scraped (it's client-rendered and would need a headless browser).
2. The **GitHub Action** runs the script on a cron and commits `values.json` + `CHANGELOG.md` only
   when the diff is non-empty.
3. The **calculator** (`DATA_URL` near the top of the HTML) fetches the published `values.json`,
   validates it, caches it in `localStorage`, and shows a "Values updated" toast when it changes.
   If the fetch fails or the data is invalid, it uses the cached copy, then the embedded list — so
   the app is always functional, online or offline.

## One-time setup (free, hands-off)

1. Put this folder's contents in a GitHub repo (the calculator HTML can live in the same repo).
2. Enable **GitHub Pages** (Settings → Pages) or just use the raw file URL — both send permissive
   CORS so the app can fetch the JSON even when opened as a local file.
3. In the calculator HTML, set:
   ```js
   const DATA_URL = "https://raw.githubusercontent.com/<user>/<repo>/main/values.json";
   ```
   (Leave it `""` to stay fully offline on the embedded list.)
4. The workflow runs every 6 hours automatically. To run it now: **Actions → Update MM2 Values → Run workflow**.

## Get notified when values change

The app already shows a "Values updated" toast when you open it after a change, and every change is
recorded in `CHANGELOG.md`. To also get pinged **outside** the app (so you know the moment a new
update lands), set one of these env vars — the script posts a summary only when values actually change,
and a failed notification never blocks the update:

- **Discord** (recommended, matches the Lifenz server): create a webhook in your server
  (Server Settings → Integrations → Webhooks → New Webhook → copy URL), then add it as a repo secret
  named `DISCORD_WEBHOOK_URL` (Settings → Secrets and variables → Actions → New repository secret).
- **Anything else** (Slack, ntfy.sh, email-via-Zapier, your own endpoint): set `NOTIFY_WEBHOOK_URL`
  to receive a raw JSON payload `{event, updatedAt, count, changes}`.

For a local cron instead of the Action: `export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"`
before running the script.

## Run / test locally

```bash
node update-values.mjs --dry --verbose   # scrape + show the diff, write nothing
node update-values.mjs                    # scrape + write values.json if changed
node test-updater.mjs                     # offline pipeline test (no network)
```

## Reliability & safety (by design)

- **Per-tier isolation** — if one tier's fetch or parse fails, the others still update and that
  tier keeps its previous data. The run aborts (writes nothing) only if *no* tier succeeds.
- **Fail-safe validation** — a tier yielding fewer than its minimum plausible item count is
  rejected; the whole write is refused if the catalogue would shrink by >10%. A parser hiccup
  degrades gracefully instead of corrupting the list.
- **Per-item validation** — values must be finite and in range; demand/rarity ∈ 1–10; ranges
  must be ordered. Bad rows are skipped, keeping the last good value.
- **Retries + timeouts** on every fetch.
- **Full audit trail** in `CHANGELOG.md`.

## ⚠️ Verify the parser once against live HTML

I authored `extractItems()` against Supreme's observed layout, but I couldn't fetch the live page
from my build environment. **Run `node update-values.mjs --dry --verbose` once** and confirm the
per-tier "extracted N items" counts look right. If a tier reports far fewer items than expected,
adjust the `ITEM_RE` regex (or the embedded-JSON probe) in `extractItems()` — it's isolated and
documented. The validation above guarantees nothing bad gets written until the parser is dialed in.

## Notes

- Both sites use the same unit (Seer = 3), compared 1:1 — no conversion.
- `values.json` is sorted by Supreme value on write; the app re-indexes on load.
- Cadence: the Action re-scrapes every 6h; the app also refreshes on each load, so users see new
  values within one app-open of a change.
