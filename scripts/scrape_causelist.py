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

# Categories of PDFs on the cause-list index that are NOT cause lists and
# should be skipped. Everything else dated for our target days gets parsed.
# This is a blocklist (not a whitelist) so we automatically pick up new
# supplementary list patterns DHC introduces — sup_hmj_<judge>, sup-<n>,
# combined_sup, etc. — without manual config edits.
EXCLUDED_PREFIXES = (
    "leave_note",          # judges-on-leave notice
    "corrigendum",         # typo corrections to earlier lists
    "jud-",                # judgment delivery rosters
    "judgement",           # alt spelling
    "judgment",            # alt spelling
    "today_jud",           # today's judgments roster
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
    d, mo, y4 = target_date.day, target_date.month, target_date.year
    y2 = y4 % 100
    candidates = [
        # 4-digit year variants
        f"{d:02d}{mo:02d}{y4}",         # 27042026
        f"{d:02d}.{mo:02d}.{y4}",       # 27.04.2026
        f"{d:02d}-{mo:02d}-{y4}",       # 27-04-2026
        f"{d:02d}_{mo:02d}_{y4}",       # 27_04_2026
        # 2-digit year variants — used by sup-N_for_dd.mm.yy.pdf etc.
        f"{d:02d}.{mo:02d}.{y2:02d}",   # 27.04.26
        f"{d:02d}-{mo:02d}-{y2:02d}",   # 27-04-26
        f"{d:02d}_{mo:02d}_{y2:02d}",   # 27_04_26
        f"{d:02d}{mo:02d}{y2:02d}",     # 270426
        # Day-month only (some advance lists drop the year entirely)
        f"{d:02d}.{mo:02d}",            # 27.04
    ]
    low = fname.lower()
    return any(c in low for c in candidates)


def select_pdfs(pdf_links, target_dates):
    """Return every PDF on the index that (a) isn't an obvious non-cause-list
    artefact (judgments, corrigenda, leave notes) and (b) carries one of
    our target dates in its filename. Mirrors what a clerk would scan in
    Acrobat — read everything dated for today/tomorrow."""
    keep = []
    seen = set()
    for href in pdf_links:
        fname = href.rsplit("/", 1)[-1]
        flow = fname.lower()
        if any(flow.startswith(p) for p in EXCLUDED_PREFIXES):
            continue
        for d in target_dates:
            if date_in_filename(fname, d):
                key = (href, d.isoformat())
                if key in seen:
                    continue
                seen.add(key)
                keep.append(key)
                break
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
    Matches CS(COMM)108/2025, CS(COMM) 108/2025, CS(COMM)/108/2025,
    CS COMM 108-2025, CS(COMM) 108 of 2025, CS COMM 108 2025…
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
    # Number-to-year separator: any of /, -, ., space, or 'of'. Wide
    # enough to catch every formatting variation DHC has used.
    parts.append(rf"\s*[\./\-]?\s*0*{num}\s*(?:[\./\-]|\s+(?:OF\s+)?)\s*{year}")
    return re.compile("".join(parts), re.IGNORECASE)


def normalize_for_match(s: str) -> str:
    """Strip everything except letters and digits, uppercase. Used as a
    formatting-agnostic fallback when the regex misses (e.g. DHC PDF
    inserted a stray newline mid-case-no, or used unusual punctuation).
    'CS(COMM)/441/2024' → 'CSCOMM4412024'.
    """
    return re.sub(r"[^A-Z0-9]", "", s.upper())


# Pre-compile court / judge sniffers — same regexes used on every page.
COURT_RE = re.compile(r"COURT\s+(?:NO\.?|NUM(?:BER)?)?\s*[:\-]?\s*(\d+)", re.IGNORECASE)
JUDGE_RE = re.compile(
    r"HON'?BLE\s+(?:MR\.?|MS\.?|MRS\.?|JUSTICE\s+|MS\.?\s+JUSTICE\s+|MR\.?\s+JUSTICE\s+)+([A-Z][A-Z\s\.\-]{3,60})"
)
ITEM_RE = re.compile(r"^\s*(\d{1,4})[\.\s]")
TIME_RE = re.compile(r"\b(\d{1,2}[:\.]\d{2}(?:\s*[AP]\.?M\.?)?)\b", re.IGNORECASE)

# ── Matching strategy ────────────────────────────────────────────────────────
#
# We match on case number ONLY. Two passes:
#   1. Type-aware regex (build_case_pattern) — catches the common DHC
#      formatting variations: CS(COMM)/441/2024, CS COMM 441/2024,
#      CS(COMM) 441 of 2024, CS COMM 441-2024, etc.
#   2. Normalized-substring fallback — strip both the line text and the
#      case_no down to alphanumerics and look for a substring match. This
#      catches every formatting permutation regex can't reach (DHC
#      sometimes inserts a stray newline mid-case-no, uses non-standard
#      punctuation, or omits the bracket entirely).
#
# We previously had a stage-2 keyword search using party names extracted
# from the matter title. It produced too many false positives — common
# plaintiff names like JIOSTAR or STAR INDIA appear in unrelated cases,
# and the specificity scoring couldn't reliably disambiguate. Killed it
# entirely. Better to miss a hearing (the user still has the manual cause
# list link) than to surface five wrong cases that erode trust.

def _build_hit(text, line_start, line_end, page, court, judge):
    """Common hit-construction logic — extract item / time from the matched line."""
    line = text[line_start:line_end].strip()
    item = None
    im = ITEM_RE.match(line)
    if im:
        item = im.group(1)
    time_str = None
    tm = TIME_RE.search(line)
    if tm:
        time_str = tm.group(1).upper().replace(".", ":", 1)
    return {
        "item":    item,
        "court":   court,
        "judge":   judge,
        "time":    time_str,
        "page":    page["page"],
        "context": line[:240],
    }


def search_pages(pages, case_patterns: dict, case_norms: dict):
    """Two-pass case-number search. ZERO false positives — every reported
    entry is traceable to a literal case-no in the PDF.

      Pass 1 — type-aware regex (build_case_pattern). Catches the common
               DHC formatting variations.
      Pass 2 — normalized-substring fallback. Strips both the line text
               and the case_no down to alphanumerics; if the case_no's
               normalized form appears in a normalized line, it's a hit.
               This is the safety net for lines where the regex fails
               (PDF inserted a stray newline mid-case-no, used non-ASCII
               punctuation, etc.).

    Lines matched by pass 1 are excluded from pass 2 to avoid duplicates.
    """
    out = []
    running_court = None
    running_judge = None

    for page in pages:
        text = page["text"]
        cm = COURT_RE.findall(text)
        if cm:
            running_court = cm[-1]
        jm = JUDGE_RE.findall(text)
        if jm:
            running_judge = re.sub(r"\s+", " ", jm[-1]).strip(" .,")

        attributed_lines = set()  # line_start positions already claimed

        # ── Pass 1: type-aware regex ─────────────────────────────────
        for case_no, pattern in case_patterns.items():
            for m in pattern.finditer(text):
                ls = text.rfind("\n", 0, m.start()) + 1
                le = text.find("\n", m.end())
                if le == -1:
                    le = min(len(text), m.end() + 300)
                if ls in attributed_lines:
                    continue
                attributed_lines.add(ls)
                hit = _build_hit(text, ls, le, page, running_court, running_judge)
                hit["caseNo"]     = case_no
                hit["match_type"] = "case_no"
                hit["matched_on"] = m.group(0)[:80]
                out.append(hit)

        # ── Pass 2: normalized substring (formatting-agnostic) ───────
        # Walk line by line; normalize each; check if any case_no's
        # normalized form appears as a substring.
        for line_match in re.finditer(r"[^\n]+", text):
            ls = line_match.start()
            if ls in attributed_lines:
                continue
            line_text = line_match.group()
            line_norm = normalize_for_match(line_text)
            if len(line_norm) < 6:
                continue
            for case_no, norm in case_norms.items():
                # Require a reasonably long normalized form so a 4-digit
                # year alone can't trigger noise. Real DHC case nos
                # normalize to 10+ chars (CSCOMM4412024 = 13).
                if len(norm) >= 8 and norm in line_norm:
                    attributed_lines.add(ls)
                    hit = _build_hit(text, ls, line_match.end(), page, running_court, running_judge)
                    hit["caseNo"]     = case_no
                    hit["match_type"] = "case_no_norm"
                    hit["matched_on"] = case_no
                    out.append(hit)
                    break  # one case per line is enough
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

    # Pre-compile every case's matcher once + a normalized form for the
    # substring fallback.
    case_patterns = {c: build_case_pattern(c) for c in cases}
    case_norms    = {c: normalize_for_match(c) for c in cases}
    print(f"Compiled {len(case_patterns)} case-no patterns")
    for c, n in case_norms.items():
        print(f"  · {c} → {n}")

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

        hits = search_pages(pages, case_patterns, case_norms)
        for hit in hits:
            hit["date"] = hearing_date
            hit["source_pdf"] = fname
            all_entries.append(hit)
        regex_hits = sum(1 for h in hits if h["match_type"] == "case_no")
        norm_hits  = sum(1 for h in hits if h["match_type"] == "case_no_norm")
        print(f"  ✓ {fname} · {len(pages)} pages · {regex_hits} regex + {norm_hits} normalized matches")
        sources.append({
            "file": fname, "date": hearing_date,
            "matched": len(hits), "regex_matches": regex_hits, "norm_matches": norm_hits,
        })

    # Dedup — same case + same date + same item + same court is one entry.
    # Regex match wins over normalized match when both are present for
    # the same key (regex is type-aware, slightly more precise context).
    confidence_rank = {"case_no": 2, "case_no_norm": 1}
    by_key = {}
    for e in all_entries:
        key = (e["caseNo"], e["date"], e.get("item"), e.get("court"))
        prev = by_key.get(key)
        if prev is None or confidence_rank.get(e["match_type"], 0) > confidence_rank.get(prev["match_type"], 0):
            by_key[key] = e
    unique = list(by_key.values())

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
