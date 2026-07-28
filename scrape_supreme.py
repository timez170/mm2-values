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
        pre = text[(marks[idx-1].end() if idx else 0):m.start()].strip()[-90:]
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

def fetch(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=UA), timeout=30) as r:
                return r.read().decode("utf-8","replace")
        except Exception as e:
            if attempt == 2: raise
            time.sleep(4*(attempt+1))

def main(root="."):
    vpath = os.path.join(root,"values.json")
    with open(vpath,encoding="utf-8") as f: existing = json.load(f)
    by_id = {o["id"]: o for o in existing["items"]}
    known_by_cat = {}
    for o in existing["items"]:
        known_by_cat.setdefault(o["category"],[]).append(o["name"])
    changed = new = 0
    for url, cat, min_n in PAGES:
        try:
            page = fetch(url)
        except Exception as e:
            print(f"[scrape] FETCH FAILED {cat}: {e}", file=sys.stderr); sys.exit(2)
        parsed = parse_page(page, cat, sorted(known_by_cat.get(cat,[]), key=len, reverse=True))
        if len(parsed) < min_n:
            print(f"[scrape] ABORT: {cat} parsed only {len(parsed)} items (min {min_n})", file=sys.stderr); sys.exit(2)
        if any(not (0 < it["supreme"] <= 5_000_000) for it in parsed):
            print(f"[scrape] ABORT: insane value in {cat}", file=sys.stderr); sys.exit(2)
        known = set(known_by_cat.get(cat,[]))
        matched = sum(1 for it in parsed if it["name"] in known)
        if known and matched < 0.8*len([n for n in known if not by_id[slug(n)].get("placeholder")]):
            print(f"[scrape] ABORT: {cat} matched only {matched}/{len(known)} known items", file=sys.stderr); sys.exit(2)
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
    existing["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    body = '{\n"updatedAt": '+json.dumps(existing["updatedAt"])+',\n"items": [\n' + \
        ',\n'.join(json.dumps(o,separators=(",",":"),ensure_ascii=False) for o in existing["items"]) + '\n]\n}\n'
    with open(vpath,"w",encoding="utf-8") as f: f.write(body)
    print(f"[scrape] OK: {changed} item(s) updated, {new} new, {len(existing['items'])} total")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv)>1 else ".")
