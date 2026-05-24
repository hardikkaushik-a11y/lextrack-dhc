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

def fetch_pdf_links(max_pages: int = 4):
    """Walk the cause-list index page-by-page and collect every PDF URL
    pointing at /files/.../cause-list/. The index has both relative
    (/files/...) and absolute (https://delhihighcourt.nic.in/files/...)
    hrefs in the HTML; the old regex only caught relative ones, which
    silently dropped half the listings (incl. today's main `finals_*` and
    `combined_pro_*` PDFs that live on page 1 with absolute URLs)."""
    found = []
    for page in range(max_pages):
        url = f"{INDEX_URL}?page={page}"
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"[index] page {page} failed: {e}", file=sys.stderr)
            continue
        before = len(found)
        for m in re.finditer(
            r'href=[\'"]([^\'"]+\.pdf)[\'"]',
            resp.text,
            re.IGNORECASE,
        ):
            href = m.group(1)
            if "cause-list/" not in href.lower():
                continue
            # Normalize absolute → relative so dedupe works regardless of
            # how the link was written.
            if href.startswith("http"):
                try:
                    href = "/" + href.split("//", 1)[1].split("/", 1)[1]
                except IndexError:
                    continue
            if href not in found:
                found.append(href)
        print(f"[index] page {page}: +{len(found) - before} PDFs (total {len(found)})")
        # If a page returned no NEW PDFs, we've likely hit the end.
        if len(found) == before and page > 0:
            break
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

    Also handles the column-wrapped layout DHC uses in IA-style cause-list
    entries, where the type prefix and the case number live on different
    rows of the same table cell:

        15   I.A. 12869/2026 JIO STAR INDIA PVT     SUBHASHISH
             In CS(COMM)-    LTD                    KUMAR, R MAYA,
             108/2025        V/s IPTV SMARTER       AVISH SHARMA,

    The strict regex required CS(COMM) and 108/2025 to be roughly adjacent
    (separated by whitespace only). That misses the wrapped form because
    `LTD ... KUMAR, R MAYA,` sits in between. We allow up to 150 non-digit
    characters between the bracket close and the case number — bounded so
    we can't span unrelated cases (any intervening digit fails the match).
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
    # Allow up to 150 non-digit characters between the bracket and the
    # case number — covers column-wrapped cause-list rows where party-
    # name text lives between the prefix and the suffix. Bounded by
    # `[^\d]` so an intervening case number (e.g. another I.A.) fails the
    # match instead of silently swallowing it. `0*<num>` (not `\d*<num>`)
    # also blocks accidental tail-matches like 5108→108.
    parts.append(rf"[^\d]{{0,150}}0*{num}\s*[\.\/\-]\s*{year}")
    return re.compile("".join(parts), re.IGNORECASE)


def normalize_for_match(s: str) -> str:
    """Strip everything except letters and digits, uppercase. Used as a
    formatting-agnostic fallback when the regex misses (e.g. DHC PDF
    inserted a stray newline mid-case-no, or used unusual punctuation).
    'CS(COMM)/441/2024' → 'CSCOMM4412024'.
    """
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def split_case_norm(case_no: str):
    """Split a case-no into (prefix_norm, num_year_norm) for the multi-
    line window matcher (Pass 3). Lets us search a normalized window
    for the prefix and number+year independently — required when DHC's
    column layout puts party-name text BETWEEN the prefix and the
    number on the same logical row.

    'CS(COMM)/108/2025' → ('CSCOMM', '1082025')
    """
    nums = re.findall(r"\d+", case_no)
    if len(nums) < 2:
        return None
    num_year_norm = nums[-2] + nums[-1]  # '108' + '2025' → '1082025'
    first_digit = re.search(r"\d", case_no)
    prefix_part = case_no[:first_digit.start()] if first_digit else case_no
    prefix_norm = normalize_for_match(prefix_part)
    if len(prefix_norm) < 3 or len(num_year_norm) < 5:
        return None
    return prefix_norm, num_year_norm


