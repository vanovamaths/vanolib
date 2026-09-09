#!/usr/bin/env python3
"""Collect open-access mathematics references from OpenAlex for VanoLib.

The collector stores compact metadata locally under site/data/openalex/<year>.json
so VanoLib can search and display these references without querying OpenAlex live.
Only metadata and lawful open-access links are stored; PDFs are not copied.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "site", "data", "openalex")
API = "https://api.openalex.org/works"
LOOKBACK_DAYS = int(os.environ.get("VANOLIB_OPENALEX_LOOKBACK_DAYS", "10"))
MAX_PAGES = int(os.environ.get("VANOLIB_OPENALEX_MAX_PAGES", "40"))
PER_PAGE = 200


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def request_json(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "VanoLib/2.0 open-mathematics-index",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)


def short_id(value):
    value = value or ""
    return value.rstrip("/").split("/")[-1]


def map_type(value):
    if value in ("book", "book-chapter", "reference-book"):
        return "book"
    if value in ("dissertation", "thesis"):
        return "thesis"
    if value == "preprint":
        return "preprint"
    return "article"


def choose_open_location(work):
    locations = []
    for key in ("best_oa_location", "primary_location"):
        loc = work.get(key)
        if loc:
            locations.append(loc)
    locations.extend(work.get("locations") or [])

    best = None
    for loc in locations:
        if not loc:
            continue
        if loc.get("is_oa") and loc.get("pdf_url"):
            best = loc
            break
    if best is None:
        for loc in locations:
            if loc and loc.get("is_oa"):
                best = loc
                break
    if best is None and locations:
        best = locations[0]
    best = best or {}
    source = best.get("source") or {}
    return {
        "landing": best.get("landing_page_url") or work.get("doi") or work.get("id") or "",
        "pdf": best.get("pdf_url") or "",
        "provider": source.get("display_name") or "Open-access source",
        "venue": source.get("display_name") or "",
        "license": best.get("license") or "",
    }


def compact_record(work):
    ids = work.get("ids") or {}
    # arXiv is already fully indexed by VanoLib; skip duplicates when OpenAlex exposes an arXiv ID.
    if ids.get("arxiv"):
        return None

    title = (work.get("title") or work.get("display_name") or "").strip()
    if not title:
        return None

    authors = []
    for auth in work.get("authorships") or []:
        author = auth.get("author") or {}
        name = (author.get("display_name") or "").strip()
        if name:
            authors.append(name)

    primary_topic = work.get("primary_topic") or {}
    topic = primary_topic.get("display_name") or "Mathematics"
    publication_date = work.get("publication_date") or ""
    year = str(work.get("publication_year") or (publication_date[:4] if publication_date else "unknown"))
    location = choose_open_location(work)
    doi = work.get("doi") or ""

    # Compact schema:
    # [id,title,authors,topic,date,type,venue,landing,pdf,doi,provider,license]
    rec = [
        short_id(work.get("id")),
        title,
        "; ".join(authors),
        topic,
        publication_date,
        map_type(work.get("type")),
        location["venue"],
        location["landing"],
        location["pdf"],
        doi,
        location["provider"],
        location["license"],
    ]
    return year, rec


def fetch_recent(start_date, end_date):
    filters = ",".join([
        "primary_topic.field.id:26",  # Mathematics in OpenAlex fields taxonomy
        "open_access.is_oa:true",
        "from_publication_date:%s" % start_date.isoformat(),
        "to_publication_date:%s" % end_date.isoformat(),
    ])
    cursor = "*"
    page = 0
    while cursor and page < MAX_PAGES:
        params = {
            "filter": filters,
            "sort": "publication_date:desc",
            "per-page": PER_PAGE,
            "cursor": cursor,
        }
        api_key = os.environ.get("OPENALEX_API_KEY", "").strip()
        if api_key:
            params["api_key"] = api_key
        url = API + "?" + urllib.parse.urlencode(params)
        payload = request_json(url)
        results = payload.get("results") or []
        if not results:
            break
        for work in results:
            yield work
        cursor = (payload.get("meta") or {}).get("next_cursor")
        page += 1
        print("  OpenAlex page %d: %d works" % (page, len(results)))
        time.sleep(0.15)


def regenerate_manifest():
    years = []
    total = 0
    providers = {}
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith(".json") or fname == "manifest.json":
            continue
        path = os.path.join(DATA_DIR, fname)
        rows = load_json(path, [])
        total += len(rows)
        years.append({"year": fname[:-5], "count": len(rows), "bytes": os.path.getsize(path)})
        for rec in rows:
            provider = rec[10] if len(rec) > 10 and rec[10] else "Open-access source"
            providers[provider] = providers.get(provider, 0) + 1
    years.sort(key=lambda x: x["year"], reverse=True)
    manifest = {
        "schema": 1,
        "source": "OpenAlex",
        "scope": "open-access mathematics, excluding arXiv duplicates",
        "total": total,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "years": years,
        "providers": sorted(
            [{"name": k, "count": v} for k, v in providers.items()],
            key=lambda x: -x["count"],
        )[:100],
    }
    save_json(os.path.join(DATA_DIR, "manifest.json"), manifest)
    return total


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=LOOKBACK_DAYS)
    by_year = {}

    fetched = 0
    for work in fetch_recent(start, end):
        fetched += 1
        packed = compact_record(work)
        if not packed:
            continue
        year, rec = packed
        by_year.setdefault(year, {})[rec[0]] = rec

    added = 0
    updated = 0
    for year, incoming in by_year.items():
        path = os.path.join(DATA_DIR, "%s.json" % year)
        existing = load_json(path, [])
        by_id = {row[0]: row for row in existing if row}
        for work_id, rec in incoming.items():
            if work_id not in by_id:
                added += 1
            elif by_id[work_id] != rec:
                updated += 1
            by_id[work_id] = rec
        merged = list(by_id.values())
        merged.sort(key=lambda r: (r[4] or "", r[0]), reverse=True)
        save_json(path, merged)

    total = regenerate_manifest()
    print("OpenAlex fetched: %d, added: %d, updated: %d, stored total: %d" % (fetched, added, updated, total))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("OpenAlex collector failed: %s" % exc, file=sys.stderr)
        raise
