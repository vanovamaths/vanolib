#!/usr/bin/env python3
"""
Collecte hebdomadaire arXiv (maths) pour VanoLib.

- Interroge l'API Atom arXiv via HTTPS.
- Réessaie proprement en cas d'erreur réseau temporaire.
- Refuse de terminer en succès si la collecte arXiv est globalement cassée.
- Fusionne les nouveaux articles dans site/data/<year>.json.
- Régénère manifest.json et un index latest.json léger pour l'accueil.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DATA = os.path.join(ROOT, "site", "data")

CATEGORIES = [
    "math.AC","math.AG","math.AP","math.AT","math.CA","math.CO","math.CT","math.CV",
    "math.DG","math.DS","math.FA","math.GM","math.GN","math.GR","math.GT","math.HO",
    "math.KT","math.LO","math.MG","math.MP","math.NA","math.NT","math.OA","math.OC",
    "math.PR","math.QA","math.RA","math.RT","math.SG","math.SP","math.ST","math-ph",
]

ARXIV_API = "https://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

LOOKBACK_DAYS = int(os.environ.get("VANOLIB_LOOKBACK_DAYS", "14"))
MAX_RESULTS_PER_CATEGORY = int(os.environ.get("VANOLIB_MAX_RESULTS", "500"))
LATEST_LIMIT = int(os.environ.get("VANOLIB_LATEST_LIMIT", "3000"))
REQUEST_PAUSE = float(os.environ.get("VANOLIB_REQUEST_PAUSE", "3.1"))
MAX_ATTEMPTS = int(os.environ.get("VANOLIB_MAX_ATTEMPTS", "3"))

USER_AGENT = "VanoLib/2.0 (+https://vanovamaths.github.io/vanolib/)"


def base_id(arxiv_id):
    return re.sub(r"v\d+$", "", str(arxiv_id or "").strip())


def request_bytes(url):
    last_exc = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=75) as resp:
                return resp.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
            status = getattr(exc, "code", None)
            retryable = status in (406, 408, 425, 429, 500, 502, 503, 504) or status is None
            if attempt >= MAX_ATTEMPTS or not retryable:
                break
            delay = min(18, 3 * attempt)
            print("    tentative %d/%d échouée (%s), nouvel essai dans %ss" % (
                attempt, MAX_ATTEMPTS, exc, delay
            ), file=sys.stderr)
            time.sleep(delay)
    raise last_exc


def fetch_recent(cat, start_date, end_date, max_results=MAX_RESULTS_PER_CATEGORY):
    q = "cat:%s AND submittedDate:[%s0000 TO %s2359]" % (
        cat,
        start_date.strftime("%Y%m%d"),
        end_date.strftime("%Y%m%d"),
    )
    params = {
        "search_query": q,
        "start": 0,
        "max_results": max_results,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    url = ARXIV_API + "?" + urllib.parse.urlencode(params)
    raw = request_bytes(url)
    root = ET.fromstring(raw)

    out = []
    for entry in root.findall("a:entry", NS):
        eid = entry.findtext("a:id", default="", namespaces=NS)
        match = re.search(r"/abs/(.+)$", eid)
        ext_id = match.group(1) if match else None
        if not ext_id:
            continue

        title = (entry.findtext("a:title", default="", namespaces=NS) or "").strip()
        title = re.sub(r"\s+", " ", title)
        authors = "; ".join(
            (a.findtext("a:name", default="", namespaces=NS) or "").strip()
            for a in entry.findall("a:author", NS)
        )
        primary = entry.find("arxiv:primary_category", NS)
        category = primary.get("term") if primary is not None else cat
        published = entry.findtext("a:published", default="", namespaces=NS)
        summary = re.sub(r"[ \t]+", " ", (entry.findtext("a:summary", default="", namespaces=NS) or "").strip())
        out.append([ext_id, title, authors, category, published[:10], summary])

    return out


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def shard_files():
    files = []
    for fname in os.listdir(SITE_DATA):
        if not fname.endswith(".json"):
            continue
        if fname in ("manifest.json", "latest.json"):
            continue
        if re.fullmatch(r"\d{4}\.json", fname):
            files.append(fname)
    return sorted(files)


def newest_key(rec):
    date = str(rec[4] or "") if len(rec) > 4 else ""
    return (date, str(rec[0] or ""))


def main():
    os.makedirs(SITE_DATA, exist_ok=True)

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=LOOKBACK_DAYS)

    new_records = []
    failed = []
    successful = 0

    print("Collecte arXiv du %s au %s" % (start.isoformat(), end.isoformat()))
    for cat in CATEGORIES:
        try:
            recs = fetch_recent(cat, start, end)
            successful += 1
            new_records.extend(recs)
            print("  %s: %d entrées" % (cat, len(recs)))
        except Exception as exc:
            failed.append((cat, str(exc)))
            print("  %s: FAILED (%s)" % (cat, exc), file=sys.stderr)
        time.sleep(REQUEST_PAUSE)

    if successful == 0:
        raise RuntimeError(
            "Aucune catégorie arXiv n'a pu être collectée. "
            "Le workflow s'arrête pour éviter un faux succès."
        )

    if len(failed) > 2:
        details = ", ".join("%s=%s" % item for item in failed[:6])
        raise RuntimeError(
            "%d catégories arXiv ont échoué (%s). "
            "Collecte considérée incomplète." % (len(failed), details)
        )

    dedup = {}
    for rec in new_records:
        key = base_id(rec[0])
        prev = dedup.get(key)
        if prev is None or rec[0] > prev[0]:
            dedup[key] = rec

    touched = {}
    added = 0
    updated = 0

    # abstracts are only kept for the newest papers (latest.json), not in the yearly shards
    abstracts = {base_id(r[0]): r[5] for r in load_json(os.path.join(SITE_DATA, "latest.json"), []) if len(r) > 5 and r[5]}
    for key, rec in dedup.items():
        if len(rec) > 5 and rec[5]:
            abstracts[key] = rec[5]
        rec = rec[:5]
        ext_id, title, authors, category, pub = rec
        year = (pub or "")[:4] or "unknown"
        path = os.path.join(SITE_DATA, "%s.json" % year)
        shard = touched.get(year)
        if shard is None:
            shard = load_json(path, [])
            touched[year] = shard

        idx = None
        for i, existing in enumerate(shard):
            if base_id(existing[0]) == key:
                idx = i
                break

        if idx is None:
            shard.append(rec)
            added += 1
        elif shard[idx] != rec:
            shard[idx] = rec
            updated += 1

    for year, shard in touched.items():
        shard.sort(key=newest_key, reverse=True)
        save_json(os.path.join(SITE_DATA, "%s.json" % year), shard)

    years = []
    category_counts = {}
    total = 0
    latest_candidates = []

    for fname in shard_files():
        path = os.path.join(SITE_DATA, fname)
        year = fname[:-5]
        shard = load_json(path, [])
        total += len(shard)
        years.append({
            "year": year,
            "count": len(shard),
            "bytes": os.path.getsize(path),
        })

        for rec in shard:
            if len(rec) < 5:
                continue
            category_counts[rec[3]] = category_counts.get(rec[3], 0) + 1
            if year >= str(end.year - 1):
                latest_candidates.append(rec)

    latest_candidates.sort(key=newest_key, reverse=True)
    latest = [rec[:5] + ([abstracts[base_id(rec[0])]] if base_id(rec[0]) in abstracts else [])
              for rec in latest_candidates[:LATEST_LIMIT]]
    save_json(os.path.join(SITE_DATA, "latest.json"), latest)

    years.sort(key=lambda item: item["year"], reverse=True)
    latest_date = latest[0][4] if latest else None
    manifest = {
        "schema": 3,
        "total": total,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_date": latest_date,
        "latest_count": len(latest),
        "years": years,
        "categories": sorted(
            [{"code": key, "count": value} for key, value in category_counts.items()],
            key=lambda item: (-item["count"], item["code"]),
        ),
    }
    save_json(os.path.join(SITE_DATA, "manifest.json"), manifest)

    print(
        "Nouveaux articles: %d, mis à jour: %d, total bibliothèque: %d, latest: %d"
        % (added, updated, total, len(latest))
    )



def build_search_index():
    """Rebuild the instant-search index used by the website (scripts/build_index.py)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_index
    build_index.main()

if __name__ == "__main__":
    try:
        main()
        build_search_index()
    except Exception as exc:
        print("ERREUR FATALE: %s" % exc, file=sys.stderr)
        sys.exit(1)
