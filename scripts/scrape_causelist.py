#!/usr/bin/env python3
"""
Scrape Delhi High Court daily cause lists for the cases tracked in
config/cases.json and emit the matches to data/causelist.json.

DHC publishes multiple PDFs per day under
  https://delhihighcourt.nic.in/web/cause-lists/cause-list

Filename patterns include:
  combined_advance_DDMMYYYY.pdf       — next-day's pre-list (most useful)
  combined_targetedd_DD.MM.YYYY.pdf   — today's main list
  combined_pro_DD.MM.YYYY.pdf         — provisional
  finals_DD.MM.YYYY.pdf               — finalised list
  combined_sup_*_DD.MM.YYYY.pdf       — supplementary additions
  rlDDMMYYYY.pdf                      — review list

For each tracked case, we search every relevant PDF (today + tomorrow's
list pages) and capture: item number, court number, judge, time, source
page. Result feeds the LexTrack UI's "Listed in cause list" surface so
Ishi never has to grep PDFs herself.

No CAPTCHA. Direct file downloads. Runs nightly via GitHub Actions.

Output schema (data/causelist.json):
{
  "scraped_at":     ISO timestamp UTC,
  "for_dates":      ["2026-04-27", "2026-04-28"],
  "tracked_cases":  <int>,
  "matched_cases":  <int>,
  "sources":        [{file, date, matched, error?}, ...],
  "entries":        [{caseNo, date, item, court, judge, time, source_pdf, page, context}, ...]
}
"""

import json
import re
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "cases.json"
OUT_PATH = ROOT / "data" / "causelist.json"

INDEX_URL = "https://delhihighcourt.nic.in/web/cause-lists/cause-list"
HOST = "https://delhihighcourt.nic.in"

# Filename prefixes we care about (in priority order). The "advance" list
# published the evening before is the most useful — that's the next-day
# schedule. Targeted/finals are today's actual list. Supply* are mid-day
# additions. Skip pure deletion notes (signal/noise too low).
RELEVANT_PREFIXES = (
    "combined_advance",   # next day
    "combined_targetedd", # today main
    "finals_",            # today finalised
    "final_",             # alt naming
    "combined_pro",       # provisional
    "pro_",               # alt
    "combined_sup",       # supplementary
    "supply_",            # alt
)

UA = "Mozilla/5.0 (X11; Linux x86_64) LexTrack-Causelist/1.0"

session = requests.Session()
session.headers.update({"User-Agent": UA})


def fetch_pdf_links(max_pages: int = 4):
    """Walk the first few pages of the cause-list listing, collecting every
    /files/.../cause-list/*.pdf link. Newest-first ordering preserved.
    """
    found = []
    for page in range(max_pages):
        url = f"{INDEX_URL}?page={page}"
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"[index] page {page} failed: {e}", file=sys.stderr)
            continue
        for m in re.finditer(
            r'href=[\'"](/files/[^\'\"]*?cause-list/[^\'\"]+\.pdf)',
            resp.text,
            re.IGNORECASE,
        ):
            href = m.group(1)
            if href not in found:
                found.append(href)
    return found


def date_in_filename(fname: str, target_date) -> bool:
    """Cheap heuristic: filename contains a date stamp matching target_date.
    DHC mixes formats — try them all."""
    d, mo, y = target_date.day, target_date.month, target_date.year
    candidates = [
        f"{d:02d}{mo:02d}{y}",       # 27042026
        f"{d:02d}.{mo:02d}.{y}",     # 27.04.2026
        f"{d:02d}.{mo:02d}",         # 27.04 (some files omit year)
        f"{d:02d}-{mo:02d}-{y}",     # 27-04-2026
        f"{d:02d}_{mo:02d}_{y}",     # 27_04_2026
    ]
    low = fname.lower()
    return any(c in low for c in candidates)


def select_pdfs(pdf_links, target_dates):
    """From every PDF link found, pick the ones whose filename matches a
    relevant prefix AND a target date. Returns list of (url, hearing_date)."""
    keep = []
    for href in pdf_links:
        fname = href.rsplit("/", 1)[-1]
        flow = fname.lower()
        if not any(flow.startswith(p) for p in RELEVANT_PREFIXES):
            continue
        for d in target_dates:
            if date_in_filename(fname, d):
                keep.append((href, d.isoformat()))
                break
    return keep


def download_pdf(href: str, dest: Path) -> Path:
    full = href if href.startswith("http") else HOST + href
    r = session.get(full, timeout=180)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return dest


