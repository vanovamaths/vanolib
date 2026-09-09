#!/usr/bin/env python3
"""Harvest open mathematics metadata into VanoLib local JSON shards.

Sources harvested here:
- HAL (REST API)
- DOAJ (public search API)
- DOAB (OAI-PMH)
- Zenodo (OAI-PMH)
- NUMDAM (OAI-PMH)
- Project Euclid (OAI-PMH)

The collector stores metadata and lawful open-access links only. It does not mirror
or bulk-download PDFs. Existing arXiv/OpenAlex collectors remain separate.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ROOT = os.path.join(ROOT, "site", "data", "sources")
LOOKBACK_DAYS = int(os.environ.get("VANOLIB_SOURCES_LOOKBACK_DAYS", "10"))
INITIAL_LOOKBACK_DAYS = int(os.environ.get("VANOLIB_SOURCES_INITIAL_LOOKBACK_DAYS", "90"))
MAX_PAGES = int(os.environ.get("VANOLIB_SOURCES_MAX_PAGES", "30"))
USER_AGENT = "VanoLib/2.1 open-mathematics-harvester"

MATH_TERMS = (
    "mathemat", "algebra", "geometry", "topology", "number theory", "combinator",
    "probability", "statistics", "analysis", "differential equation", "operator algebra",
    "representation theory", "symplectic", "poisson", "category theory", "logic",
    "dynamical system", "optimization", "k-theory", "spectral theory", "metric geometry"
)

OAI_NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def request_bytes(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def request_json(url, timeout=90):
    return json.loads(request_bytes(url, timeout).decode("utf-8"))


def text(v):
    if isinstance(v, list):
        return "; ".join(str(x).strip() for x in v if str(x).strip())
    return str(v or "").strip()


def first(v):
    if isinstance(v, list):
        return v[0] if v else ""
    return v or ""


def clean(s):
    return re.sub(r"\s+", " ", text(s)).strip()


def extract_date(values):
    vals = values if isinstance(values, list) else [values]
    for v in vals:
        m = re.search(r"(19|20)\d{2}-\d{2}-\d{2}", str(v or ""))
        if m:
            return m.group(0)
    for v in vals:
        m = re.search(r"(19|20)\d{2}", str(v or ""))
        if m:
            return m.group(0) + "-01-01"
    return ""


def normalize_doi(v):
    s = text(v).strip()
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s, flags=re.I)
    return s if s.lower().startswith("10.") else ""


def math_related(*parts):
    hay = " ".join(text(p) for p in parts).lower()
    return any(term in hay for term in MATH_TERMS)


def map_type(v, default="article"):
    s = text(v).lower()
    if "book" in s or "monograph" in s:
        return "book"
    if "thesis" in s or "dissertation" in s:
        return "thesis"
    if "preprint" in s or "working paper" in s:
        return "preprint"
    return default


def compact(source, rid, title, authors, topic, date, doc_type, venue, landing, pdf, doi, provider, license_name):
    title = clean(title)
    if not title:
        return None
    rid = clean(rid) or normalize_doi(doi) or re.sub(r"\W+", "-", title.lower())[:100]
    date = extract_date(date)
    year = date[:4] if date else "unknown"
    row = [
        source, rid, title, clean(authors), clean(topic) or "Mathematics", date,
        map_type(doc_type), clean(venue), text(landing), text(pdf), normalize_doi(doi),
        clean(provider) or source.upper(), clean(license_name),
    ]
    return year, row


def merge_source(source, packed_rows):
    source_dir = os.path.join(DATA_ROOT, source)
    os.makedirs(source_dir, exist_ok=True)
    by_year = {}
    for year, row in packed_rows:
        by_year.setdefault(year, []).append(row)

    added = updated = 0
    for year, incoming in by_year.items():
        path = os.path.join(source_dir, "%s.json" % year)
        existing = load_json(path, [])
        by_key = {}
        for row in existing:
            if not row:
                continue
            key = (row[10].lower() if len(row) > 10 and row[10] else row[1])
            by_key[key] = row
        for row in incoming:
            key = row[10].lower() if row[10] else row[1]
            old = by_key.get(key)
            if old is None:
                added += 1
            elif old != row:
                updated += 1
            by_key[key] = row
        merged = list(by_key.values())
        merged.sort(key=lambda r: (r[5] or "", r[1]), reverse=True)
        save_json(path, merged)
    return added, updated


def source_is_empty(source):
    d = os.path.join(DATA_ROOT, source)
    if not os.path.isdir(d):
        return True
    return not any(name.endswith(".json") and name != "manifest.json" for name in os.listdir(d))


def period_for(source):
    days = INITIAL_LOOKBACK_DAYS if source_is_empty(source) else LOOKBACK_DAYS
    end = datetime.now(timezone.utc).date()
    return end - timedelta(days=days), end


def oai_values(meta, tag):
    return [clean(el.text) for el in meta.findall("dc:" + tag, OAI_NS) if clean(el.text)]


def harvest_oai(source, base_url, filter_math=False, provider=None, max_pages=None):
    start, _ = period_for(source)
    params = {"verb": "ListRecords", "metadataPrefix": "oai_dc", "from": start.isoformat()}
    page = 0
    out = []
    limit = max_pages or MAX_PAGES
    while page < limit:
        url = base_url + ("&" if "?" in base_url else "?") + urllib.parse.urlencode(params)
        root = ET.fromstring(request_bytes(url))
        records = root.findall(".//oai:record", OAI_NS)
        for rec in records:
            header = rec.find("oai:header", OAI_NS)
            if header is None or header.get("status") == "deleted":
                continue
            rid = clean(header.findtext("oai:identifier", default="", namespaces=OAI_NS))
            meta = rec.find("oai:metadata/*")
            if meta is None:
                continue
            titles = oai_values(meta, "title")
            creators = oai_values(meta, "creator")
            subjects = oai_values(meta, "subject")
            descriptions = oai_values(meta, "description")
            dates = oai_values(meta, "date")
            types = oai_values(meta, "type")
            identifiers = oai_values(meta, "identifier")
            publishers = oai_values(meta, "publisher")
            sources = oai_values(meta, "source")
            rights = oai_values(meta, "rights")
            if filter_math and not math_related(titles, subjects, descriptions):
                continue
            landing = ""
            pdf = ""
            doi = ""
            for ident in identifiers:
                if not doi:
                    doi = normalize_doi(ident)
                if ident.startswith("http"):
                    if not landing:
                        landing = ident
                    if ident.lower().endswith(".pdf") and source != "numdam":
                        pdf = ident
            if source == "numdam" and rid.startswith("oai:numdam.org:"):
                item_id = rid.split("oai:numdam.org:", 1)[1]
                landing = "https://www.numdam.org/item?id=" + urllib.parse.quote(item_id)
            packed = compact(
                source, rid, first(titles), creators, subjects, dates,
                first(types), first(sources) or first(publishers), landing, pdf, doi,
                provider or source.upper(), first(rights),
            )
            if packed:
                out.append(packed)
        token_el = root.find(".//oai:resumptionToken", OAI_NS)
        token = clean(token_el.text) if token_el is not None else ""
        page += 1
        print("  %s OAI page %d: %d records" % (source, page, len(records)))
        if not token:
            break
        params = {"verb": "ListRecords", "resumptionToken": token}
        time.sleep(0.6)
    return out


def harvest_hal():
    source = "hal"
    start, end = period_for(source)
    out = []
    offset = 0
    rows = 500
    for page in range(MAX_PAGES):
        params = [
            ("q", "*:*"), ("wt", "json"), ("rows", str(rows)), ("start", str(offset)),
            ("sort", "submittedDate_tdate desc"),
            ("fl", "docid,halId_s,title_s,authFullName_s,producedDate_tdate,submittedDate_tdate,docType_s,uri_s,fileMain_s,doiId_s,journalTitle_s,keyword_s,license_s"),
            ("fq", "domain_s:math"),
            ("fq", "submittedDate_tdate:[%sT00:00:00Z TO %sT23:59:59Z]" % (start.isoformat(), end.isoformat())),
        ]
        url = "https://api.hal.science/search/?" + urllib.parse.urlencode(params)
        payload = request_json(url)
        docs = ((payload.get("response") or {}).get("docs") or [])
        if not docs:
            break
        for d in docs:
            packed = compact(
                source, d.get("halId_s") or d.get("docid"), first(d.get("title_s")),
                d.get("authFullName_s") or [], d.get("keyword_s") or ["Mathematics"],
                d.get("producedDate_tdate") or d.get("submittedDate_tdate"), d.get("docType_s"),
                d.get("journalTitle_s"), d.get("uri_s"), d.get("fileMain_s"), d.get("doiId_s"),
                "HAL", d.get("license_s"),
            )
            if packed:
                out.append(packed)
        offset += len(docs)
        print("  HAL page %d: %d records" % (page + 1, len(docs)))
        if len(docs) < rows:
            break
        time.sleep(0.4)
    return out


def harvest_doaj():
    source = "doaj"
    start, end = period_for(source)
    out = []
    q = 'bibjson.subject.code:QA* AND last_updated:[%sT00:00:00Z TO %sT23:59:59Z]' % (start.isoformat(), end.isoformat())
    enc = urllib.parse.quote(q, safe="")
    for page in range(1, min(MAX_PAGES, 20) + 1):
        url = "https://doaj.org/api/search/articles/%s?page=%d&pageSize=100" % (enc, page)
        payload = request_json(url)
        results = payload.get("results") or []
        if not results:
            break
        for item in results:
            bib = item.get("bibjson") or {}
            ids = bib.get("identifier") or []
            doi = ""
            for ident in ids:
                if str(ident.get("type", "")).lower() == "doi":
                    doi = ident.get("id") or ""
                    break
            authors = [a.get("name", "") for a in (bib.get("author") or []) if a.get("name")]
            subjects = [s.get("term", "") for s in (bib.get("subject") or []) if s.get("term")]
            links = bib.get("link") or []
            landing = pdf = ""
            for link in links:
                u = link.get("url") or ""
                if not landing and u:
                    landing = u
                if ("pdf" in str(link.get("content_type", "")).lower() or u.lower().endswith(".pdf")) and u:
                    pdf = u
            journal = (bib.get("journal") or {}).get("title") or ""
            licenses = bib.get("license") or []
            lic = "; ".join(clean(x.get("title") or x.get("type") or "") for x in licenses if isinstance(x, dict))
            date = str(bib.get("year") or "") + "-01-01"
            packed = compact(source, item.get("id"), bib.get("title"), authors, subjects, date, "article", journal, landing, pdf, doi, "DOAJ", lic)
            if packed:
                out.append(packed)
        print("  DOAJ page %d: %d records" % (page, len(results)))
        if len(results) < 100:
            break
        time.sleep(0.4)
    return out


def regenerate_manifest():
    sources = []
    total = 0
    os.makedirs(DATA_ROOT, exist_ok=True)
    for source in sorted(os.listdir(DATA_ROOT)):
        d = os.path.join(DATA_ROOT, source)
        if not os.path.isdir(d):
            continue
        years = []
        count = 0
        for name in os.listdir(d):
            if not name.endswith(".json"):
                continue
            rows = load_json(os.path.join(d, name), [])
            count += len(rows)
            years.append({"year": name[:-5], "count": len(rows), "bytes": os.path.getsize(os.path.join(d, name))})
        years.sort(key=lambda x: x["year"], reverse=True)
        sources.append({"source": source, "count": count, "years": years})
        total += count
    manifest = {
        "schema": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": total,
        "sources": sources,
    }
    save_json(os.path.join(DATA_ROOT, "manifest.json"), manifest)
    return total


def run_one(source, fn):
    try:
        rows = fn()
        added, updated = merge_source(source, rows)
        print("%s: harvested=%d added=%d updated=%d" % (source, len(rows), added, updated))
        return len(rows)
    except Exception as exc:
        print("%s collector FAILED: %s" % (source, exc), file=sys.stderr)
        return 0


def main():
    os.makedirs(DATA_ROOT, exist_ok=True)
    run_one("hal", harvest_hal)
    run_one("doaj", harvest_doaj)
    run_one("doab", lambda: harvest_oai("doab", "https://directory.doabooks.org/oai/request", filter_math=True, provider="DOAB", max_pages=18))
    run_one("zenodo", lambda: harvest_oai("zenodo", "https://zenodo.org/oai2d", filter_math=True, provider="Zenodo", max_pages=14))
    run_one("numdam", lambda: harvest_oai("numdam", "https://www.numdam.org/oai", filter_math=False, provider="NUMDAM", max_pages=20))
    run_one("euclid", lambda: harvest_oai("euclid", "https://projecteuclid.org/DPubS/", filter_math=False, provider="Project Euclid", max_pages=20))
    total = regenerate_manifest()
    print("VanoLib additional local-source references: %d" % total)


if __name__ == "__main__":
    main()
