#!/usr/bin/env python3
"""
Build VanoLib's instant-search index (static files for GitHub Pages).

Inputs : site/data/YYYY.json   rows [id, title, authors, category, date]
Outputs: site/data/docs/N.json        papers in fixed chunks of CHUNK rows. Doc numbers are
                                      append-only (oldest = 0), so a daily sync only touches the
                                      last chunk and the index shards that gain new words.
         site/data/idx/<xy>.json      { word: "base36 deltas" } for every word starting with "xy"
         site/data/idx/_cats.json     { category: "base36 deltas" }
         site/data/idx/meta.json      { n, chunk, keys, generated }

The browser loads only the 1–2 tiny shards matching what you type, intersects the doc
lists with bitmaps, and fetches the few doc chunks needed to show the first results.
"""
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
DOCS = os.path.join(DATA, "docs")
IDX = os.path.join(DATA, "idx")
CHUNK = 500
STOP = {"the", "of", "and", "in", "on", "for", "to", "an", "with", "by", "from", "at", "its", "is",
        "are", "as", "or", "via", "into", "de", "la", "le", "et", "des", "du", "en", "les", "un", "une"}
TOKEN_RE = re.compile(r"[^a-z0-9]+")


def base_id(i):
    return re.sub(r"v\d+$", "", str(i or ""))


def words(text):
    t = unicodedata.normalize("NFKD", str(text or ""))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return [w for w in TOKEN_RE.split(t) if len(w) >= 2 and w not in STOP]


def b36(n):
    s, d = "", "0123456789abcdefghijklmnopqrstuvwxyz"
    while True:
        n, r = divmod(n, 36)
        s = d[r] + s
        if not n:
            return s


def encode(ids):
    out, prev = [], 0
    for i in ids:
        out.append(b36(i - prev))
        prev = i
    return ",".join(out)


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_if_changed(path, obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == data:
                return False
    except FileNotFoundError:
        pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)
    return True


def main():
    os.makedirs(DOCS, exist_ok=True)
    os.makedirs(IDX, exist_ok=True)

    # 1) current papers from the yearly shards (source of truth)
    papers = {}
    for fn in os.listdir(DATA):
        if re.fullmatch(r"\d{4}\.json", fn):
            for r in load(os.path.join(DATA, fn), []):
                if r and r[0]:
                    k = base_id(r[0])
                    if k not in papers or str(r[0]) > str(papers[k][0]):
                        papers[k] = list(r[:5])

    # 2) keep existing doc numbers, append new papers (oldest first)
    meta = load(os.path.join(IDX, "meta.json"), {})
    order = []
    for c in range((meta.get("n", 0) + CHUNK - 1) // CHUNK):
        order += [base_id(r[0]) for r in load(os.path.join(DOCS, f"{c}.json"), [])]
    known = set(order)
    if len(known) != len(order):          # corrupted → rebuild numbering from scratch
        order, known = [], set()
    order = [k for k in order if k in papers]   # drop papers that disappeared
    if len(order) != len(known):
        order, known = [], set()
    new = sorted((k for k in papers if k not in known), key=lambda k: (str(papers[k][4]), k))
    order += new
    rows = [papers[k] for k in order]

    # 3) doc chunks
    changed = 0
    for c in range(0, len(rows), CHUNK):
        changed += write_if_changed(os.path.join(DOCS, f"{c // CHUNK}.json"), rows[c:c + CHUNK])

    # 4) inverted index: word -> sorted doc numbers, sharded by the first two characters
    post = defaultdict(list)
    cats = defaultdict(list)
    for i, r in enumerate(rows):
        for w in set(words(r[0]) + words(r[1]) + words(r[2]) + words(r[3])):
            post[w].append(i)
        cats[r[3]].append(i)
    shards = defaultdict(dict)
    for w in sorted(post):
        shards[w[:2]][w] = encode(post[w])
    keys = sorted(shards)
    for k in keys:
        changed += write_if_changed(os.path.join(IDX, f"{k}.json"), shards[k])
    for fn in os.listdir(IDX):            # remove shards that no longer exist
        if fn.endswith(".json") and fn[:-5] not in keys and fn not in ("meta.json", "_cats.json"):
            os.remove(os.path.join(IDX, fn))
    changed += write_if_changed(os.path.join(IDX, "_cats.json"), {c: encode(v) for c, v in cats.items()})
    write_if_changed(os.path.join(IDX, "meta.json"), {
        "n": len(rows), "chunk": CHUNK, "keys": keys,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    print(f"Search index: {len(rows)} papers ({len(new)} new), {len(post)} words, {len(keys)} shards, {changed} files updated")


if __name__ == "__main__":
    main()
