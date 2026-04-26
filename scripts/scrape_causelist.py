#!/usr/bin/env python3
"""
Scrape Delhi High Court daily cause lists for the cases tracked in
config/cases.json and emit the matches to data/causelist.json.

Two performance choices that matter:
  1. Each PDF is downloaded + parsed ONCE. We extract full text via
     poppler's `pdftotext -layout` (a system binary, ~20× faster than
     pdfplumber on big files). Then we run every case-no regex against
     the cached text. The earlier nested-loop version reparsed each PDF
     per case → 12 × 8 = 96 parses → 8+ minutes.
  2. We only walk the first 2 listing pages — DHC publishes ~10 PDFs
     per day on page 0; older lists past page 1 are not relevant for a
     "today + tomorrow" lookup.

DHC cause-list filename patterns (vary in date/separator format):
  combined_advance_DDMMYYYY.pdf       — next-day pre-list (most useful)
  combined_targetedd_DD.MM.YYYY.pdf   — today's main list
  combined_pro_DD.MM.YYYY.pdf         — provisional
  finals_DD.MM.YYYY.pdf               — finalised list
  combined_sup_*_DD.MM.YYYY.pdf       — supplementary additions
  rlDDMMYYYY.pdf                      — review list (skipped)

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
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "cases.json"
OUT_PATH = ROOT / "data" / "causelist.json"

INDEX_URL = "https://delhihighcourt.nic.in/web/cause-lists/cause-list"
HOST = "https://delhihighcourt.nic.in"

RELEVANT_PREFIXES = (
    "combined_advance",
    "combined_targetedd",
    "finals_",
    "final_",
    "combined_pro",
    "pro_",
    "combined_sup",
    "supply_",
)

UA = "Mozilla/5.0 (X11; Linux x86_64) LexTrack-Causelist/1.0"

session = requests.Session()
session.headers.update({"User-Agent": UA})


# ── Index walking ────────────────────────────────────────────────────────────

def fetch_pdf_links(max_pages: int = 2):
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
    d, mo, y = target_date.day, target_date.month, target_date.year
    candidates = [
        f"{d:02d}{mo:02d}{y}",
        f"{d:02d}.{mo:02d}.{y}",
        f"{d:02d}.{mo:02d}",
        f"{d:02d}-{mo:02d}-{y}",
        f"{d:02d}_{mo:02d}_{y}",
    ]
    low = fname.lower()
    return any(c in low for c in candidates)


def select_pdfs(pdf_links, target_dates):
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


# ── Text extraction (poppler) ────────────────────────────────────────────────

def extract_pages(pdf_path: Path):
    """Return [{page, text}] for the PDF using `pdftotext -layout`.
    pdftotext emits form-feed (\\x0c) between pages — split on that.
    """
    if not shutil.which("pdftotext"):
        raise RuntimeError("pdftotext not on PATH. Workflow must apt-install poppler-utils.")
    try:
        proc = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(pdf_path), "-"],
            capture_output=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        print(f"[parse] {pdf_path.name}: pdftotext timeout (>180s)", file=sys.stderr)
        return []
    text = proc.stdout.decode("utf-8", errors="replace")
    if proc.returncode != 0 and not text:
        print(f"[parse] {pdf_path.name}: pdftotext rc={proc.returncode} stderr={proc.stderr[:200]!r}", file=sys.stderr)
        return []
    pages = text.split("\f")
    return [{"page": i + 1, "text": p} for i, p in enumerate(pages) if p.strip()]


# ── Case-number matching ─────────────────────────────────────────────────────

def build_case_pattern(case_no: str) -> re.Pattern:
    """Turn 'CS(COMM)/108/2025' into a regex tolerant of DHC's formatting drift.
    Matches CS(COMM)108/2025, CS(COMM) 108/2025, CS(COMM)/108/2025, CS COMM 108-2025…
    """
    type_match = re.match(r"^([A-Z\.\-]+)", case_no)
    type_part = type_match.group(1) if type_match else ""
    bracket = re.search(r"\(([A-Z\s]+)\)", case_no)
    bracket_word = bracket.group(1).strip() if bracket else ""
    nums = re.findall(r"\d+", case_no)
    if len(nums) < 2:
        return re.compile(re.escape(case_no), re.IGNORECASE)
    num, year = nums[-2], nums[-1]

    parts = [re.escape(type_part)]
    if bracket_word:
        parts.append(rf"\s*\(?\s*{re.escape(bracket_word)}\s*\)?")
    parts.append(rf"\s*[\./\-]?\s*0*{num}\s*[\./\-]\s*{year}")
    return re.compile("".join(parts), re.IGNORECASE)


# Pre-compile court / judge sniffers — same regexes used on every page.
COURT_RE = re.compile(r"COURT\s+(?:NO\.?|NUM(?:BER)?)?\s*[:\-]?\s*(\d+)", re.IGNORECASE)
JUDGE_RE = re.compile(
    r"HON'?BLE\s+(?:MR\.?|MS\.?|MRS\.?|JUSTICE\s+|MS\.?\s+JUSTICE\s+|MR\.?\s+JUSTICE\s+)+([A-Z][A-Z\s\.\-]{3,60})"
)
ITEM_RE = re.compile(r"^\s*(\d{1,4})[\.\s]")
TIME_RE = re.compile(r"\b(\d{1,2}[:\.]\d{2}(?:\s*[AP]\.?M\.?)?)\b", re.IGNORECASE)


def search_pages(pages, case_patterns: dict):
    """Run every case pattern against the cached pages once.
    Tracks running court / judge across pages (DHC headers cascade)."""
    out = []
    running_court = None
    running_judge = None

    for page in pages:
        text = page["text"]
        # Update running headers from this page (last hit wins)
        cm = COURT_RE.findall(text)
        if cm:
            running_court = cm[-1]
        jm = JUDGE_RE.findall(text)
        if jm:
            running_judge = re.sub(r"\s+", " ", jm[-1]).strip(" .,")

        for case_no, pattern in case_patterns.items():
            for m in pattern.finditer(text):
                line_start = text.rfind("\n", 0, m.start()) + 1
                line_end = text.find("\n", m.end())
                if line_end == -1:
                    line_end = min(len(text), m.end() + 300)
                line = text[line_start:line_end].strip()

                item = None
                im = ITEM_RE.match(line)
                if im:
                    item = im.group(1)

                time_str = None
                tm = TIME_RE.search(line)
                if tm:
                    time_str = tm.group(1).upper().replace(".", ":", 1)

                out.append({
                    "caseNo": case_no,
                    "item":   item,
                    "court":  running_court,
                    "judge":  running_judge,
                    "time":   time_str,
                    "page":   page["page"],
                    "context": line[:240],
                })
    return out


# ── Main ─────────────────────────────────────────────────────────────────────

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

    # Pre-compile every case's matcher once.
    case_patterns = {c: build_case_pattern(c) for c in cases}

    pdf_links = fetch_pdf_links(max_pages=2)
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
            print(f"  ✗ download {fname}: {e}", file=sys.stderr)
            sources.append({"file": fname, "date": hearing_date, "error": f"download: {e}"})
            continue

        try:
            pages = extract_pages(local)
        except Exception as e:
            print(f"  ✗ parse {fname}: {e}", file=sys.stderr)
            sources.append({"file": fname, "date": hearing_date, "error": f"parse: {e}"})
            continue

        hits = search_pages(pages, case_patterns)
        for hit in hits:
            hit["date"] = hearing_date
            hit["source_pdf"] = fname
            all_entries.append(hit)
        print(f"  ✓ {fname} · {len(pages)} pages · {len(hits)} matches")
        sources.append({"file": fname, "date": hearing_date, "matched": len(hits)})

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
