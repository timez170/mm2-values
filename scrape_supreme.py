#!/usr/bin/env python3
"""Lifenz MM2 feed — Supreme Values -> values.json auto-sync.

Fetches the Supreme category pages (Godlies, Chromas, Ancients, Sets, Uniques),
parses every item card, and merges the results into ./values.json:

  * supreme value, range, demand, rarity, stability, change, changePct updated
  * mm2 column, aliases, and placeholder flags are PRESERVED from the existing file
  * new items on Supreme appear automatically; categories not scraped
    (Legendaries, Vintages, Rares, ...) are left untouched
  * "126K" is parsed as 126000 — the scale-loss bug can't recur

FAIL-SAFE: if any category parses below its minimum item count, matches <80%
of the items already known in that category, or yields an insane value, the
script ABORTS WITHOUT WRITING (exit 2). A stale-but-correct feed always beats
a corrupted one.

Zero dependencies (stdlib only). Usage (repo root): python3 scrape_supreme.py
"""
import json, os, re, sys, time, html, datetime
from urllib.request import Request, urlopen

# Fetch engine: "plain" (urllib, fast, works on residential IPs), "browser" (headless
# Chromium via Playwright — executes the Incapsula/Imperva JS challenge that blocks
# datacenter IPs like GitHub Actions), or "auto" (plain first, escalate on challenge).
ENGINE = os.environ.get("SCRAPE_ENGINE", "auto").lower()

PAGES = [  # (url, category, min_items)
    ("https://supremevalues.com/mm2/godlies",  "Godly",   100),
    ("https://supremevalues.com/mm2/chromas",  "Chroma",  35),
    ("https://supremevalues.com/mm2/ancients", "Ancient", 10),
    ("https://supremevalues.com/mm2/sets",     "Set",     40),
    ("https://supremevalues.com/mm2/uniques",  "Unique",  1),
]
UA = {"User-Agent": "Mozilla/5.0 (LifenzFeedBot; +https://timez170.github.io/mm2-values)"}
STABS = ("Doing Well","Overpaid For","Underpaid For","Fluctuating","Improving","Declining","Peaking","Stable")
# Supreme display name -> our canonical name (ids must stay stable)
NAME_MAP = {
    "Godly":  {"Sunset":"Sunset (Knife)","Rainbow":"Rainbow (Knife)","Flowerwood":"Flowerwood (Knife)"},
    "Set":    {"Pumpkin Set":"Pumpkin Set (2018)","Aurora Set (Legend.)":"Aurora Set (Legendary)",
               "Vampire Set (Legend.)":"Vampire Set (Legendary)","Santa's Set (Legend.)":"Santa's Set (Legendary)",
               "Traveler Set":"Traveler Set (Legendary)"},
}
EXCLUDE = {"Godly": {"Batwing","Black Luger","Mortal Blade"}}   # 1M secrets; Batwing collides with the Ancient

def slug(name):
    return re.sub(r"-+","-",re.sub(r"[^a-z0-9]+","-",name.lower())).strip("-")

def num(tok):
    if tok is None: return None
    t = tok.replace(",","").replace("+","").strip()
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)([KM]?)", t, re.I)
    if not m: return None
    v = float(m.group(1)) * {"":1,"K":1000,"M":1000000}[m.group(2).upper()]
    return int(round(v))

def canonical(raw, category):
    n = re.sub(r"\s+"," ",raw).strip()
    if n.startswith("C. "): n = "Chroma " + n[3:]
    return NAME_MAP.get(category,{}).get(n,n)