# Pre-compile court / judge sniffers — same regexes used on every page.
COURT_RE = re.compile(r"COURT\s+(?:NO\.?|NUM(?:BER)?)?\s*[:\-]?\s*(\d+)", re.IGNORECASE)
JUDGE_RE = re.compile(
    r"HON'?BLE\s+(?:MR\.?|MS\.?|MRS\.?|JUSTICE\s+|MS\.?\s+JUSTICE\s+|MR\.?\s+JUSTICE\s+)+([A-Z][A-Z\s\.\-]{3,60})"
)
ITEM_RE = re.compile(r"^\s*(\d{1,4})[\.\s]")
TIME_RE = re.compile(r"\b(\d{1,2}[:\.]\d{2}(?:\s*[AP]\.?M\.?)?)\b", re.IGNORECASE)

# JR section header — appears in DHC combined advance lists AND standalone JR
# cause-list PDFs. Neither matches COURT_RE (no numeric court number), so
# running_court would stay at whatever numeric court preceded the JR section.
# We detect these explicitly and reset running_court to "JR".
#   "JOINT REGISTRAR (JUDICIAL)"                    — standard coram line
#   "BEFORE MS. SWATI KATIYAR, JOINT REGISTRAR"     — cause-list header
#   "BEFORE THE JOINT REGISTRAR"                    — order text form
JR_SECTION_RE = re.compile(
    r"JOINT\s+REGISTRAR\s*\(?JUDICIAL\)?"
    r"|\bBEFORE\s+(?:MS|MR|MRS)\.?\s+[A-Z][A-Z\s\.]+,\s*JOINT\s+REGISTRAR"
    r"|\bBEFORE\s+THE\s+(?:JOINT\s+)?REGISTRAR\b",
    re.IGNORECASE,
)
# Capture the JR's name from "BEFORE MS. SWATI KATIYAR, JOINT REGISTRAR".
JR_JUDGE_RE = re.compile(
    r"BEFORE\s+(?:MS|MR|MRS)\.?\s+([A-Z][A-Z\s\.]{3,40}),\s*JOINT\s+REGISTRAR",
    re.IGNORECASE,
)

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