def build_case_pattern(case_no: str) -> re.Pattern:
    """Turn 'CS(COMM)/108/2025' into a regex that matches the same case
    no matter how DHC's PDF formats spaces, slashes, parens, or dots."""
    type_match = re.match(r"^([A-Z\.\-]+)", case_no)
    type_part = type_match.group(1) if type_match else ""
    # Anything bracketed after the type — e.g. (COMM)
    bracket = re.search(r"\(([A-Z\s]+)\)", case_no)
    bracket_word = bracket.group(1).strip() if bracket else ""
    nums = re.findall(r"\d+", case_no)
    if len(nums) < 2:
        # Single-num cases — rare for tracked IPR matters, fallback
        nums = nums + [""]
    num, year = nums[-2], nums[-1]

    parts = [re.escape(type_part)]
    if bracket_word:
        parts.append(rf"\s*\(?\s*{re.escape(bracket_word)}\s*\)?")
    parts.append(rf"\s*[\./\-]?\s*0*{num}\s*[\./\-]\s*{year}")
    return re.compile("".join(parts), re.IGNORECASE)


def search_case_in_pdf(case_no: str, pdf_path: Path):
    """Find every occurrence of `case_no` in `pdf_path`. For each, capture the
    line, item number (if line starts with one), nearest court header,
    nearest judge name, and any time string on the same line.
    """
    pattern = build_case_pattern(case_no)
    hits = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            running_court = None
            running_judge = None
            for page in pdf.pages:
                text = page.extract_text() or ""
                # Court header on this page (or carry over from prior)
                for cm in re.finditer(
                    r"COURT\s+(?:NO\.?|NUM(?:BER)?)?\s*[:\-]?\s*(\d+)",
                    text,
                    re.IGNORECASE,
                ):
                    running_court = cm.group(1)
                for jm in re.finditer(
                    r"HON'?BLE\s+(?:MR\.?|MS\.?|MRS\.?|JUSTICE\s+|MS\.?\s+JUSTICE\s+|MR\.?\s+JUSTICE\s+)+([A-Z][A-Z\s\.\-]{3,60})",
                    text,
                ):
                    running_judge = re.sub(r"\s+", " ", jm.group(1)).strip(" .,")
                # Now look for the actual case in the body
                for m in pattern.finditer(text):
                    line_start = text.rfind("\n", 0, m.start()) + 1
                    line_end = text.find("\n", m.end())
                    if line_end == -1:
                        line_end = min(len(text), m.end() + 300)
                    line = text[line_start:line_end].strip()

                    item = None
                    im = re.match(r"^\s*(\d{1,4})[\.\s]", line)
                    if im:
                        item = im.group(1)

                    time_str = None
                    tm = re.search(
                        r"\b(\d{1,2}[:\.]\d{2}(?:\s*[AP]\.?M\.?)?)\b",
                        line,
                        re.IGNORECASE,
                    )
                    if tm:
                        time_str = tm.group(1).upper().replace(".", ":", 1)

                    hits.append({
                        "item":  item,
                        "court": running_court,
                        "judge": running_judge,
                        "time":  time_str,
                        "page":  page.page_number,
                        "context": line[:240],
                    })
    except Exception as e:
        print(f"[parse] {pdf_path.name}: {e}", file=sys.stderr)
    return hits


def main() -> int:
    if not CONFIG_PATH.exists():
        print(f"error: {CONFIG_PATH} not found", file=sys.stderr)
        return 1

    cases = json.loads(CONFIG_PATH.read_text())
    if not isinstance(cases, list) or not cases:
        print("error: cases.json is empty or not a list", file=sys.stderr)
        return 1

    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()  # IST
    target_dates = [today, today + timedelta(days=1)]
    print(f"Tracking {len(cases)} cases · target dates: {[d.isoformat() for d in target_dates]}")

    pdf_links = fetch_pdf_links(max_pages=5)
    print(f"Index returned {len(pdf_links)} PDF links")
    relevant = select_pdfs(pdf_links, target_dates)
    print(f"  → {len(relevant)} relevant for our target dates")

    tmp = Path("/tmp/causelist")
    tmp.mkdir(exist_ok=True)

    sources = []
    all_entries = []

    for href, hearing_date in relevant:
        fname = href.rsplit("/", 1)[-1]
        local = tmp / urllib.parse.unquote(fname)
        try:
            download_pdf(href, local)
        except Exception as e:
            print(f"✗ download failed: {fname}: {e}", file=sys.stderr)
            sources.append({"file": fname, "date": hearing_date, "error": f"download: {e}"})
            continue

        match_count = 0
        for case_no in cases:
            for hit in search_case_in_pdf(case_no, local):
                hit.update({
                    "caseNo":     case_no,
                    "date":       hearing_date,
                    "source_pdf": fname,
                })
                all_entries.append(hit)
                match_count += 1
        print(f"  ✓ {fname} → {match_count} matches")
        sources.append({"file": fname, "date": hearing_date, "matched": match_count})

    # Dedup — same case + same date + same item + same court is one entry
    seen = set()
    unique = []
    for e in all_entries:
        key = (e["caseNo"], e["date"], e.get("item"), e.get("court"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(e)

    output = {
        "scraped_at":     datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "for_dates":      [d.isoformat() for d in target_dates],
        "tracked_cases":  len(cases),
        "matched_cases":  len({e["caseNo"] for e in unique}),
        "sources":        sources,
        "entries":        unique,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"\n✓ {len(unique)} entries · {len({e['caseNo'] for e in unique})}/{len(cases)} cases listed → {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
