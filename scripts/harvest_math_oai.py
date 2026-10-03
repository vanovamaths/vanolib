#!/usr/bin/env python3
"""
VanoLib — complete arXiv mathematics harvest (OAI-PMH), resumable.

Why OAI-PMH: it is arXiv's official bulk-metadata interface. One request returns up to
1 000 records (vs. ~100 useful ones per search-API call), it walks the *whole* archive in
datestamp order with a resumption token, and it is the method arXiv asks harvesters to use.
A complete pass over math + math-ph (~700k records incl. cross-lists) takes ~1–2 h.

    python3 scripts/harvest_math_oai.py full            # everything since 1992 (resumes if interrupted)
    python3 scripts/harvest_math_oai.py recent --days 7 # incremental update
    python3 scripts/harvest_math_oai.py status

Output (same formats as the rest of the site):
    site/data/YYYY.json   rows [id, title, authors, category, date]   (merged by arXiv id)
    site/data/latest.json newest 3 000 papers, with abstracts
    site/data/manifest.json, then the instant-search index (scripts/build_index.py)
Progress is saved in scripts/oai_state.json every few pages, so Ctrl-C / sleep / network
errors never lose work: just run the same command again.
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
STATE = os.path.join(ROOT, "scripts", "oai_state.json")
ENDPOINTS = ["https://oaipmh.arxiv.org/oai", "https://export.arxiv.org/oai2"]
UA = "VanoLib/3.0 (open math library; https://vanovamaths.github.io/vanolib/)"
PAUSE = float(os.environ.get("VANOLIB_OAI_PAUSE", "3"))      # arXiv etiquette: ≥ 3 s between requests
FLUSH_EVERY = int(os.environ.get("VANOLIB_OAI_FLUSH", "40"))  # pages between checkpoints
LATEST_LIMIT = 3000
NS = {"o": "http://www.openarchives.org/OAI/2.0/", "a": "http://arxiv.org/OAI/arXiv/"}

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    CTX = ssl.create_default_context()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def base_id(i):
    return re.sub(r"v\d+$", "", str(i or ""))


def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


# ── HTTP with OAI flow control (503 + Retry-After) ──────────────────────────
class Client:
    def __init__(self):
        self.endpoint = None
        self.last = 0.0

    def get(self, params):
        endpoints = [self.endpoint] if self.endpoint else ENDPOINTS
        err = None
        for attempt in range(8):
            for ep in endpoints:
                wait = PAUSE - (time.time() - self.last)
                if wait > 0:
                    time.sleep(wait)
                url = ep + "?" + urllib.parse.urlencode(params)
                try:
                    self.last = time.time()
                    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}),
                                                timeout=180, context=CTX) as r:
                        body = r.read()
                    self.endpoint = ep
                    return body
                except urllib.error.HTTPError as e:
                    err = e
                    if e.code == 503:
                        delay = int(e.headers.get("Retry-After") or 10)
                        log(f"  arXiv asks to wait {delay}s (flow control)")
                        time.sleep(min(delay, 120))
                    elif e.code in (429, 500, 502, 504):
                        time.sleep(10 * (attempt + 1))
                    elif e.code in (400, 404) and not self.endpoint:
                        continue          # try the other endpoint
                    else:
                        raise
                except Exception as e:     # network hiccup
                    err = e
                    time.sleep(min(60, 5 * (attempt + 1)))
        raise RuntimeError(f"OAI request failed: {err}")


def oai_root(raw):
    root = ET.fromstring(raw)
    e = root.find("o:error", NS)
    if e is not None and e.get("code") != "noRecordsMatch":
        raise RuntimeError(f"OAI error {e.get('code')}: {clean(e.text)}")
    return root


def math_sets(client):
    """Find the set specs for mathematics and math-ph (spec names differ between endpoints)."""
    specs, token = [], None
    while True:
        root = oai_root(client.get({"verb": "ListSets", **({"resumptionToken": token} if token else {})}))
        for s in root.iter("{%s}set" % NS["o"]):
            specs.append(s.findtext("o:setSpec", default="", namespaces=NS))
        t = root.find(".//o:resumptionToken", NS)
        token = clean(t.text) if t is not None else ""
        if not token:
            break
    want = [s for s in specs if s == "math" or s.endswith("math-ph") or s == "math-ph"]
    if not any(s == "math" for s in want):
        want = [s for s in specs if s.split(":")[0] == "math"][:1] + want
    if not want:
        raise RuntimeError(f"No math set found in {specs[:20]}…")
    return sorted(set(want))


def is_math(c):
    return c.startswith("math.") or c == "math-ph"


def parse(raw):
    """→ (rows, abstracts, resumption token, complete size)"""
    root = oai_root(raw)
    rows, abstracts = [], {}
    for rec in root.iter("{%s}record" % NS["o"]):
        h = rec.find("o:header", NS)
        if h is None or h.get("status") == "deleted":
            continue
        m = rec.find("o:metadata/a:arXiv", NS)
        if m is None:
            continue
        aid = clean(m.findtext("a:id", default="", namespaces=NS))
        if not aid:
            continue
        cats = clean(m.findtext("a:categories", default="", namespaces=NS)).split()
        cat = cats[0] if cats else "math.GM"
        if not is_math(cat):                       # cross-list: show it under its math category
            cat = next((c for c in cats if is_math(c)), cat)
        names = []
        for au in m.findall("a:authors/a:author", NS):
            first = clean(au.findtext("a:forenames", default="", namespaces=NS))
            last = clean(au.findtext("a:keyname", default="", namespaces=NS))
            suf = clean(au.findtext("a:suffix", default="", namespaces=NS))
            names.append(" ".join(x for x in (first, last, suf) if x))
        created = clean(m.findtext("a:created", default="", namespaces=NS))[:10]
        rows.append([aid, clean(m.findtext("a:title", default="", namespaces=NS)), "; ".join(names), cat, created])
        ab = clean(m.findtext("a:abstract", default="", namespaces=NS))
        if ab:
            abstracts[aid] = ab
    stamps = [clean(d.text) for d in root.iter("{%s}datestamp" % NS["o"]) if d.text]
    t = root.find(".//o:resumptionToken", NS)
    token = clean(t.text) if t is not None and t.text else ""
    size = int(t.get("completeListSize") or 0) if t is not None and t.get("completeListSize") else 0
    return rows, abstracts, token, size, max(stamps) if stamps else None


# ── storage ─────────────────────────────────────────────────────────────────
class Library:
    def __init__(self):
        os.makedirs(DATA, exist_ok=True)
        self.rows = {}
        for fn in os.listdir(DATA):
            if re.fullmatch(r"\d{4}\.json", fn):
                for r in load(os.path.join(DATA, fn), []):
                    if r and r[0]:
                        self.merge(r[:5])
        self.abstracts = {base_id(r[0]): r[5] for r in load(os.path.join(DATA, "latest.json"), []) if len(r) > 5}
        self.added = self.updated = 0
        log(f"Library loaded: {len(self.rows)} papers")

    def merge(self, r):
        k = base_id(r[0])
        old = self.rows.get(k)
        if old is None:
            self.rows[k] = r
            return 1
        new = [old[0] if len(str(old[0])) >= len(str(r[0])) else r[0],   # keep the versioned id if we have one
               r[1] or old[1], r[2] or old[2], r[3] or old[3], old[4] or r[4]]
        if new != old:
            self.rows[k] = new
            return 2
        return 0

    def add(self, rows, abstracts):
        for r in rows:
            s = self.merge(r)
            self.added += s == 1
            self.updated += s == 2
        for aid, ab in abstracts.items():
            self.abstracts[base_id(aid)] = ab

    def flush(self):
        years = {}
        for r in self.rows.values():
            years.setdefault((r[4] or "0000")[:4], []).append(r)
        for y, rs in years.items():
            rs.sort(key=lambda r: (r[4], r[0]), reverse=True)
            save(os.path.join(DATA, f"{y}.json"), rs)
        newest = sorted(self.rows.values(), key=lambda r: (r[4], r[0]), reverse=True)[:LATEST_LIMIT]
        save(os.path.join(DATA, "latest.json"),
             [r + ([self.abstracts[base_id(r[0])]] if base_id(r[0]) in self.abstracts else []) for r in newest])
        keep = {base_id(r[0]) for r in newest}
        self.abstracts = {k: v for k, v in self.abstracts.items() if k in keep}   # keep memory small
        cats = {}
        for r in self.rows.values():
            cats[r[3]] = cats.get(r[3], 0) + 1
        save(os.path.join(DATA, "manifest.json"), {
            "schema": 3, "total": len(self.rows),
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_date": newest[0][4] if newest else None, "latest_count": len(newest),
            "years": sorted([{"year": y, "count": len(rs), "bytes": os.path.getsize(os.path.join(DATA, f"{y}.json"))}
                             for y, rs in years.items()], key=lambda x: x["year"], reverse=True),
            "categories": sorted([{"code": c, "count": n} for c, n in cats.items()], key=lambda x: (-x["count"], x["code"])),
        })


# ── harvest ─────────────────────────────────────────────────────────────────
def harvest(mode, days=7):
    client, lib = Client(), Library()
    state = load(STATE, {})
    if mode == "full" and state.get("mode") == "full" and not state.get("done"):
        log(f"Resuming full harvest — set {state['set']}, page {state['page']}")
    else:
        state = {"mode": mode, "sets": math_sets(client), "set_i": 0, "token": None, "page": 0, "done": False,
                 "from": None if mode == "full" else (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d"),
                 "started": datetime.now(timezone.utc).isoformat()}
    log(f"Sets: {state['sets']}")
    t0, pages_run = time.time(), 0
    while state["set_i"] < len(state["sets"]):
        spec = state["set"] = state["sets"][state["set_i"]]
        if state["token"]:
            params = {"verb": "ListRecords", "resumptionToken": state["token"]}
        else:
            params = {"verb": "ListRecords", "metadataPrefix": "arXiv", "set": spec}
            start = state.get("resume_from") or state["from"]
            if start:
                params["from"] = start
        try:
            rows, abstracts, token, size, stamp = parse(client.get(params))
        except RuntimeError as e:
            if "badResumptionToken" in str(e) and state["token"]:
                # tokens expire after a pause: restart this set from the last datestamp reached
                log(f"  resumption token expired → restarting {spec} from {state.get('last_ds')}")
                state["token"], state["resume_from"] = None, state.get("last_ds")
                continue
            raise
        if stamp:
            state["last_ds"] = max(stamp, state.get("last_ds") or "")
        lib.add(rows, abstracts)
        state["page"] += 1
        pages_run += 1
        state["token"] = token or None
        if size:
            state["size"] = size
        done_n = state["page"] * 1000
        eta = ""
        if state.get("size") and pages_run > 2:
            per = (time.time() - t0) / pages_run
            eta = f" · ETA {max(0, (state['size'] - done_n) / 1000 * per) / 60:.0f} min"
        log(f"{spec} page {state['page']}: +{len(rows)} records (new {lib.added}, updated {lib.updated}){eta}")
        if not token:                                   # this set is finished
            state["set_i"] += 1
            state["page"] = 0
            state["token"] = state["resume_from"] = state["last_ds"] = None
            state.pop("size", None)
        if pages_run % FLUSH_EVERY == 0 or not token:
            lib.flush()
            save(STATE, state)
            log(f"  ✓ checkpoint saved ({len(lib.rows)} papers)")
    state["done"] = True
    state["finished"] = datetime.now(timezone.utc).isoformat()
    lib.flush()
    save(STATE, state)
    log(f"Harvest complete: {len(lib.rows)} papers · {lib.added} new · {lib.updated} updated")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_index
    build_index.main()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("full", help="harvest all of arXiv math + math-ph since the beginning (resumable)")
    r = sub.add_parser("recent", help="incremental update")
    r.add_argument("--days", type=int, default=7)
    sub.add_parser("status", help="show saved progress")
    a = ap.parse_args()
    if a.cmd == "status":
        print(json.dumps(load(STATE, {"state": "never run"}), indent=2))
    else:
        harvest(a.cmd, getattr(a, "days", 7))


if __name__ == "__main__":
    main()
