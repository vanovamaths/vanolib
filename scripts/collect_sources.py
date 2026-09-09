#!/usr/bin/env python3
"""Harvest open mathematics metadata into VanoLib local JSON shards.

Collectors:
- HAL search API
- DOAJ OAI-PMH
- DOAB OAI-PMH
- Zenodo REST API
- NUMDAM OAI-PMH
- Project Euclid legacy OAI-PMH
- zbMATH Open OAI-PMH

Only bibliographic metadata and lawful open-access links are stored. PDFs are
not bulk mirrored. Existing arXiv/OpenAlex collectors remain separate.
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
DATA_ROOT = os.path.join(ROOT, "site", "data", "sources")
LOOKBACK_DAYS = int(os.environ.get("VANOLIB_SOURCES_LOOKBACK_DAYS", "10"))
INITIAL_LOOKBACK_DAYS = int(os.environ.get("VANOLIB_SOURCES_INITIAL_LOOKBACK_DAYS", "365"))
MAX_PAGES = int(os.environ.get("VANOLIB_SOURCES_MAX_PAGES", "30"))
USER_AGENT = "VanoLib/2.3 open-mathematics-harvester (academic metadata index)"

MATH_TERMS = (
    "mathemat", "algebra", "geometry", "topology", "number theory", "combinator",
    "probability", "statistics", "analysis", "differential equation", "operator algebra",
    "representation theory", "symplectic", "poisson", "category theory", "logic",
    "dynamical system", "optimization", "k-theory", "spectral theory", "metric geometry",
    "calculus", "arithmetic", "graph theory", "functional analysis", "complex analysis",
)

OAI_NS = {"oai": "http://www.openarchives.org/OAI/2.0/", "dc": "http://purl.org/dc/elements/1.1/"}


def load_json(path, default):
    if not os.path.exists(path): return default
    with open(path, "r", encoding="utf-8") as f: return json.load(f)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def request_bytes(url, timeout=90, attempts=4):
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json, application/xml, text/xml, */*"})
            with urllib.request.urlopen(req, timeout=timeout) as resp: return resp.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last = exc
            status = getattr(exc, "code", None)
            if status is not None and status < 500 and status not in (408, 429): raise
            time.sleep(2 ** attempt)
    raise last


def request_json(url, timeout=90): return json.loads(request_bytes(url, timeout).decode("utf-8"))
def text(v): return "; ".join(str(x).strip() for x in v if str(x).strip()) if isinstance(v, list) else str(v or "").strip()
def first(v): return (v[0] if v else "") if isinstance(v, list) else (v or "")
def clean(s): return re.sub(r"\s+", " ", text(s)).strip()


def extract_date(values):
    vals = values if isinstance(values, list) else [values]
    for v in vals:
        m = re.search(r"(19|20)\d{2}-\d{2}-\d{2}", str(v or ""))
        if m: return m.group(0)
    for v in vals:
        m = re.search(r"(19|20)\d{2}", str(v or ""))
        if m: return m.group(0) + "-01-01"
    return ""


def normalize_doi(v):
    s = text(v).strip(); s = re.sub(r"^doi:\s*", "", s, flags=re.I); s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s, flags=re.I)
    return s if s.lower().startswith("10.") else ""


def math_related(*parts):
    hay = " ".join(text(p) for p in parts).lower()
    return any(term in hay for term in MATH_TERMS)


def map_type(v, default="article"):
    s = text(v).lower()
    if "book" in s or "monograph" in s: return "book"
    if "thesis" in s or "dissertation" in s: return "thesis"
    if "preprint" in s or "working paper" in s: return "preprint"
    return default


def compact(source, rid, title, authors, topic, date, doc_type, venue, landing, pdf, doi, provider, license_name):
    title = clean(title)
    if not title: return None
    rid = clean(rid) or normalize_doi(doi) or re.sub(r"\W+", "-", title.lower())[:100]
    date = extract_date(date); year = date[:4] if date else "unknown"
    return year, [source, rid, title, clean(authors), clean(topic) or "Mathematics", date, map_type(doc_type), clean(venue), text(landing), text(pdf), normalize_doi(doi), clean(provider) or source.upper(), clean(license_name)]


def merge_source(source, packed_rows):
    source_dir = os.path.join(DATA_ROOT, source); os.makedirs(source_dir, exist_ok=True); by_year = {}
    for year, row in packed_rows: by_year.setdefault(year, []).append(row)
    added = updated = 0
    for year, incoming in by_year.items():
        path = os.path.join(source_dir, "%s.json" % year); existing = load_json(path, []); by_key = {}
        for row in existing:
            if row: by_key[row[10].lower() if len(row) > 10 and row[10] else row[1]] = row
        for row in incoming:
            key = row[10].lower() if row[10] else row[1]; old = by_key.get(key)
            if old is None: added += 1
            elif old != row: updated += 1
            by_key[key] = row
        merged = list(by_key.values()); merged.sort(key=lambda r: (r[5] or "", r[1]), reverse=True); save_json(path, merged)
    return added, updated


def source_is_empty(source):
    d = os.path.join(DATA_ROOT, source)
    return not os.path.isdir(d) or not any(name.endswith(".json") and name != "manifest.json" for name in os.listdir(d))


def period_for(source):
    days = INITIAL_LOOKBACK_DAYS if source_is_empty(source) else LOOKBACK_DAYS; end = datetime.now(timezone.utc).date()
    return end - timedelta(days=days), end


def oai_values(meta, tag): return [clean(el.text) for el in meta.findall("dc:" + tag, OAI_NS) if clean(el.text)]


def parse_xml(raw):
    raw = re.sub(rb"[\x00-\x08\x0B\x0C\x0E-\x1F]", b"", raw)
    # Some old OAI endpoints emit bare ampersands. Repair only ampersands that are
    # not already valid XML entities so metadata harvesting can continue safely.
    raw = re.sub(rb"&(?!#\d+;|#x[0-9A-Fa-f]+;|amp;|lt;|gt;|quot;|apos;)", b"&amp;", raw)
    return ET.fromstring(raw)


def harvest_oai(source, base_url, filter_math=False, provider=None, max_pages=None, initial_full=False):
    start, _ = period_for(source); params = {"verb": "ListRecords", "metadataPrefix": "oai_dc"}
    if not (initial_full and source_is_empty(source)): params["from"] = start.isoformat()
    page = 0; out = []; limit = max_pages or MAX_PAGES
    while page < limit:
        url = base_url + ("&" if "?" in base_url else "?") + urllib.parse.urlencode(params); root = parse_xml(request_bytes(url))
        errors = root.findall(".//oai:error", OAI_NS)
        if errors:
            code = errors[0].get("code") or "OAI error"; msg = clean(errors[0].text)
            if code == "noRecordsMatch": break
            raise RuntimeError("%s: %s" % (code, msg))
        records = root.findall(".//oai:record", OAI_NS)
        for rec in records:
            header = rec.find("oai:header", OAI_NS)
            if header is None or header.get("status") == "deleted": continue
            rid = clean(header.findtext("oai:identifier", default="", namespaces=OAI_NS)); meta = rec.find("oai:metadata/*", OAI_NS)
            if meta is None: continue
            titles=oai_values(meta,"title"); creators=oai_values(meta,"creator"); subjects=oai_values(meta,"subject"); descriptions=oai_values(meta,"description"); dates=oai_values(meta,"date"); types=oai_values(meta,"type"); identifiers=oai_values(meta,"identifier"); relations=oai_values(meta,"relation"); publishers=oai_values(meta,"publisher"); sources=oai_values(meta,"source"); rights=oai_values(meta,"rights")
            if filter_math and not math_related(titles, subjects, descriptions, sources): continue
            landing=pdf=doi=""
            for ident in identifiers + relations:
                if not doi: doi = normalize_doi(ident)
                if ident.startswith("http"):
                    if not landing: landing = ident
                    if ident.lower().split("?")[0].endswith(".pdf") and source not in ("numdam","euclid","zbmath"): pdf = ident
            if source == "numdam" and rid.startswith("oai:numdam.org:"):
                landing = "https://www.numdam.org/item?id=" + urllib.parse.quote(rid.split("oai:numdam.org:",1)[1])
            packed = compact(source,rid,first(titles),creators,subjects,dates,first(types),first(sources) or first(publishers),landing,pdf,doi,provider or source.upper(),first(rights))
            if packed: out.append(packed)
        token_el=root.find(".//oai:resumptionToken",OAI_NS); token=clean(token_el.text) if token_el is not None else ""; page += 1
        print("  %s OAI page %d: %d records, %d kept" % (source,page,len(records),len(out)))
        if not token: break
        params={"verb":"ListRecords","resumptionToken":token}; time.sleep(0.5)
    return out


def harvest_hal():
    source="hal"; start,end=period_for(source); out=[]; offset=0; rows=500
    query='(mathemat* OR algebra* OR geometry OR topology OR "number theory" OR combinator* OR probability OR statistics OR poisson OR symplectic)'
    for page in range(min(MAX_PAGES,20)):
        params=[("q",query),("wt","json"),("rows",str(rows)),("start",str(offset)),("sort","submittedDate_tdate desc"),("fl","docid,halId_s,title_s,authFullName_s,producedDate_tdate,submittedDate_tdate,docType_s,uri_s,fileMain_s,doiId_s,journalTitle_s,keyword_s,license_s,domain_s"),("fq","submittedDate_tdate:[%sT00:00:00Z TO %sT23:59:59Z]"%(start.isoformat(),end.isoformat()))]
        payload=request_json("https://api.hal.science/search/?"+urllib.parse.urlencode(params)); docs=((payload.get("response") or {}).get("docs") or [])
        if not docs: break
        for d in docs:
            domains=d.get("domain_s") or []; keywords=d.get("keyword_s") or []; title=first(d.get("title_s"))
            packed=compact(source,d.get("halId_s") or d.get("docid"),title,d.get("authFullName_s") or [],keywords or domains or ["Mathematics"],d.get("producedDate_tdate") or d.get("submittedDate_tdate"),d.get("docType_s"),d.get("journalTitle_s"),d.get("uri_s"),d.get("fileMain_s"),d.get("doiId_s"),"HAL",d.get("license_s"))
            if packed: out.append(packed)
        offset += len(docs); print("  HAL page %d: %d records, %d kept"%(page+1,len(docs),len(out)))
        if len(docs)<rows: break
        time.sleep(0.3)
    return out


def harvest_doaj():
    return harvest_oai("doaj","https://doaj.org/oai.article",filter_math=True,provider="DOAJ",max_pages=min(MAX_PAGES,24),initial_full=False)


def harvest_zenodo():
    source="zenodo"; start,_=period_for(source); empty=source_is_empty(source); out=[]
    # Smaller pages are much more reliable than 100-record payloads on Zenodo.
    queries=("keywords:mathematics","mathematics")
    last=None
    for query in queries:
        try:
            for page in range(1,min(MAX_PAGES,20)+1):
                payload=request_json("https://zenodo.org/api/records?"+urllib.parse.urlencode({"q":query,"sort":"mostrecent","page":page,"size":25}),timeout=90)
                hits=payload.get("hits",{}); rows=hits.get("hits",[]) if isinstance(hits,dict) else []
                if not rows: break
                stop=False
                for rec in rows:
                    meta=rec.get("metadata") or {}; title=meta.get("title") or rec.get("title") or ""; creators=meta.get("creators") or []; authors=[]
                    for c in creators:
                        if isinstance(c,dict): authors.append(c.get("name") or (c.get("person_or_org") or {}).get("name") or "")
                    keywords=meta.get("keywords") or meta.get("subjects") or []; desc=meta.get("description") or ""
                    if not math_related(title,keywords,desc): continue
                    pub=meta.get("publication_date") or rec.get("created") or ""; d=extract_date(pub)
                    if not empty and d and d[:10] < start.isoformat(): stop=True
                    rtype=meta.get("resource_type") or {}; rtype_name=rtype.get("type") if isinstance(rtype,dict) else rtype; links=rec.get("links") or {}; landing=links.get("self_html") or links.get("html") or ("https://zenodo.org/records/%s"%rec.get("id") if rec.get("id") else ""); pdf=""
                    files=rec.get("files") or {}; entries=files.get("entries",{}) if isinstance(files,dict) else {}
                    if isinstance(entries,dict):
                        for f in entries.values():
                            if isinstance(f,dict) and str(f.get("key") or "").lower().endswith(".pdf"):
                                flinks=f.get("links") or {}; pdf=flinks.get("content") or flinks.get("self") or ""; break
                    lic=meta.get("license") or {}; lic_name=(lic.get("id") or lic.get("title") or "") if isinstance(lic,dict) else lic
                    packed=compact(source,rec.get("id"),title,authors,keywords,pub,rtype_name,"Zenodo",landing,pdf,meta.get("doi") or rec.get("doi"),"Zenodo",lic_name)
                    if packed: out.append(packed)
                print("  Zenodo page %d: %d records, %d kept"%(page,len(rows),len(out)))
                if stop or len(rows)<25: break
                time.sleep(0.4)
            if out: return out
        except Exception as exc:
            last=exc; print("  Zenodo query %s failed: %s"%(query,exc),file=sys.stderr); time.sleep(2)
    if out: return out
    raise last or RuntimeError("Zenodo API unavailable")


def harvest_euclid():
    last=None
    for base in ("http://projecteuclid.org/DPubS/","https://projecteuclid.org/DPubS"):
        try: return harvest_oai("euclid",base,filter_math=False,provider="Project Euclid",max_pages=min(MAX_PAGES,20),initial_full=True)
        except Exception as exc: last=exc; print("  Project Euclid endpoint %s failed: %s"%(base,exc),file=sys.stderr)
    raise last or RuntimeError("Project Euclid OAI endpoint unavailable")


def harvest_zbmath():
    last=None
    for base in ("https://oai.zbmath.org/", "https://oai.zbmath.org/v1/"):
        try:
            return harvest_oai("zbmath",base,filter_math=False,provider="zbMATH Open",max_pages=min(MAX_PAGES,20),initial_full=True)
        except Exception as exc:
            last=exc; print("  zbMATH endpoint %s failed: %s"%(base,exc),file=sys.stderr)
    raise last or RuntimeError("zbMATH Open OAI endpoint unavailable")


def regenerate_manifest(statuses):
    sources=[]; total=0; os.makedirs(DATA_ROOT,exist_ok=True)
    for source in sorted(os.listdir(DATA_ROOT)):
        d=os.path.join(DATA_ROOT,source)
        if not os.path.isdir(d): continue
        years=[]; count=0
        for name in os.listdir(d):
            if not name.endswith(".json"): continue
            rows=load_json(os.path.join(d,name),[]); count += len(rows); years.append({"year":name[:-5],"count":len(rows),"bytes":os.path.getsize(os.path.join(d,name))})
        years.sort(key=lambda x:x["year"],reverse=True); sources.append({"source":source,"count":count,"years":years,"status":statuses.get(source,"ok")}); total += count
    for source,status in statuses.items():
        if not any(s["source"]==source for s in sources): sources.append({"source":source,"count":0,"years":[],"status":status})
    sources.sort(key=lambda s:s["source"]); save_json(os.path.join(DATA_ROOT,"manifest.json"),{"schema":3,"generated":datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),"total":total,"sources":sources}); return total


def run_one(source,fn,statuses):
    try:
        rows=fn(); added,updated=merge_source(source,rows); statuses[source]="ok"; print("%s: harvested=%d added=%d updated=%d"%(source,len(rows),added,updated)); return len(rows)
    except Exception as exc:
        statuses[source]="error: %s"%exc; print("%s collector FAILED: %s"%(source,exc),file=sys.stderr); return 0


def main():
    os.makedirs(DATA_ROOT,exist_ok=True); statuses={}
    run_one("hal",harvest_hal,statuses)
    run_one("doaj",harvest_doaj,statuses)
    run_one("doab",lambda:harvest_oai("doab","https://directory.doabooks.org/oai/request",filter_math=True,provider="DOAB",max_pages=min(MAX_PAGES,20),initial_full=True),statuses)
    run_one("zenodo",harvest_zenodo,statuses)
    run_one("numdam",lambda:harvest_oai("numdam","https://www.numdam.org/oai",filter_math=False,provider="NUMDAM",max_pages=min(MAX_PAGES,30),initial_full=True),statuses)
    run_one("euclid",harvest_euclid,statuses)
    run_one("zbmath",harvest_zbmath,statuses)
    print("VanoLib additional local-source references: %d"%regenerate_manifest(statuses))


if __name__=="__main__": main()
