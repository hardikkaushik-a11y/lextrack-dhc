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
SCRAPED_PATH = ROOT / "data" / "scraped.json"
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

# ── Keyword extraction ───────────────────────────────────────────────────────
#
# Case-number regex turned out to be too brittle: DHC cause-list PDFs
# abbreviate, drop the (COMM) suffix, or break case nos across lines.
# Party names survive much better — "JIOSTAR", "STAR INDIA", "RELIANCE" all
# appear verbatim. So we derive search keywords from the matter's title
# (populated by the main scraper into data/scraped.json) and search the PDFs
# for those phrases.
#
# Tradeoff: keyword matches CAN be false positives (another case might
# coincidentally include "STAR INDIA" too). Case-no regex matches are higher
# confidence. We tag each entry with `match_type` so the UI can show a
# "verify" badge on keyword-only matches.

# Strip these from titles before extracting party names.
LEGAL_SUFFIX_RE = re.compile(
    r"\b("
    r"PVT|PRIVATE|LTD|LIMITED|LLC|LLP|CORP|CORPORATION|INC|INCORPORATED|"
    r"CO|COMPANY|"
    r"AND|&|"
    r"ORS|ANR|OTHERS|ANOTHER|"
    r"GROUP|HOLDINGS|TRUST|FOUNDATION|"
    r"UOI|UNION OF INDIA|"
    r"GOVT|GOVERNMENT|GOVT\.?\s+OF\s+INDIA|GOVERNMENT\s+OF\s+INDIA|"
    r"NCT\s+OF\s+DELHI|STATE\s+OF\s+DELHI|STATE"
    r")\b\.?",
    re.IGNORECASE,
)

# Words that are useless on their own as keywords.
KEYWORD_STOPWORDS = {
    "STAR", "INC", "LTD", "PVT", "AND", "THE", "OF", "FOR", "IN", "ON",
    "WITH", "VS", "V", "VERSUS", "GROUP", "INDIA", "DELHI",
    "HTTPS", "HTTP", "WWW", "COM", "ORG", "NET",
}

# Domain pattern — matches hostnames like crichdbest.com, daddylives.nl,
# abbonamentoiptvitalia.com. Word boundary at start so we don't pick up the
# 'TPS.COM' tail of 'HTTPS://something.com'. TLD must be ≥2 letters.
DOMAIN_RE = re.compile(r"\b([a-z0-9][a-z0-9\-]{2,}(?:\.[a-z]{2,}){1,3})\b", re.IGNORECASE)


