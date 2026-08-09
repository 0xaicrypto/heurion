#!/usr/bin/env python3
"""
#467 — Fetch NIH BioArt icons (Public domain, uniform style, named) from
Wikimedia Commons for the bioscene icon catalog.

Usage: python3 scripts/fetch-bioart-icons.py
Output: packages/server-ts/data/icons/*.svg + icons.json
"""
import json
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

API = "https://commons.wikimedia.org/w/api.php"
OUT_DIR = Path(__file__).resolve().parent.parent / "packages/server-ts/data/icons"

# 目标:生物学高频图标 → (id, 名称, 类别, 中文别名列表, 匹配关键词)
TARGETS = [
    ("t-cell", "T cell", "cell", ["T细胞", "T 细胞", "cytotoxic t cell"], ["T Cell"]),
    ("b-cell", "B cell", "cell", ["B细胞", "B 细胞"], ["B Cell"]),
    ("bcr", "B cell receptor", "receptor", ["B细胞受体"], ["B Cell Receptor"]),
    ("macrophage", "Macrophage", "cell", ["巨噬细胞"], ["Macrophage"]),
    ("dendritic-cell", "Dendritic cell", "cell", ["树突状细胞"], ["Dendritic"]),
    ("nk-cell", "Natural killer cell", "cell", ["NK细胞", "自然杀伤细胞"], ["Natural Killer"]),
    ("neutrophil", "Neutrophil", "cell", ["中性粒细胞"], ["Neutrophil"]),
    ("red-blood-cell", "Red blood cell", "cell", ["红细胞"], ["Red Blood Cell"]),
    ("platelet", "Platelet", "cell", ["血小板"], ["Platelet"]),
    ("neuron", "Neuron", "cell", ["神经元"], ["Neuron"]),
    ("antibody", "Antibody", "molecule", ["抗体"], ["Antibody"]),
    ("hiv", "HIV", "virus", ["HIV"], ["HIV"]),
    ("adenovirus", "Adenovirus", "virus", ["腺病毒"], ["Adenovirus"]),
    ("virus", "Virus", "virus", ["病毒"], ["Virus Particle"]),
    ("dna", "DNA", "molecule", ["DNA", "脱氧核糖核酸"], ["DNA"]),
    ("mitochondria", "Mitochondrion", "organelle", ["线粒体"], ["Mitochondria"]),
    ("nucleus", "Nucleus", "organelle", ["细胞核"], ["Nucleus"]),
    ("golgi", "Golgi apparatus", "organelle", ["高尔基体"], ["Golgi"]),
    ("receptor", "Receptor", "receptor", ["受体"], ["Receptor"]),
    ("pill", "Drug pill", "molecule", ["药物", "药丸"], ["Pill"]),
    ("cd8-tcell", "CD8 T cell", "cell", ["CD8 T细胞"], ["CD8"]),
    ("cd4-tcell", "CD4 T cell", "cell", ["CD4 T细胞"], ["CD4"]),
]

def api(params, retries=5):
    params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    for i in range(retries):
        r = subprocess.run(
            ["curl", "-s", "-A", "Heurion-BioScene/1.0 (contact: plugins@heurion.io)", url],
            capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and r.stdout.strip():
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(3 * (i + 1))
    return None

def all_svg_members(category: str):
    """All file members of a category (paginated)."""
    files = []
    cont = {}
    while True:
        params = {
            "action": "query", "list": "categorymembers",
            "cmtitle": category, "cmtype": "file", "cmlimit": "500",
        }
        params.update(cont)
        d = api(params) or {}
        files += [m["title"] for m in d.get("query", {}).get("categorymembers", []) or []]
        cont = d.get("continue", {}) or {}
        if not cont:
            break
    return files

def find_file(files, keyword):
    """Best match: exact-ish title containing keyword, prefer .svg."""
    k = keyword.lower()
    svg_hits = [f for f in files if k in f.lower() and f.lower().endswith(".svg")]
    if not svg_hits:
        return None
    svg_hits.sort(key=len)
    return svg_hits[0]

def file_url(title: str):
    d = api({
        "action": "query", "titles": title,
        "prop": "imageinfo", "iiprop": "url|extmetadata",
    }) or {}
    pages = d.get("query", {}).get("pages", {}) or {}
    for p in pages.values():
        ii = p.get("imageinfo", [{}])[0]
        return ii.get("url", ""), ii.get("extmetadata", {}).get("LicenseShortName", {}).get("value", "?")
    return "", "?"

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Listing NIH BioArt category ...")
    files = all_svg_members("Category:NIH BioArt")
    print(f"  {len(files)} files total")

    icons = []
    for icon_id, name, category, aliases_zh, keywords in TARGETS:
        title = None
        for kw in keywords:
            title = find_file(files, kw)
            if title:
                break
        if not title:
            print(f"  SKIP {icon_id}: no SVG found")
            continue
        try:
            url, license = file_url(title)
            if license.lower() not in ("public domain", "cc0"):
                print(f"  SKIP {icon_id}: license={license}")
                continue
            dest = OUT_DIR / f"{icon_id}.svg"
            subprocess.run(["curl", "-sL", "-A", "Heurion-BioScene/1.0 (contact: plugins@heurion.io)", "-o", str(dest), url], check=True, timeout=120)
            size = dest.stat().st_size
            aliases = [name] + aliases_zh
            icons.append({
                "id": icon_id, "name": name, "category": category,
                "aliases": list(dict.fromkeys(a for a in aliases if a)),
                "file": f"{icon_id}.svg", "source": "NIH BioArt (Wikimedia Commons)",
                "license": license,
            })
            print(f"  OK {icon_id} <- {title} ({size//1024}KB)")
            time.sleep(0.4)
        except Exception as e:
            print(f"  FAIL {icon_id}: {e}")

    manifest = {
        "source": "NIH BioArt (NIH, public domain)",
        "license": "Public domain",
        "source_url": "https://commons.wikimedia.org/wiki/Category:NIH_BioArt",
        "icons": icons,
    }
    (OUT_DIR / "icons.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")
    print(f"\n{len(icons)} icons written to {OUT_DIR}")

if __name__ == "__main__":
    main()