def parse_page(html_text, category, known_names):
    """known_names must be sorted longest-first. Items are windows around each 'Value -' token,
    so cards without trailing delimiters (e.g. Priceless specials) can't swallow neighbours."""
    text = html.unescape(re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",html_text)))
    marks = list(re.finditer(r"Value\s*-\s*([0-9][\d,\.]*[KM]?|Priceless)", text))
    items, seen = [], set()
    nmap = NAME_MAP.get(category, {})
    for idx, m in enumerate(marks):
        if m.group(1) == "Priceless": continue
        val = num(m.group(1))
        # Sets place a "Contains - <item list>" clause between the name and its Value.
        # Drop it so the set NAME — not the tail of its contained-items list — sits at the
        # end of `pre` for known-name matching. Harmless for other categories (no "Contains -").
        pre = text[(marks[idx-1].end() if idx else 0):m.start()]
        pre = pre.split("Contains -")[0].strip()[-90:]
        fld = text[m.end():(marks[idx+1].start() if idx+1 < len(marks) else len(text))]
        low = pre.lower(); name = None
        for kn in known_names:                                   # 1) exact known name (longest first)
            alt = ("c. " + kn[7:].lower()) if kn.lower().startswith("chroma ") else None
            if low.endswith(kn.lower()) or (alt and low.endswith(alt)): name = kn; break
        if name is None:                                          # 2) per-category display-name map
            for key, mapped in nmap.items():
                k = key.lower()
                if low.endswith(k) and (len(low) == len(k) or low[-len(k)-1] in " )"): name = mapped; break
        if name is None:                                          # 3) new item: text after the last UI-control block
            seg = re.sub(r"^[^A-Za-z]+", "", pre.rsplit("Inv. Controls", 1)[-1]).strip()
            t = re.search(r"([A-Za-z0-9'.()\-\/ ]{2,60})$", seg)
            if not t: continue
            name = canonical(t.group(1).strip(), category)
            w = name.split()
            for k in range(len(w)//2, 0, -1):
                if w[-k:] == w[-2*k:-k]: name = " ".join(w[-k:]); break
        name = canonical(name, category)
        if name in EXCLUDE.get(category, set()) or name in seen: continue
        rm = re.search(r"Range\s*-\s*\[?\s*(?:N/A|([\d,\.KM]+)\s*-\s*([\d,\.KM]+))\s*\]?", fld)
        rng = [num(rm.group(1)), num(rm.group(2))] if rm and rm.group(1) else None
        sm = re.search(r"Stability\s*-\s*(%s)" % "|".join(STABS), fld)
        dm = re.search(r"Demand\s*-\s*(\d+)\s*Rarity\s*-\s*(\d+)", fld)
        cm = re.search(r"Change in Value\s*-\s*\(\s*([+\-][\d,\.KM]+)\s*\)\s*(?:([+\-][\d\.]+)\s*%)?", fld)
        items.append({"name":name,"category":category,"supreme":val,
            "range":rng,"trend":sm.group(1) if sm else None,
            "demand":int(dm.group(1)) if dm else None,"rarity":int(dm.group(2)) if dm else None,
            "change":num(cm.group(1)) if cm else None,
            "changePct":(float(cm.group(2)) if cm and cm.group(2) else (0.0 if cm and num(cm.group(1))==0 else None))})
        seen.add(name)
    return items

def log(msg):
    print(msg, flush=True)

def looks_blocked(text):
    """Incapsula/Imperva serves a JS-challenge stub instead of the page to non-browser
    clients. The stub never contains item cards; real category pages always do."""
    return "_Incapsula_Resource" in text or "Request unsuccessful" in text or "Value -" not in text

def fetch_plain(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=UA), timeout=30) as r:
                return r.read().decode("utf-8","replace")
        except Exception:
            if attempt == 2: raise
            time.sleep(4*(attempt+1))

_BROWSER = {"pw": None, "browser": None, "ctx": None}

def fetch_browser(url):
    """Headless-Chromium fetch. One shared context for the whole run, so the WAF
    cookie earned clearing the first challenge carries to every later page."""
    from playwright.sync_api import sync_playwright   # imported lazily: plain runs need no Playwright
    if _BROWSER["ctx"] is None:
        _BROWSER["pw"] = sync_playwright().start()
        _BROWSER["browser"] = _BROWSER["pw"].chromium.launch(
            args=["--disable-blink-features=AutomationControlled"])
        _BROWSER["ctx"] = _BROWSER["browser"].new_context(
            viewport={"width": 1366, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    page = _BROWSER["ctx"].new_page()
    try:
        last = ""
        for attempt in range(3):
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                # The challenge stub reloads itself once its JS sets the WAF cookie;
                # we simply wait until real item cards exist in the document.
                page.wait_for_function("document.documentElement.innerHTML.indexOf('Value -')>=0",
                                       timeout=20000)
                return page.content()
            except Exception:
                last = page.content()[:300].replace("\n", " ")
                log(f"[scrape] challenge not cleared for {url} (attempt {attempt+1}/3)")
                page.wait_for_timeout(4000 * (attempt + 1))
        raise RuntimeError(f"WAF challenge never cleared for {url}; last content: {last!r}")
    finally:
        page.close()

def close_browser():
    for k in ("ctx", "browser"):
        try:
            if _BROWSER[k]: _BROWSER[k].close()
        except Exception: pass
    try:
        if _BROWSER["pw"]: _BROWSER["pw"].stop()
    except Exception: pass
    _BROWSER.update({"pw": None, "browser": None, "ctx": None})

def fetch(url):
    if ENGINE in ("plain", "auto"):
        try:
            text = fetch_plain(url)
            if not looks_blocked(text):
                return text
            log(f"[scrape] plain fetch got WAF challenge for {url}" +
                ("; escalating to browser engine" if ENGINE == "auto" else ""))
            if ENGINE == "plain":
                raise RuntimeError("blocked by WAF (set SCRAPE_ENGINE=browser or auto)")
        except Exception:
            if ENGINE == "plain":
                raise
    return fetch_browser(url)

def main(root="."):
    vpath = os.path.join(root,"values.json")
    with open(vpath,encoding="utf-8") as f: existing = json.load(f)
    by_id = {o["id"]: o for o in existing["items"]}
    known_by_cat = {}
    for o in existing["items"]:
        known_by_cat.setdefault(o["category"],[]).append(o["name"])
    changed = new = 0
    summary = []
    for url, cat, min_n in PAGES:
        try:
            page = fetch(url)
        except Exception as e:
            print(f"[scrape] FETCH FAILED {cat}: {e}", file=sys.stderr); close_browser(); sys.exit(2)
        parsed = parse_page(page, cat, sorted(known_by_cat.get(cat,[]), key=len, reverse=True))
        if len(parsed) < min_n:
            print(f"[scrape] ABORT: {cat} parsed only {len(parsed)} items (min {min_n})", file=sys.stderr); close_browser(); sys.exit(2)
        if any(not (0 < it["supreme"] <= 5_000_000) for it in parsed):
            print(f"[scrape] ABORT: insane value in {cat}", file=sys.stderr); close_browser(); sys.exit(2)
        known = set(known_by_cat.get(cat,[]))
        matched = sum(1 for it in parsed if it["name"] in known)
        if known and matched < 0.8*len([n for n in known if not by_id[slug(n)].get("placeholder")]):
            print(f"[scrape] ABORT: {cat} matched only {matched}/{len(known)} known items", file=sys.stderr); close_browser(); sys.exit(2)
        summary.append(f"{cat}: {len(parsed)} parsed, {matched} matched")
        log(f"[scrape] {cat}: {len(parsed)} item(s) parsed, {matched} matched known")
        for it in parsed:
            iid = slug(it["name"])
            cur = by_id.get(iid)
            if cur is None:
                cur = {"id":iid,"name":it["name"],"category":cat,"supreme":None,"mm2":None,
                       "demand":None,"rarity":None,"trend":None}
                existing["items"].append(cur); by_id[iid] = cur; new += 1
            before = (cur.get("supreme"),cur.get("trend"),cur.get("change"))
            cur["supreme"]=it["supreme"]; cur["demand"]=it["demand"]; cur["rarity"]=it["rarity"]; cur["trend"]=it["trend"]
            if it["range"]: cur["range"]=it["range"]
            elif "range" in cur: cur.pop("range")
            if it["change"] is not None:
                cur["change"]=it["change"]
                if it["changePct"] is not None: cur["changePct"]=it["changePct"]
                elif "changePct" in cur: cur.pop("changePct")
            if before != (cur.get("supreme"),cur.get("trend"),cur.get("change")): changed += 1
    close_browser()
    existing["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    body = '{\n"updatedAt": '+json.dumps(existing["updatedAt"])+',\n"items": [\n' + \
        ',\n'.join(json.dumps(o,separators=(",",":"),ensure_ascii=False) for o in existing["items"]) + '\n]\n}\n'
    with open(vpath,"w",encoding="utf-8") as f: f.write(body)
    print(f"[scrape] OK: {changed} item(s) updated, {new} new, {len(existing['items'])} total")
    step = os.environ.get("GITHUB_STEP_SUMMARY")
    if step:
        with open(step, "a", encoding="utf-8") as f:
            f.write(f"### Supreme sync — {existing['updatedAt']}\n"
                    f"- **{changed}** updated, **{new}** new, {len(existing['items'])} total\n"
                    + "".join(f"- {line}\n" for line in summary))

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv)>1 else ".")
