#!/usr/bin/env python3
"""
Collecte hebdomadaire arXiv (maths) pour VanoLib.
Interroge l'API arXiv pour les soumissions récentes dans les catégories math.*,
fusionne dans les shards JSON existants (site/data/<year>.json), et régénère
site/data/manifest.json. Conçu pour tourner sans dépendance externe (urllib only)
dans une GitHub Action hebdomadaire.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

SITE_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "data")

CATEGORIES = [
    "math.AG","math.AP","math.AT","math.CA","math.CO","math.CT","math.CV","math.DG",
    "math.DS","math.FA","math.GM","math.GN","math.GR","math.GT","math.HO","math.KT",
    "math.LO","math.MG","math.MP","math.NA","math.NT","math.OA","math.OC","math.PR",
    "math.QA","math.RA","math.RT","math.SG","math.SP","math.ST","math-ph",
]

ARXIV_API = "http://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

LOOKBACK_DAYS = int(os.environ.get("VANOLIB_LOOKBACK_DAYS", "10"))


def fetch_recent(cat, start_date, end_date, max_results=300):
    q = "cat:%s AND submittedDate:[%s0000 TO %s2359]" % (
        cat, start_date.strftime("%Y%m%d"), end_date.strftime("%Y%m%d")
    )
    params = {
        "search_query": q,
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    url = ARXIV_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "VanoLib-Site/1.0 (research use)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    out = []
    for entry in root.findall("a:entry", NS):
        eid = entry.findtext("a:id", default="", namespaces=NS)
        m = re.search(r"abs/(.+)$", eid)
        ext_id = m.group(1) if m else None
        if not ext_id:
            continue
        title = (entry.findtext("a:title", default="", namespaces=NS) or "").strip().replace("\n", " ")
        title = re.sub(r"\s+", " ", title)
        authors = "; ".join(
            a.findtext("a:name", default="", namespaces=NS)
            for a in entry.findall("a:author", NS)
        )
        primary = entry.find("arxiv:primary_category", NS)
        category = primary.get("term") if primary is not None else cat
        published = entry.findtext("a:published", default="", namespaces=NS)
        out.append([ext_id, title, authors, category, published[:10]])
    return out


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def main():
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=LOOKBACK_DAYS)

    new_records = []
    for cat in CATEGORIES:
        try:
            recs = fetch_recent(cat, start, end)
            new_records.extend(recs)
            print("  %s: %d entries" % (cat, len(recs)))
        except Exception as exc:
            print("  %s: FAILED (%s)" % (cat, exc), file=sys.stderr)
        time.sleep(3)  # be polite to arXiv API rate limits

    by_id = {}
    for rec in new_records:
        base_id = rec[0].split("v")[0]
        prev = by_id.get(base_id)
        if prev is None or rec[0] > prev[0]:
            by_id[base_id] = rec

    added = 0
    updated = 0
    by_year_touched = {}
    for base_id, rec in by_id.items():
        ext_id, title, authors, category, pub = rec
        year = (pub or "")[:4] or "unknown"
        path = os.path.join(SITE_DATA, "%s.json" % year)
        shard = load_json(path, [])
        idx = None
        for i, existing in enumerate(shard):
            if existing[0].split("v")[0] == base_id:
                idx = i
                break
        if idx is None:
            shard.insert(0, rec)
            added += 1
        else:
            if shard[idx][0] != ext_id:
                shard[idx] = rec
                updated += 1
        by_year_touched[year] = shard

    for year, shard in by_year_touched.items():
        save_json(os.path.join(SITE_DATA, "%s.json" % year), shard)

    # regenerate manifest from all shard files on disk
    years = []
    cat_counts = {}
    total = 0
    for fname in sorted(os.listdir(SITE_DATA)):
        if not fname.endswith(".json") or fname == "manifest.json":
            continue
        year = fname[:-5]
        shard = load_json(os.path.join(SITE_DATA, fname), [])
        total += len(shard)
        years.append({"year": year, "count": len(shard), "bytes": os.path.getsize(os.path.join(SITE_DATA, fname))})
        for rec in shard:
            cat_counts[rec[3]] = cat_counts.get(rec[3], 0) + 1

    years.sort(key=lambda y: y["year"], reverse=True)
    manifest = {
        "total": total,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "years": years,
        "categories": sorted(
            [{"code": k, "count": v} for k, v in cat_counts.items()],
            key=lambda x: -x["count"],
        ),
    }
    save_json(os.path.join(SITE_DATA, "manifest.json"), manifest)

    print("Nouveaux articles: %d, mis à jour: %d, total bibliothèque: %d" % (added, updated, total))


if __name__ == "__main__":
    main()