def derive_keywords_from_title(title: str) -> list:
    """Split 'STAR INDIA PVT. LTD. VS. IPTV SMARTERS PRO & ORS.' into
    ['STAR INDIA', 'IPTV SMARTERS PRO'] — phrases distinctive enough to
    search PDFs for. Returns uppercased phrases.

    Special case: rogue-website cases have URL-style defendants
    (HTTPS//CRICHDBEST.COM, SERIALMAZA.MY). For these we extract the
    hostname BEFORE the generic dot-stripping that would mangle it into
    'CRICHDBEST COM'. We also add the bare site name (CRICHDBEST) as a
    fallback for PDFs that abbreviate URLs.
    """
    if not title:
        return []

    parts = re.split(r"\s+(?:VS\.?|VERSUS|V\.?)\s+", title, flags=re.IGNORECASE)

    out = []
    seen = set()

    def add(kw: str):
        if not kw:
            return
        if kw in seen:
            return
        if kw in KEYWORD_STOPWORDS:
            return
        if len(kw) < 4:
            return
        seen.add(kw)
        out.append(kw)

    for chunk in parts:
        # ── First: domain detection ──
        # Run before dot-stripping so 'CRICHDBEST.COM' stays intact.
        # If the chunk looks domain-y, take that as the keyword and skip
        # name-based extraction for this chunk.
        domain_match = DOMAIN_RE.search(chunk)
        if domain_match:
            domain = domain_match.group(1).upper()
            add(domain)
            # Also add the bare host without TLD, in case the PDF abbreviates
            # (e.g., "CRICHDBEST" without the .COM)
            bare = domain.split(".")[0]
            add(bare)
            continue

        # ── Otherwise: name-based extraction ──
        cleaned = LEGAL_SUFFIX_RE.sub("", chunk)
        cleaned = re.sub(r"[\.,\&]", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip().upper()
        if not cleaned:
            continue
        words = [w for w in cleaned.split() if w not in KEYWORD_STOPWORDS]
        if not words:
            continue
        # Distinctive phrase — first 2-4 non-stopwords
        phrase = " ".join(words[:4])
        add(phrase)
        # 2-word fallback for PDFs that abbreviate
        if len(words) >= 2:
            add(" ".join(words[:2]))

    return out


def load_titles_for_cases(cases: list) -> dict:
    """Read data/scraped.json (populated by the main scraper) and return
    {caseNo: title} for every case in our tracking list."""
    if not SCRAPED_PATH.exists():
        return {}
    try:
        scraped = json.loads(SCRAPED_PATH.read_text())
    except Exception as e:
        print(f"[scraped.json] read failed: {e}", file=sys.stderr)
        return {}
    if not isinstance(scraped, list):
        return {}
    norm = lambda s: re.sub(r"[\s/\(\)\.\-]", "", s).upper()
    by_norm = {norm(m["caseNo"]): m for m in scraped if m.get("caseNo")}
    out = {}
    for c in cases:
        m = by_norm.get(norm(c))
        if m and m.get("title"):
            out[c] = m["title"]
    return out


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


def search_pages(pages, case_patterns: dict, keyword_map: dict):
    """Find every PDF line that mentions a tracked case, attributing each
    line to EXACTLY ONE case — the one whose keyword set is most specific
    to the line.

    Without this attribution step, common plaintiff keywords like
    'JIOSTAR' (shared across 6 different rogue-website cases) produce
    6× duplication: one PDF line → 6 reported entries. Bad UX.

    Algorithm per line:
      1. If the line contains a case-number regex match → that case wins
         (highest confidence; case nos are unique by definition).
      2. Otherwise, score every tracked case by counting how many of its
         keywords appear in the line. Pick the highest scorer.
      3. If multiple cases tie for top score AND that score is 1 (only
         the plaintiff name matched, no defendant), the line is ambiguous
         — skip it rather than pick arbitrarily.
      4. Anything score >= 2 is unambiguous (plaintiff + something else
         matched), even if multiple cases share that score (very rare).
    """
    # Pre-collect the union of all keywords across cases so we know which
    # lines to consider in stage 2. Also keep per-case keyword sets for
    # scoring.
    all_keywords = set()
    case_kw_sets = {}
    for case_no, kws in keyword_map.items():
        kw_set = set(k for k in kws if k)
        case_kw_sets[case_no] = kw_set
        all_keywords.update(kw_set)

    out = []
    running_court = None
    running_judge = None

    for page in pages:
        text = page["text"]
        text_upper = text.upper()
        # Update running headers (last hit wins)
        cm = COURT_RE.findall(text)
        if cm:
            running_court = cm[-1]
        jm = JUDGE_RE.findall(text)
        if jm:
            running_judge = re.sub(r"\s+", " ", jm[-1]).strip(" .,")

        # Track lines we've already attributed so a line matched by both
        # case-no AND keyword doesn't double-count.
        attributed_lines = set()  # set of line_start positions

        # ── Stage 1: case-no regex matches (high confidence) ──────────
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

        # ── Stage 2: keyword matches with attribution by specificity ──
        # Find every line containing ANY keyword (across all cases).
        # For each such line, pick the case whose keyword score is highest.
        seen_search_offsets = set()
        for kw in all_keywords:
            start = 0
            while True:
                idx = text_upper.find(kw, start)
                if idx == -1:
                    break
                start = idx + len(kw)
                ls = text.rfind("\n", 0, idx) + 1
                if ls in attributed_lines:
                    continue
                le = text.find("\n", idx + len(kw))
                if le == -1:
                    le = min(len(text), idx + len(kw) + 200)
                line_text = text[ls:le].upper()

                # Score every case by how many of ITS keywords appear in
                # this line text. Track ties so we can detect ambiguity.
                best_case = None
                best_score = 0
                ties_at_best = 0
                for case_no, kw_set in case_kw_sets.items():
                    score = sum(1 for k in kw_set if k in line_text)
                    if score > best_score:
                        best_case = case_no
                        best_score = score
                        ties_at_best = 1
                    elif score == best_score and score > 0:
                        ties_at_best += 1

                if best_case is None or best_score == 0:
                    continue

                attributed_lines.add(ls)
                hit = _build_hit(text, ls, le, page, running_court, running_judge)
                hit["match_score"] = best_score
                hit["matched_on"] = kw

                # Genuinely ambiguous: multiple cases tie at score 1 (plaintiff
                # matched, no defendant to disambiguate). Don't drop — emit a
                # single ambiguous entry listing all candidates so the user
                # knows SOMETHING JIOSTAR-shaped is on the docket.
                if best_score == 1 and ties_at_best > 1:
                    line_text_check = text[ls:le].upper()
                    candidates = sorted([
                        c for c, kw_set in case_kw_sets.items()
                        if any(k in line_text_check for k in kw_set)
                    ])
                    hit["caseNo"]     = candidates[0]  # representative
                    hit["match_type"] = "ambiguous"
                    hit["candidates"] = candidates
                else:
                    hit["caseNo"]     = best_case
                    hit["match_type"] = "keyword"
                out.append(hit)
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

    # Derive keyword phrases per case from the matter titles in scraped.json.
    titles = load_titles_for_cases(cases)
    keyword_map = {c: derive_keywords_from_title(titles.get(c, "")) for c in cases}
    total_kws = sum(len(v) for v in keyword_map.values())
    print(f"Derived {total_kws} search keywords across {sum(1 for v in keyword_map.values() if v)} cases (titles available)")
    for c, kws in keyword_map.items():
        if kws:
            print(f"  · {c}: {kws}")

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

        hits = search_pages(pages, case_patterns, keyword_map)
        for hit in hits:
            hit["date"] = hearing_date
            hit["source_pdf"] = fname
            all_entries.append(hit)
        case_hits = sum(1 for h in hits if h["match_type"] == "case_no")
        kw_hits   = sum(1 for h in hits if h["match_type"] == "keyword")
        print(f"  ✓ {fname} · {len(pages)} pages · {case_hits} case-no + {kw_hits} keyword matches")
        sources.append({
            "file": fname, "date": hearing_date,
            "matched": len(hits), "case_no_matches": case_hits, "keyword_matches": kw_hits,
        })

    # Dedup — same case + same date + same item + same court is one entry.
    # When duplicates exist, keep the higher-confidence one
    # (case_no > keyword > ambiguous).
    confidence_rank = {"case_no": 3, "keyword": 2, "ambiguous": 1}
    by_key = {}
    for e in all_entries:
        # Ambiguous entries are deduped by (date, court, item) instead of
        # caseNo — multiple "Possibly one of [JIOSTAR cases]" rows for the
        # same court/item are noise; one is enough.
        if e.get("match_type") == "ambiguous":
            key = ("__ambig__", e["date"], e.get("item"), e.get("court"))
        else:
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