def search_pages(pages, case_patterns: dict, case_norms: dict, case_splits: dict):
    """Three-pass case-number search. ZERO false positives — every reported
    entry is traceable to a literal case-no in the PDF.

      Pass 1 — type-aware regex (build_case_pattern). Catches the common
               DHC formatting variations, including column-wrapped IA
               rows where party text sits between bracket and number
               (lenient [^\\d]{0,150} bridge).
      Pass 2 — normalized-substring fallback (single line). Strips both
               the line text and the case_no down to alphanumerics; if
               the case_no's normalized form appears in a normalized
               line, it's a hit. Catches stray-newline / odd-punctuation
               cases that the regex couldn't reach.
      Pass 3 — multi-line window split-norm fallback. Slides a 2-/3-/4-
               line window over the page, normalizes the joined text,
               and looks for the case prefix followed by the number+year
               with NO intervening digits and ≤80 normalized chars
               between them. This catches any column-wrap pattern DHC
               introduces that confuses Pass 1's regex — including 3+
               line wraps, blank-line interruptions, and mixed-case
               separators. Guard against false positives via the no-
               digits-between rule (an intervening case-no breaks the
               match instead of swallowing it).

    Each pass adds the matched line(s) to attributed_lines so later
    passes don't double-count.
    """
    out = []
    running_court = None
    running_judge = None

    for page in pages:
        text = page["text"]

        # Determine the court section in effect for this page.
        # Prefer position-aware logic: whichever section header appears
        # LAST on the page (numeric COURT_RE or JR_SECTION_RE) wins.
        # This correctly handles pages that straddle two sections
        # (e.g. last few Court-48 items at the top, then JR section below).
        court_iter = list(COURT_RE.finditer(text))
        jr_iter    = list(JR_SECTION_RE.finditer(text))
        if court_iter or jr_iter:
            last_court_pos = court_iter[-1].end()  if court_iter else -1
            last_jr_pos    = jr_iter[-1].end()     if jr_iter    else -1
            if last_jr_pos > last_court_pos:
                running_court = "JR"
                # Also capture the JR officer's name as judge.
                jrj = JR_JUDGE_RE.search(text)
                if jrj:
                    running_judge = re.sub(r"\s+", " ", jrj.group(1)).strip(" .,") + " (JR)"
            else:
                running_court = court_iter[-1].group(1)

        jm = JUDGE_RE.findall(text)
        if jm and running_court != "JR":
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
        all_line_matches = list(re.finditer(r"[^\n]+", text))
        for line_match in all_line_matches:
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

        # ── Pass 3: multi-line window split-norm (column-wrap safety) ─
        # For each window of 2/3/4 consecutive lines, join them and
        # normalize. For each tracked case, find its prefix and its
        # number+year independently in the normalized window; if both
        # are present in order with no digits and ≤80 chars between
        # them, it's a hit. The no-digits-between rule blocks false
        # positives across unrelated cases on the same page.
        for i, line_match in enumerate(all_line_matches):
            ls = line_match.start()
            if ls in attributed_lines:
                continue
            for window_size in (2, 3, 4):
                if i + window_size > len(all_line_matches):
                    break
                window_lines = all_line_matches[i:i + window_size]
                # Skip if any line in the window is already attributed —
                # otherwise we'd double-emit a hit Pass 1 already found
                # one line later.
                window_starts = {lm.start() for lm in window_lines}
                if window_starts & attributed_lines:
                    continue
                window_text = " ".join(lm.group() for lm in window_lines)
                window_norm = normalize_for_match(window_text)
                if len(window_norm) < 10:
                    continue
                matched_case = None
                for case_no, split in case_splits.items():
                    if not split:
                        continue
                    prefix_norm, num_year_norm = split
                    p_idx = window_norm.find(prefix_norm)
                    if p_idx < 0:
                        continue
                    ny_idx = window_norm.find(num_year_norm, p_idx + len(prefix_norm))
                    if ny_idx < 0:
                        continue
                    between = window_norm[p_idx + len(prefix_norm):ny_idx]
                    # Reject if any digit between prefix and number
                    # (intervening case number breaks the match).
                    if any(ch.isdigit() for ch in between):
                        continue
                    # Reject if the gap is too wide — typical column
                    # wraps are <50 chars; >80 means we're crossing
                    # case boundaries or table sections.
                    if len(between) > 80:
                        continue
                    matched_case = case_no
                    break
                if matched_case:
                    le = window_lines[-1].end()
                    attributed_lines.update(window_starts)
                    hit = _build_hit(text, ls, le, page, running_court, running_judge)
                    hit["caseNo"]     = matched_case
                    hit["match_type"] = f"case_no_window_{window_size}"
                    hit["matched_on"] = matched_case
                    hit["context"]    = window_text[:240]
                    out.append(hit)
                    break  # don't try larger windows for this same start line
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

    # Pre-compile every case's matcher once + normalized + split forms
    # for the substring fallback (Pass 2) and window matcher (Pass 3).
    case_patterns = {c: build_case_pattern(c) for c in cases}
    case_norms    = {c: normalize_for_match(c) for c in cases}
    case_splits   = {c: split_case_norm(c) for c in cases}
    print(f"Compiled {len(case_patterns)} case-no patterns")
    for c, n in case_norms.items():
        sp = case_splits.get(c)
        sp_str = f" [{sp[0]} + {sp[1]}]" if sp else ""
        print(f"  · {c} → {n}{sp_str}")

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

        hits = search_pages(pages, case_patterns, case_norms, case_splits)
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
