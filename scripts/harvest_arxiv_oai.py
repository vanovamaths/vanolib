#!/usr/bin/env python3
"""
VanoLib arXiv OAI-PMH harvester.

Purpose
-------
Mirror arXiv descriptive metadata into static monthly JSON shards that GitHub
Pages can serve directly. This intentionally does NOT redistribute PDFs; VanoLib
links/embeds PDFs from arxiv.org.

Modes
-----
recent   Incrementally refresh recent/modified records and latest.json.
backfill Resume a complete all-arXiv harvest using OAI-PMH resumptionToken.

The OAI-PMH endpoint is the official arXiv metadata synchronization interface.
Requests are serialized and spaced >= 3 seconds apart.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "site" / "data" / "arxiv"
STATE_PATH = DATA_DIR / "state.json"
MANIFEST_PATH = DATA_DIR / "manifest.json"
LATEST_PATH = DATA_DIR / "latest.json"

BASE_URL = "https://oaipmh.arxiv.org/oai"
USER_AGENT = "VanoLib/3.0 (+https://vanovamaths.github.io/vanolib/)"
REQUEST_INTERVAL = float(os.environ.get("VANOLIB_OAI_INTERVAL", "3.2"))
MAX_ATTEMPTS = int(os.environ.get("VANOLIB_OAI_ATTEMPTS", "4"))

NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "arxiv": "http://arxiv.org/OAI/arXiv/",
}


def compact_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def base_id(value: str) -> str:
    return re.sub(r"v\d+$", "", value or "")


def author_name(node: ET.Element) -> str:
    forenames = clean_text(node.findtext("arxiv:forenames", default="", namespaces=NS))
    keyname = clean_text(node.findtext("arxiv:keyname", default="", namespaces=NS))
    suffix = clean_text(node.findtext("arxiv:suffix", default="", namespaces=NS))
    name = " ".join(x for x in (forenames, keyname, suffix) if x)
    return name or "Unknown author"


class RateLimitedClient:
    def __init__(self):
        self.last_request = 0.0

    def get(self, params: dict[str, str]) -> bytes:
        query = urllib.parse.urlencode(params)
        url = BASE_URL + "?" + query
        last_error = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
            elapsed = time.monotonic() - self.last_request
            if elapsed < REQUEST_INTERVAL:
                time.sleep(REQUEST_INTERVAL - elapsed)

            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.5",
                },
            )
            try:
                self.last_request = time.monotonic()
                with urllib.request.urlopen(req, timeout=90) as response:
                    return response.read()
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                last_error = exc
                status = getattr(exc, "code", None)
                retryable = status in (408, 425, 429, 500, 502, 503, 504) or status is None
                if not retryable or attempt == MAX_ATTEMPTS:
                    break
                delay = max(REQUEST_INTERVAL, min(30.0, attempt * 5.0))
                print(
                    f"Request failed ({exc}); retry {attempt}/{MAX_ATTEMPTS} in {delay:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(delay)

        raise RuntimeError(f"arXiv OAI request failed: {last_error}")


def parse_page(raw: bytes):
    root = ET.fromstring(raw)
    error = root.find("oai:error", NS)
    if error is not None:
        code = error.attrib.get("code", "unknown")
        message = clean_text(error.text)
        raise RuntimeError(f"OAI error {code}: {message}")

    rows = []
    latest_rows = []
    last_datestamp = None

    for record in root.findall(".//oai:record", NS):
        header = record.find("oai:header", NS)
        if header is None:
            continue

        datestamp = clean_text(header.findtext("oai:datestamp", default="", namespaces=NS))
        if datestamp:
            last_datestamp = datestamp

        if header.attrib.get("status") == "deleted":
            continue

        meta = record.find("oai:metadata/arxiv:arXiv", NS)
        if meta is None:
            continue

        arxiv_id = base_id(clean_text(meta.findtext("arxiv:id", default="", namespaces=NS)))
        created = clean_text(meta.findtext("arxiv:created", default="", namespaces=NS))
        title = clean_text(meta.findtext("arxiv:title", default="", namespaces=NS))
        categories_raw = clean_text(meta.findtext("arxiv:categories", default="", namespaces=NS))
        categories = categories_raw.split()
        primary = categories[0] if categories else "unknown"
        abstract = clean_text(meta.findtext("arxiv:abstract", default="", namespaces=NS))

        if not arxiv_id or not created or not title:
            continue

        author_nodes = meta.findall("arxiv:authors/arxiv:author", NS)
        authors = "; ".join(author_name(node) for node in author_nodes)

        row = [arxiv_id, title, authors, primary, created[:10]]
        rows.append(row)
        latest_rows.append(row + [abstract])

    token_node = root.find(".//oai:resumptionToken", NS)
    token = clean_text(token_node.text) if token_node is not None else ""
    return rows, latest_rows, token or None, last_datestamp


def shard_key(row) -> str:
    created = str(row[4] or "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", created):
        return created[:7]
    year = created[:4] if re.fullmatch(r"\d{4}.*", created) else "unknown"
    return f"{year}-00"


def shard_path(key: str) -> Path:
    return DATA_DIR / f"{key}.json"


def default_state():
    return {
        "schema": 1,
        "source": "arXiv OAI-PMH",
        "backfill_complete": False,
        "backfill_token": None,
        "backfill_checkpoint": None,
        "backfill_pages": 0,
        "backfill_records_seen": 0,
        "last_backfill_run": None,
        "last_recent_run": None,
        "shards": {},
    }


def load_state():
    state = read_json(STATE_PATH, default_state())
    base = default_state()
    base.update(state if isinstance(state, dict) else {})
    if not isinstance(base.get("shards"), dict):
        base["shards"] = {}
    return base


def shard_stats(rows):
    cats = Counter()
    for row in rows:
        if len(row) >= 4:
            cats[str(row[3] or "unknown")] += 1
    return {"count": len(rows), "categories": dict(cats)}


def merge_rows(incoming_rows, state):
    grouped = defaultdict(dict)
    for row in incoming_rows:
        grouped[shard_key(row)][base_id(str(row[0]))] = row[:5]

    inserted = 0
    updated = 0

    for key, incoming in grouped.items():
        path = shard_path(key)
        existing = read_json(path, [])
        by_id = {base_id(str(row[0])): row[:5] for row in existing if row}

        for rid, row in incoming.items():
            old = by_id.get(rid)
            if old is None:
                inserted += 1
            elif old != row:
                updated += 1
            by_id[rid] = row

        merged = list(by_id.values())
        merged.sort(key=lambda r: (str(r[4]), str(r[0])), reverse=True)
        compact_json(path, merged)
        state["shards"][key] = shard_stats(merged)

    return inserted, updated


def refresh_missing_stats(state):
    known = state["shards"]
    for path in sorted(DATA_DIR.glob("????-??.json")):
        key = path.stem
        if key not in known:
            known[key] = shard_stats(read_json(path, []))


def build_manifest(state):
    refresh_missing_stats(state)

    years = defaultdict(lambda: {"count": 0, "months": []})
    categories = Counter()
    total = 0

    for key, stats in state["shards"].items():
        if not re.fullmatch(r"\d{4}-\d{2}", key):
            continue
        year = key[:4]
        count = int(stats.get("count", 0))
        total += count
        years[year]["count"] += count
        years[year]["months"].append(key)
        categories.update({k: int(v) for k, v in stats.get("categories", {}).items()})

    year_rows = []
    for year in sorted(years.keys(), reverse=True):
        months = sorted(years[year]["months"], reverse=True)
        year_rows.append({"year": year, "count": years[year]["count"], "months": months})

    latest = read_json(LATEST_PATH, [])
    latest_date = latest[0][4] if latest else None

    manifest = {
        "schema": 3,
        "source": "arXiv OAI-PMH",
        "scope": "all arXiv",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": total,
        "latest_date": latest_date,
        "backfill_complete": bool(state.get("backfill_complete")),
        "backfill_pages": int(state.get("backfill_pages", 0)),
        "backfill_records_seen": int(state.get("backfill_records_seen", 0)),
        "years": year_rows,
        "categories": [
            {"code": code, "count": count}
            for code, count in sorted(categories.items(), key=lambda x: (-x[1], x[0]))
        ],
    }
    compact_json(MANIFEST_PATH, manifest)
    compact_json(STATE_PATH, state)
    return manifest


def fetch_sequence(client, initial_params, max_pages=None, require_complete=False):
    params = dict(initial_params)
    rows = []
    latest_rows = []
    pages = 0
    token = None
    last_datestamp = None

    while True:
        raw = client.get(params)
        page_rows, page_latest, token, datestamp = parse_page(raw)
        rows.extend(page_rows)
        latest_rows.extend(page_latest)
        pages += 1
        if datestamp:
            last_datestamp = datestamp

        print(
            f"page {pages}: {len(page_rows)} records; total this run={len(rows)}; "
            f"resume={'yes' if token else 'no'}"
        )

        if not token:
            break
        if max_pages is not None and pages >= max_pages:
            if require_complete:
                raise RuntimeError(
                    f"Recent synchronization exceeded max_pages={max_pages}; "
                    "increase the limit to avoid publishing an incomplete refresh."
                )
            break
        params = {"verb": "ListRecords", "resumptionToken": token}

    return rows, latest_rows, token, last_datestamp, pages


def run_recent(args):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    client = RateLimitedClient()

    from_date = (date.today() - timedelta(days=args.lookback_days)).isoformat()
    print(f"Recent all-arXiv sync from OAI datestamp {from_date}")

    rows, rich_rows, token, last_datestamp, pages = fetch_sequence(
        client,
        {
            "verb": "ListRecords",
            "metadataPrefix": "arXiv",
            "from": from_date,
        },
        max_pages=args.max_pages,
        require_complete=True,
    )

    inserted, updated = merge_rows(rows, state)

    rich_by_id = {}
    for row in rich_rows:
        rich_by_id[base_id(str(row[0]))] = row
    latest = list(rich_by_id.values())
    latest.sort(key=lambda r: (str(r[4]), str(r[0])), reverse=True)
    latest = latest[: args.latest_limit]
    compact_json(LATEST_PATH, latest)

    state["last_recent_run"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = build_manifest(state)

    print(
        f"Recent sync complete: pages={pages}, fetched={len(rows)}, "
        f"inserted={inserted}, updated={updated}, mirrored={manifest['total']}"
    )


def run_backfill(args):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()

    if state.get("backfill_complete"):
        print("Full arXiv backfill already complete; nothing to do.")
        build_manifest(state)
        return

    client = RateLimitedClient()
    token = state.get("backfill_token")

    if token:
        params = {"verb": "ListRecords", "resumptionToken": token}
        print("Resuming full all-arXiv backfill from saved resumptionToken.")
    else:
        checkpoint = state.get("backfill_checkpoint")
        params = {"verb": "ListRecords", "metadataPrefix": "arXiv"}
        if checkpoint:
            try:
                checkpoint_date = datetime.strptime(checkpoint[:10], "%Y-%m-%d").date()
                params["from"] = (checkpoint_date - timedelta(days=1)).isoformat()
                print(f"Restarting from safe checkpoint {params['from']}.")
            except ValueError:
                pass
        else:
            print("Starting complete all-arXiv OAI harvest from the beginning.")

    try:
        rows, _, next_token, last_datestamp, pages = fetch_sequence(
            client, params, max_pages=args.max_pages, require_complete=False
        )
    except RuntimeError as exc:
        if token and "badResumptionToken" in str(exc):
            print("Saved resumptionToken expired; restarting from checkpoint.", file=sys.stderr)
            state["backfill_token"] = None
            compact_json(STATE_PATH, state)
            return run_backfill(args)
        raise

    inserted, updated = merge_rows(rows, state)

    state["backfill_token"] = next_token
    if last_datestamp:
        state["backfill_checkpoint"] = last_datestamp
    state["backfill_pages"] = int(state.get("backfill_pages", 0)) + pages
    state["backfill_records_seen"] = int(state.get("backfill_records_seen", 0)) + len(rows)
    state["last_backfill_run"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not next_token:
        state["backfill_complete"] = True

    manifest = build_manifest(state)

    print(
        f"Backfill batch complete: pages={pages}, fetched={len(rows)}, "
        f"inserted={inserted}, updated={updated}, mirrored={manifest['total']}, "
        f"complete={state['backfill_complete']}"
    )


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)

    recent = sub.add_parser("recent")
    recent.add_argument("--lookback-days", type=int, default=21)
    recent.add_argument("--max-pages", type=int, default=180)
    recent.add_argument("--latest-limit", type=int, default=5000)
    recent.set_defaults(func=run_recent)

    backfill = sub.add_parser("backfill")
    backfill.add_argument("--max-pages", type=int, default=180)
    backfill.set_defaults(func=run_backfill)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
