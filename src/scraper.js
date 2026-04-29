/**
 * LexTrack DHC Scraper
 * Scrapes case details from Delhi High Court eCourts portal.
 *
 * KEY INSIGHT: DHC uses a CSS-obfuscated text CAPTCHA whose answer is stored
 * in a hidden DOM input (#randomid). We read it directly — no 2Captcha needed.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs   = require('fs');
const path = require('path');
const https = require('https');
const pdfParse = require('pdf-parse');

const CASES_FILE   = path.join(__dirname, '../config/cases.json');
const OUTPUT_FILE  = path.join(__dirname, '../data/scraped.json');
const DHC_URL      = 'https://delhihighcourt.nic.in/app/get-case-type-status';
const ORDER_TEXT_LIMIT = 6000;       // chars of extracted text per order
const PDF_CONCURRENCY  = 4;          // simultaneous PDF fetches per case
                                     // — don't hammer DHC but still finish in reasonable time

// Module-level lookup map for AI-extracted order intelligence cache.
// Populated by main() before the scrape loop. scrapeCase reads it and
// passes the matching prior entry into buildCaseObject so already-
// extracted intelligence isn't re-billed.
const priorScrapedMap = new Map();
const _normCaseKey = s => (s || '').replace(/[\s\/]/g, '').toLowerCase();

// One attempt at downloading + parsing a PDF.
// Returns { text } on success, or { error, retryable } on failure.
function fetchPdfTextOnce(url) {
  return new Promise(resolve => {
    if (!url || !url.startsWith('http')) return resolve({ error: 'no-url', retryable: false });
    const req = https.get(url, { timeout: 20000 }, res => {
      if (res.statusCode === 404 || res.statusCode === 410) {
        res.resume();
        return resolve({ error: `http-${res.statusCode}`, retryable: false });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ error: `http-${res.statusCode}`, retryable: true });
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          const parsed = await pdfParse(buf);
          const text = (parsed.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, ORDER_TEXT_LIMIT);
          if (text) resolve({ text });
          else resolve({ error: 'empty-pdf', retryable: false }); // image-only scan
        } catch (err) {
          resolve({ error: 'parse-failed', retryable: false }); // corrupt PDF
        }
      });
      res.on('error', () => resolve({ error: 'stream-error', retryable: true }));
    });
    req.on('error', () => resolve({ error: 'request-error', retryable: true }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', retryable: true }); });
  });
}

// Public API — retries up to twice on transient failures (network/timeout/5xx),
// gives up immediately on non-retryable failures (404, image-only PDF).
async function fetchPdfText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchPdfTextOnce(url);
    if (result.text) return result.text;
    if (!result.retryable) return null;
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); // 2s, 4s
  }
  return null;
}

// Parse case number into { type, number, year }.
// Accepts strict canonical form ("CS(COMM)/108/2025") plus a few common
// variants users might type from Case Lookup:
//   "CS COMM 195/2026"  → "CS(COMM)/195/2026"
//   "CS(COMM) 195 2026" → "CS(COMM)/195/2026"
//   "CS(COMM)-195-2026" → "CS(COMM)/195/2026"
function parseCaseNumber(raw) {
  let clean = String(raw || '').trim();

  // 1. Strict form first
  let m = clean.match(/^(.+?)\/(\d+)\/(\d{4})$/);
  if (m) return { raw: clean, type: m[1].trim(), number: m[2].trim(), year: m[3].trim() };

  // 2. Look for trailing "<number>/<year>" or "<number> <year>" or "<number>-<year>"
  //    Everything before that is the type token (with possible spaces in place of parens).
  m = clean.match(/^(.+?)[\s\/-]+(\d+)[\s\/-]+(\d{4})$/);
  if (m) {
    let type = m[1].trim();
    // Common rewrites: "CS COMM" → "CS(COMM)", "CS OS" → "CS(OS)", "WP C" → "W.P.(C)"
    const upper = type.toUpperCase().replace(/\s+/g, ' ');
    const map = {
      'CS COMM': 'CS(COMM)',
      'CS OS': 'CS(OS)',
      'CS(COMM)': 'CS(COMM)',
      'WP C': 'W.P.(C)',
      'W P C': 'W.P.(C)',
      'W.P.(C)': 'W.P.(C)',
      'FAO OS COMM': 'FAO(OS)(COMM)',
      'FAO COMM': 'FAO(COMM)',
      'OMP I COMM': 'OMP(I)(COMM)',
      'OMP COMM': 'OMP(COMM)',
      'RFA OS COMM': 'RFA(OS)(COMM)',
      'CONT CAS C': 'CONT.CAS(C)',
      'CONT.CAS(C)': 'CONT.CAS(C)',
      'CRL M C': 'CRL.M.C.',
      'CRL.M.C.': 'CRL.M.C.',
      'LPA': 'LPA',
      'MAT APP': 'MAT.APP.',
      'MAT.APP.': 'MAT.APP.',
    };
    if (map[upper]) type = map[upper];
    const canonical = `${type}/${m[2]}/${m[3]}`;
    return { raw: canonical, type, number: m[2].trim(), year: m[3].trim() };
  }

  throw new Error(`Cannot parse: ${raw}`);
}

// DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY → YYYY-MM-DD
// DHC's case-status table uses '/' or '-'; order-PDF body text uses '.'
// (e.g. "List before the JR on 29.04.2026"). Both must work — we feed
// both into normaliseDate from different paths.
function normaliseDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  let m = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return raw.slice(0,10);
  return null;
}

function guessStage(statusText) {
  const s = (statusText || '').toLowerCase();
  if (s.includes('dispos') || s.includes('decid') || s.includes('decreed')) return 'disposed';
  if (s.includes('reserv')) return 'reserved';
  if (s.includes('arg')) return 'arguments';
  if (s.includes('plead') || s.includes('written statement')) return 'pleadings';
  return 'filed';
}

async function scrapeCase(browser, caseInput, attempt = 1) {
  const parsed = parseCaseNumber(caseInput);
  if (attempt === 1) console.log(`\nScraping: ${caseInput}`);
  else console.log(`  Retry ${attempt}/3...`);

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(DHC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for form fields to be rendered
    await page.waitForSelector('#case_type', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 800));

    await page.select('#case_type', parsed.type);
    await page.click('#case_number', { clickCount: 3 });
    await page.type('#case_number', parsed.number, { delay: 30 });
    await page.select('#case_year', parsed.year);

    // Read CAPTCHA from DOM
    const captchaCode = await page.$eval('#randomid', el => el.value);
    await page.click('#captchaInput', { clickCount: 3 });
    await page.type('#captchaInput', captchaCode, { delay: 30 });

    await page.click('#search');

    // Wait for DataTable to actually populate or show "No data"
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#caseTable tbody');
      if (!tbody) return false;
      const rows = tbody.querySelectorAll('tr');
      if (rows.length === 0) return false;
      const text = tbody.textContent;
      return text.includes('No data') || rows[0].querySelectorAll('td').length >= 4;
    }, { timeout: 25000 }).catch(() => null);

    await new Promise(r => setTimeout(r, 1500));

    // Extract results — capture both text AND HTML (for detail links)
    const rows = await page.evaluate(() => {
      const trs = document.querySelectorAll('#caseTable tbody tr');
      return Array.from(trs).map(tr => {
        const tds = tr.querySelectorAll('td');
        return {
          caseNoText:  tds[1]?.textContent.trim() || '',
          caseNoHtml:  tds[1]?.innerHTML || '',
          parties:     tds[2]?.textContent.trim() || '',
          listingDate: tds[3]?.textContent.trim() || ''
        };
      });
    });

    const valid = rows.filter(r => r.caseNoText && !r.caseNoText.includes('No data'));
    console.log(`  Found ${valid.length} result(s)`);

    // Diagnostics on 0-results — tells us whether DHC actually returned
    // "no data", or our captcha was wrong, or the runner is rate-limited
    // and the search just silently never executed. Only on the LAST
    // attempt to keep logs short on transient blips.
    if (valid.length === 0 && attempt === 3) {
      const diag = await page.evaluate(() => {
        const tbody = document.querySelector('#caseTable tbody');
        const cap   = document.querySelector('#randomid')?.value;
        const capDisplay = document.querySelector('#captcha-code')?.textContent?.trim();
        const captchaInput = document.querySelector('#captchaInput')?.value;
        // Look for any error / alert messages DHC might show
        const alerts = Array.from(document.querySelectorAll('.alert, .error, .text-danger, [role="alert"]'))
          .map(el => el.textContent.trim()).filter(Boolean).slice(0, 5);
        return {
          tbodyHTML: tbody ? tbody.innerHTML.slice(0, 400) : '(no tbody)',
          rowCount:  tbody ? tbody.querySelectorAll('tr').length : 0,
          captchaHidden: cap || '(missing)',
          captchaDisplayed: capDisplay || '(missing)',
          captchaSubmitted: captchaInput || '(missing)',
          alerts: alerts.length ? alerts : null,
          url: location.href,
          title: document.title,
        };
      }).catch(e => ({ error: e.message }));
      console.log('  ── 0-result diagnostics ──');
      console.log(`     URL:               ${diag.url}`);
      console.log(`     Page title:        ${diag.title}`);
      console.log(`     captcha (hidden):  ${diag.captchaHidden}`);
      console.log(`     captcha (display): ${diag.captchaDisplayed}`);
      console.log(`     captcha (typed):   ${diag.captchaSubmitted}`);
      console.log(`     tbody rows:        ${diag.rowCount}`);
      console.log(`     tbody HTML[0:400]: ${diag.tbodyHTML}`);
      if (diag.alerts) console.log(`     alerts:            ${JSON.stringify(diag.alerts)}`);
    }

    // Retry on transient 0-result failures (DHC is sometimes slow)
    if (valid.length === 0 && attempt < 3) {
      await page.close();
      await new Promise(r => setTimeout(r, 3000));
      return scrapeCase(browser, caseInput, attempt + 1);
    }

    if (valid.length === 0) {
      await page.close();
      return { caseNo: parsed.raw, error: 'No results found on DHC after 3 attempts', lastScraped: new Date().toISOString() };
    }

    // Try to fetch case history for richer data (judge, last date, timeline)
    const historyData = await fetchCaseHistory(page, valid[0].caseNoHtml).catch(() => null);

    await page.close();
    // Look up prior scraped entry by normalised case-no for AI intel cache.
    // Try both the input shape and the canonical caseNo from the row.
    const priorEntry =
      priorScrapedMap.get(_normCaseKey(parsed.raw)) ||
      priorScrapedMap.get(_normCaseKey(valid[0].caseNoText)) ||
      null;
    return await buildCaseObject(parsed, valid[0], historyData, priorEntry);

  } catch (err) {
    await page.close();
    console.error(`  Error: ${err.message}`);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 3000));
      return scrapeCase(browser, caseInput, attempt + 1);
    }
    return { caseNo: parsed.raw, error: err.message, lastScraped: new Date().toISOString() };
  }
}

// Navigate to the case detail page and extract all orders
async function fetchCaseHistory(page, caseNoHtml) {
  const linkMatch = caseNoHtml.match(/href=["']([^"']+case-type-status-details[^"']+)["']/i);
  if (!linkMatch) return null;

  const detailUrl = linkMatch[1].replace(/&amp;/g, '&');
  console.log(`  [history] fetching detail page...`);

  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for orders DataTable to populate
    await page.waitForFunction(() => {
      const tbody = document.querySelector('#caseTable tbody');
      if (!tbody) return false;
      const rows = tbody.querySelectorAll('tr');
      if (rows.length === 0) return false;
      const text = tbody.textContent;
      return text.includes('No data') || rows[0].querySelectorAll('td').length >= 3;
    }, { timeout: 20000 }).catch(() => null);

    await new Promise(r => setTimeout(r, 1500));

    const result = await page.evaluate(() => {
      const rows = document.querySelectorAll('#caseTable tbody tr');
      const orders = Array.from(rows).map(row => {
        const tds = row.querySelectorAll('td');
        const linkEl = tds[1]?.querySelector('a');
        return {
          caseNoText: tds[1]?.textContent.trim() || '',
          orderLink:  linkEl?.href || '',
          orderDate:  tds[2]?.textContent.trim() || '',
          corrigendum: tds[3]?.textContent.trim() || '',
          hindiOrder:  tds[4]?.textContent.trim() || ''
        };
      }).filter(o => o.orderDate && o.orderDate.match(/\d/));

      // Pull entire page text (subject / acts / sections etc.) for IPR classification
      const pageText = (document.body.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 5000);
      return { orders, pageText };
    });

    console.log(`  [history] ${result.orders.length} orders found`);
    return result;

  } catch (err) {
    console.log(`  [history] error: ${err.message}`);
    return null;
  }
}

// Classify IPR type from DHC page text + parsed PDF order text.
// With ALL orders now parsed, we have rich signal. Patterns recognise
// the legal phrases that show up in IPR pleadings + orders.
// Boilerplate "© Copyright Delhi High Court" footer is stripped first.
function classifyIprType(corpus) {
  if (!corpus) return { type: null, scores: {} };

  // Strip site-wide copyright footer that pollutes every PDF
  let text = String(corpus).toLowerCase();
  text = text
    .replace(/©\s*copyright[^.]*?(delhi\s*high\s*court|nic\.in|court|india)/gi, ' ')
    .replace(/copyright\s*©[^.]*?(delhi\s*high\s*court|nic\.in|court|india)/gi, ' ')
    .replace(/copyright\s*\d{4}\s*delhi\s*high\s*court/gi, ' ')
    .replace(/all\s*rights\s*reserved/gi, ' ')
    .replace(/digitally\s*signed[^.]*?delhi\s*high\s*court/gi, ' ');

  // Pattern set tuned for full-PDF text: covers common IPR-pleading
  // language plus statutory references. False-positive risk is low
  // because we're scoring across many orders, not a single page.
  const patterns = {
    trademark: /\b(trade\s*marks?\s*act|trademarks?\s*act|infringement\s*of\s*(the\s*)?(plaintiff'?s\s*)?(registered\s*)?trade\s*marks?|passing\s*off|deceptive(ly)?\s*similar|nice\s*classification|registered\s*trade\s*mark|tm\s*registration|impugned\s*mark|distinctive(ness)?\s*(of\s*)?(the\s*)?mark|trademark\s*infringement|use\s*of\s*the\s*mark|deceptive\s*similarity|prior\s*adoption\s*and\s*use|honest\s*concurrent\s*user|likelihood\s*of\s*confusion)\b/g,
    patent:    /\b(patents?\s*act|patent(ee|ed)|patented\s*invention|prior\s*art|patent\s*specification|specification\s*of\s*the\s*patent|patent\s*agent|revocation\s*petition|patent\s*infringement|inventive\s*step|complete\s*specification|provisional\s*specification|standard\s*essential\s*patent|sep\b)\b/g,
    copyright: /\b(copyrights?\s*act|copyright\s*infringement|copyright\s*owner|literary\s*work|artistic\s*work|musical\s*work|cinematograph(?:\s*film)?|sound\s*recording|moral\s*rights|fair\s*dealing|broadcast\s*reproduction|broadcasting\s*reproduction\s*right|originality\s*of\s*the\s*work|rogue\s*website|piracy|illegal\s*streaming|signal\s*piracy|unauthori[sz]ed\s*broadcast|infringing\s*copy|hyperlink(?:ing)?)\b/g,
    design:    /\b(registered\s*design|industrial\s*design|design\s*infringement|designs?\s*act|novelty\s*of\s*design|design\s*registration|registered\s*proprietor\s*of\s*the\s*design)\b/g,
    gi:        /\b(geographical\s*indication|gi\s*tag|gi\s*registration|geographical\s*indications?\s*act|registered\s*proprietor\s*of\s*the\s*g\.?i\.?)\b/g,
  };
  const scores = { trademark:0, patent:0, copyright:0, design:0, gi:0 };
  for (const [type, re] of Object.entries(patterns)) {
    const matches = text.match(re);
    if (matches) scores[type] = matches.length;
  }
  const best = Object.entries(scores).sort((a,b) => b[1] - a[1])[0];
  return { type: best[1] > 0 ? best[0] : null, scores };
}

// Boil down the order text into a 1-line summary for timeline display.
// Looks for common DHC order patterns first; falls back to first sentence.
function summariseOrderText(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  // Most common adjournment/no-hearing patterns
  if (/\bld\.?\s*p\.?o\.?\s*is\s*on\s*leave/i.test(t)) {
    const next = t.match(/(?:list(?:ed)?|fix(?:ed)?|adjourn(?:ed)?|next\s*date)[^.]*?on\s+(\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{4})/i);
    return next ? `Presiding Officer on leave — adjourned to ${next[1]}.` : 'Presiding Officer on leave; matter adjourned.';
  }
  if (/\bno\s+(?:one|representation|appearance)\s+(?:appeared|present)/i.test(t)) return 'No appearance — matter adjourned.';
  if (/\bjudge\s+(?:is\s+)?on\s+leave/i.test(t)) return 'Judge on leave — matter adjourned.';
  if (/\binterim\s*(?:order|injunction)\s*(?:is\s*)?(?:made\s*absolute|granted|continued|extended)/i.test(t)) return 'Interim order/injunction granted or continued.';
  if (/\bex[\s-]*parte\s*(?:ad-?interim\s*)?injunction/i.test(t)) return 'Ex-parte ad-interim injunction granted.';
  if (/\bjudgment\s*(?:is\s*)?reserved/i.test(t)) return 'Judgment reserved.';
  if (/\bpassed\s*over/i.test(t)) return 'Matter passed over.';
  if (/\bwritten\s*statement\s*(?:is\s*)?(?:filed|taken\s*on\s*record)/i.test(t)) return 'Written statement filed/taken on record.';
  if (/\breply\s*(?:is\s*)?(?:filed|taken\s*on\s*record)/i.test(t)) return 'Reply filed.';
  if (/\bsummons\s*(?:are\s*)?issued/i.test(t)) return 'Summons issued to defendants.';
  if (/\bdecree(?:d|\s)/i.test(t) || /\bsuit\s*decreed/i.test(t)) return 'Suit decreed.';
  if (/\bdismissed\s*as\s*withdrawn/i.test(t)) return 'Suit dismissed as withdrawn.';
  if (/\bcompromise|\bsettled\s*between\s*the\s*parties/i.test(t)) return 'Settled between parties.';

  // Fall back: skip past the order header. DHC orders look like:
  //   "...O R D E R % 13.04.2026 1. <actual content...>"
  // We strip everything up to and including the leading "%" date marker
  // and the optional list-numbering, then take the first real content.
  let afterHeader = t.replace(/^.*?(?:O\s*R\s*D\s*E\s*R|ORDER)\s*/i, '');
  afterHeader = afterHeader.replace(/^%?\s*\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{4}\s*/, '');
  afterHeader = afterHeader.replace(/^\d+\.\s*/, '');                 // leading "1."
  afterHeader = afterHeader.replace(/^[A-Z\.\s]+:?\s*$/m, '').trim();  // CORAM lines
  if (!afterHeader) return null;

  // Try a complete sentence first (most natural reading)
  const firstSentence = afterHeader.split(/(?<=[.!?])\s+/)[0];
  if (firstSentence && firstSentence.length >= 12) {
    return firstSentence.substring(0, 220);
  }

  // Last resort: first ~180 chars of body content. Better to surface
  // SOMETHING from the PDF than the generic "Order passed by court".
  const snippet = afterHeader.substring(0, 180).replace(/\s+/g, ' ').trim();
  return snippet.length >= 8 ? snippet + (afterHeader.length > 180 ? '…' : '') : null;
}

// Extract additional listing dates buried inside an order's text. DHC's
// case-status page only returns ONE next-date (the main court listing);
// the same order frequently directs the case to the Joint Registrar
// (or some other coram) on a different earlier date for procedural
// purposes (issuance, exhibits, completion of pleadings, etc.). Without
// parsing the order body we miss those entirely.
//
// Returns an array of { date, before } where `before` is one of:
//   'jr'    — Joint Registrar / Registrar
//   'court' — Hon'ble Court / Bench (named or unnamed)
// Month names → 1-indexed numbers. Covers full + 3-letter + 'sept' variant.
const TEXT_MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Convert a textual date string to ISO. Handles:
//   "30 April 2026" / "30th April, 2026" / "30-Apr-2026"
//   "April 30, 2026" / "April 30 2026" / "Apr 30, 2026"
function normaliseTextDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  let m;
  // "30 April 2026" / "30th April, 2026" / "30-Apr-2026" / "30 April, 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-,]+([A-Za-z]+)[\s\-,]+(\d{4})$/i);
  if (m) {
    const mo = TEXT_MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  // "April 30, 2026" / "April 30 2026" / "Apr 30, 2026"
  m = s.match(/^([A-Za-z]+)[\s,]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})$/i);
  if (m) {
    const mo = TEXT_MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return null;
}

// Extract additional listing dates buried inside an order's text. DHC's
// case-status page only returns ONE next-date (the main court listing);
// the same order frequently directs the case to the Joint Registrar
// (or some other coram) on a different earlier date for procedural
// purposes (issuance, exhibits, completion of pleadings, etc.). Without
// parsing the order body we miss those entirely.
//
// Returns an array of { date, before } where `before` is one of:
//   'jr'    — Joint Registrar / Registrar
//   'court' — Hon'ble Court / Bench (named or unnamed)
function extractListingDates(orderText, orderDateISO) {
  if (!orderText) return [];
  const found = new Map();   // key=`${date}|${before}` → entry

  // Date patterns. Numeric (DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY) is the
  // common case. Textual ("30th April, 2026" / "April 30, 2026") shows up
  // in older or formal orders. Each capture group ends up in m[1].
  const numericDate = String.raw`\d{1,2}[\.\-/]\d{1,2}[\.\-/]\d{4}`;
  const monthName   = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*`;
  const textDateA   = String.raw`\d{1,2}(?:st|nd|rd|th)?[\s\-,]+` + monthName + String.raw`[\s\-,]+\d{4}`;
  const textDateB   = monthName + String.raw`[\s,]+\d{1,2}(?:st|nd|rd|th)?[\s,]+\d{4}`;
  const datePat     = String.raw`(${numericDate}|${textDateA}|${textDateB})`;

  // Phrases that introduce a forward listing. Indian court orders use
  // a sprawling vocabulary — every stem we miss is a potentially missed
  // hearing date for a real lawyer. List grows; never shrinks.
  //
  // Real-world examples that motivated each cluster:
  //   - 'returnable':    Reliance vs Ripton (returnable before Court on …)
  //   - 'fixed for':     "fixed for arguments on …"
  //   - 'posted':        "matter is posted to …"
  //   - 'shall be …':    "shall be listed/heard/taken up on …"
  //   - 'come up':       "matter shall come up on …"
  //   - 'make returnable':  "make it returnable for …"
  const stem = String.raw`(?:` +
    // Re-listing
    String.raw`re-?notif(?:y|ied|ication|ying)?` +
    String.raw`|re-?list(?:ed|ing)?` +
    // Listing / fixing
    String.raw`|(?:may|shall|will|to)\s+be\s+(?:listed|heard|posted|taken\s+up|fixed)` +
    String.raw`|be\s+listed` +
    String.raw`|list(?:ed|ing)?(?:\s+for\s+\w+)?` +
    String.raw`|fix(?:ed|ing)?(?:\s+for\s+\w+(?:\s+\w+){0,2})?` +
    String.raw`|(?:the\s+)?matter\s+(?:is|shall\s+be|will\s+be|to\s+be)\s+(?:listed|heard|posted|fixed|taken\s+up)` +
    String.raw`|(?:matter\s+(?:shall|will|may|to))?\s*come\s+up` +
    String.raw`|taken\s+up` +
    String.raw`|put\s+up` +
    String.raw`|posted\s+(?:to|on|for)` +
    // Adjourn / stand over
    String.raw`|adjourn(?:ed|ing|ment)?` +
    String.raw`|stand(?:s|ing)?\s+(?:over|adjourned)` +
    // Next date
    String.raw`|next\s+date(?:\s+of\s+hearing)?` +
    // Returnable / notice
    String.raw`|returnable` +
    String.raw`|notice\s+returnable` +
    String.raw`|make(?:\s+it)?\s+returnable` +
    String.raw`|show\s+cause` +
    // Hearing-specific
    String.raw`|hearing\s+(?:fixed|posted|listed)` +
    String.raw`|shall\s+(?:be\s+heard|come\s+up\s+for)` +
    String.raw`)`;

  const sources = [
    // Primary: stem + (up to 200 chars same-sentence) + DATE
    // Catches: "List before the Joint Registrar on 30th April, 2026"
    //          "returnable before Court on 30.04.2026"
    //          "fixed for arguments on 30 April 2026"
    new RegExp(stem + String.raw`[^\.\n]{0,200}\b` + datePat + String.raw`\b`, 'gi'),
    // "On DATE … before … (Registrar|Court)" — date precedes the forum
    new RegExp(String.raw`\bon\s+\b` + datePat + String.raw`\b[^\.\n]{0,80}\bbefore\b[^\.\n]{0,40}\b(?:joint\s+registrar|registrar|hon'?ble|court|bench)`, 'gi'),
    // "Next date of hearing: DATE"  (colon shape)
    new RegExp(String.raw`next\s+date(?:\s+of\s+hearing)?\s*[:\-=]?\s*\b` + datePat + String.raw`\b`, 'gi'),
    // "Adjourned to DATE" — covered by stem above too, kept as safety net
    new RegExp(String.raw`\badjourned\s+to\b[^\.\n]{0,40}\b` + datePat + String.raw`\b`, 'gi'),
    // Generic "before <forum> on DATE" — structural cue alone is enough
    new RegExp(String.raw`\bbefore\b[^\.\n]{0,40}\b(?:hon'?ble\s+)?(?:court|bench|judge|joint\s+registrar|registrar|roster)\b[^\.\n]{0,40}\bon\s+\b` + datePat + String.raw`\b`, 'gi'),
    // "for hearing/arguments/orders on DATE"
    new RegExp(String.raw`\bfor\s+(?:hearing|arguments?|orders?|directions?|reply|rejoinder|evidence|oral\s+arguments?)\b[^\.\n]{0,30}\bon\s+\b` + datePat + String.raw`\b`, 'gi'),
    // "Listed on DATE before X" — date precedes the forum mention
    new RegExp(String.raw`\b(?:listed|posted|fixed|adjourned|re-?notified)\s+(?:to|on|for)\s+\b` + datePat + String.raw`\b`, 'gi'),
  ];

  // Sanity bounds. Dates >5 years in the future are almost certainly typos
  // ("30.04.2076" vs "30.04.2026" — common in hand-typed orders). Dates
  // earlier than today-30d are stale and useless even if the order is old.
  // Both filters are forgiving enough to never reject a real listing.
  const today = new Date();
  const earliestAcceptable = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const latestAcceptable = new Date(today);
  latestAcceptable.setFullYear(latestAcceptable.getFullYear() + 5);
  const latestAcceptableISO = latestAcceptable.toISOString().slice(0, 10);

  for (const re of sources) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(orderText))) {
      const dateStr = m[1];
      // Try numeric first (faster), fall back to textual normaliser.
      const iso = normaliseDate(dateStr) || normaliseTextDate(dateStr);
      if (!iso) continue;
      // Only forward-looking dates (after the order itself).
      if (orderDateISO && iso <= orderDateISO) continue;
      // Defensive bounds — typo guard + stale-date filter.
      if (iso < earliestAcceptable) continue;
      if (iso > latestAcceptableISO) continue;
      // Sentence-bounded window: walk back to the previous sentence
      // terminator (`.` or blank line) so adjacent sentences can't leak
      // their "Registrar" mention into this date's classification.
      const before = orderText.slice(0, m.index);
      const sentStart = Math.max(
        before.lastIndexOf('.\n'),
        before.lastIndexOf('. '),
        before.lastIndexOf('\n\n'),
        0
      );
      const after = orderText.slice(m.index + m[0].length);
      const sentEndOff = Math.min(
        ...['.', '\n\n'].map(s => {
          const i = after.indexOf(s);
          return i === -1 ? Infinity : i;
        })
      );
      const windowText = (
        orderText.slice(sentStart, m.index + m[0].length) +
        (sentEndOff !== Infinity ? after.slice(0, sentEndOff) : after.slice(0, 120))
      );
      const lc = windowText.toLowerCase();

      // 'jr' if Registrar/Joint Registrar/JR is in the sentence-bounded
      // window. The standalone 'JR' check requires 'the JR' or 'before JR'
      // to avoid matching arbitrary 2-letter sequences.
      const beforeLabel = /\b(?:joint\s+registrar|registrar|(?:before|the)\s+jr)\b/.test(lc) ? 'jr' : 'court';

      // Optional time of day. Patterns: "at 11 AM" / "at 11:00 AM" /
      // "at 2:30 PM" / "11.00 AM" (no 'at') / "at 11.30 a.m."
      // Stored alongside the date so the UI can show e.g. "30 Apr · 11:30 AM".
      let time = null;
      const timeMatch = windowText.match(/\b(?:at\s+)?(\d{1,2})[:\.\s]?(\d{2})?\s*([AaPp])\.?\s*[Mm]\.?\b/);
      if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const mi = parseInt(timeMatch[2] || '0', 10);
        const isPM = /p/i.test(timeMatch[3]);
        if (isPM && h < 12) h += 12;
        if (!isPM && h === 12) h = 0;
        if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
          time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
        }
      }

      const key = `${iso}|${beforeLabel}`;
      // First match wins to keep dedupe stable, but if a later match has
      // a time and the first didn't, upgrade.
      const existing = found.get(key);
      if (!existing) {
        found.set(key, { date: iso, before: beforeLabel, ...(time ? { time } : {}) });
      } else if (time && !existing.time) {
        existing.time = time;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Order Intelligence (Phase B3) ───────────────────────────────────────────
// Extract structured fields from an order's text via DeepSeek. Returns:
//   { classification, reliefGranted, costsAwarded, directions, citations,
//     counsel, summary }
// or null on any failure (silent — never blocks the scrape).
//
// Caching: caller is responsible for skipping already-extracted orders;
// this fn always makes an API call when invoked. See buildCaseObject for
// the per-order cache via prior scraped.json timeline lookup.
//
// Cost: ~3000 input + ~300 output tokens per order on DeepSeek-chat.
// At current pricing, ~₹0.10 per order. 50 matters × ~5 new orders/month
// = ~₹25/month for the firm. Bootstrap (first run extracting all historic
// orders) costs more but is one-time.
async function extractOrderIntelligence(orderText, caseTitle) {
  if (!orderText || orderText.length < 100) return null;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;  // Silently skip when not configured

  // Truncate so we never blow context. 5000 chars ≈ ~1500 tokens — covers
  // the substantive part of nearly every DHC order.
  const truncated = orderText.substring(0, 5000);
  const prompt = [
    `You are reading a Delhi High Court order to extract structured information.`,
    `Return ONLY valid JSON in the schema below. No prose, no markdown.`,
    ``,
    `Case: ${caseTitle || 'unknown'}`,
    ``,
    `Order text:`,
    truncated,
    ``,
    `Schema:`,
    `{`,
    `  "classification": "interim" | "final" | "procedural" | "directions" | "ex-parte" | "dismissal" | "other",`,
    `  "reliefGranted": "1-line description of any injunction/relief granted, or null if none",`,
    `  "costsAwarded": { "amount": "₹X" or null, "to": "plaintiff" | "defendant" | "neither" | null } or null,`,
    `  "directions": ["one line each — what the order specifically directs parties to do, max 5"],`,
    `  "citations": ["statutes/sections cited, e.g. 'Section 14, Trade Marks Act 1999' — max 5"],`,
    `  "counsel": { "plaintiff": "advocate name(s) or null", "defendant": "advocate name(s) or null" },`,
    `  "summary": "2-3 sentence neutral summary of what happened"`,
    `}`,
  ].join('\n');

  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 800,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  return new Promise(resolve => {
    const req = https.request('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25_000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.warn(`  [order-intel] HTTP ${res.statusCode}, skipping`);
            return resolve(null);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const content = data.choices?.[0]?.message?.content || '{}';
          const cleaned = content.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
          const parsed = JSON.parse(cleaned);
          resolve(parsed);
        } catch (e) {
          console.warn('  [order-intel] parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.warn('  [order-intel] request error:', e.message); resolve(null); });
    req.on('timeout',   () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function buildCaseObject(parsed, row, history, priorEntry) {
  const caseNoSrc   = row.caseNoText || row.caseNo || '';
  const statusMatch = caseNoSrc.match(/\[([^\]]+)\]/);
  const statusText  = statusMatch ? statusMatch[1] : '';

  // history is { orders, pageText } — backwards-compatible if it's still an array
  const ordersList = Array.isArray(history) ? history : (history?.orders || []);
  const pageText   = Array.isArray(history) ? '' : (history?.pageText || '');

  const orders = ordersList.map(o => {
    const dateMatch = o.orderDate.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/);
    return {
      date: dateMatch ? normaliseDate(dateMatch[1]) : null,
      orderLink: o.orderLink || null,
      hindiOrderLink: o.hindiOrder?.includes('http') ? o.hindiOrder : null
    };
  }).filter(o => o.date);

  orders.sort((a, b) => b.date.localeCompare(a.date));
  const lastDate = orders[0]?.date || null;

  // PDF text cache: order PDFs on DHC are immutable once published — the
  // orderLink is a stable URL keyed by date + filename. So if we already
  // parsed it on a previous sync, the text is identical. Caching it saves
  // ~3s per existing order, which is the single biggest sync-cost win:
  // a typical case with 10 prior orders + 1 new order goes from ~33s of
  // PDF work to ~3s. Over 50 cases that's many minutes saved per sync.
  const priorTextByLink = new Map();
  for (const t of (priorEntry?.timeline || [])) {
    if (t.orderLink && t.orderText) priorTextByLink.set(t.orderLink, t.orderText);
  }
  let pdfCacheHits = 0, pdfFresh = 0;
  for (let i = 0; i < orders.length; i += PDF_CONCURRENCY) {
    const batch = orders.slice(i, i + PDF_CONCURRENCY);
    await Promise.all(batch.map(async o => {
      const cached = priorTextByLink.get(o.orderLink);
      if (cached) {
        o.orderText = cached;
        pdfCacheHits++;
      } else {
        o.orderText = await fetchPdfText(o.orderLink);
        pdfFresh++;
      }
    }));
  }
  const parsedTexts = orders.map(o => o.orderText);
  const parsedCount = parsedTexts.filter(Boolean).length;
  console.log(`  [pdf] ${parsedCount}/${orders.length} parsed · cache: ${pdfCacheHits} hits, ${pdfFresh} fresh`);

  // ── AI Order Intelligence ────────────────────────────────────────────────
  // Per-order structured extraction (relief, costs, citations, directions,
  // counsel, summary, classification). Cached against prior scraped.json so
  // we only re-bill for newly-published orders. Skipped silently when
  // DEEPSEEK_API_KEY isn't configured.
  const priorIntelByLink = new Map();
  for (const t of (priorEntry?.timeline || [])) {
    if (t.orderLink && t.intelligence) priorIntelByLink.set(t.orderLink, t.intelligence);
  }
  const ORDER_INTEL_CONCURRENCY = 3;
  let intelHits = 0, intelMisses = 0, intelSkipped = 0;
  if (process.env.DEEPSEEK_API_KEY) {
    for (let i = 0; i < orders.length; i += ORDER_INTEL_CONCURRENCY) {
      const batch = orders.slice(i, i + ORDER_INTEL_CONCURRENCY);
      await Promise.all(batch.map(async o => {
        if (!o.orderText) return;
        if (priorIntelByLink.has(o.orderLink)) {
          o.intelligence = priorIntelByLink.get(o.orderLink);
          intelHits++;
          return;
        }
        const intel = await extractOrderIntelligence(o.orderText, row.parties || parsed.raw);
        if (intel) {
          o.intelligence = intel;
          intelMisses++;
        } else {
          intelSkipped++;
        }
      }));
    }
    console.log(`  [order-intel] cache hits: ${intelHits}, fresh: ${intelMisses}, skipped: ${intelSkipped}`);
  } else {
    // Still preserve any intelligence from prior runs (in case the key was
    // set previously but isn't now — don't lose data we already paid for).
    for (const o of orders) {
      if (priorIntelByLink.has(o.orderLink)) o.intelligence = priorIntelByLink.get(o.orderLink);
    }
    console.log('  [order-intel] DEEPSEEK_API_KEY not set, AI extraction skipped (cached results preserved)');
  }

  const timeline = orders.map(o => {
    // Prefer the AI summary when available — it's case-aware and far better
    // than the regex-based first-paragraph snippet. Fall back to summariseOrderText.
    const aiSummary = o.intelligence?.summary;
    const detail = aiSummary || summariseOrderText(o.orderText) || 'Order passed by court';
    return {
      date: o.date,
      event: 'Court Order',
      detail,
      orderLink: o.orderLink,
      // Keep full text only on the orders we parsed; rest stay light
      orderText: o.orderText || undefined,
      // Structured intelligence (when available — gracefully absent on failure or no key)
      intelligence: o.intelligence || undefined,
    };
  });

  // Pull additional listings (JR / IA dates) from ALL orders. Each order
  // can direct different sub-matters (an interim application disposed
  // here, a Joint Registrar listing scheduled there) without cancelling
  // each other. We extract from every order's text, keep forward-looking
  // dates only, dedupe by (date|before) so the same listing referenced
  // in multiple orders shows once.
  //
  // Real example we missed before: CS(COMM)/89/2026 — the 07.04.2026
  // order said "List before the Joint Registrar on 29.04.2026", then a
  // separate IA was disposed on 15.04.2026 without speaking to that
  // JR listing. Scanning only the latest order missed 29.04.2026.
  const todayISO = new Date().toISOString().slice(0, 10);
  const seenAdd = new Set();
  const additionalDates = [];
  for (const o of orders) {
    if (!o.orderText) continue;
    for (const e of extractListingDates(o.orderText, o.date)) {
      if (e.date < todayISO) continue;
      const key = `${e.date}|${e.before}`;
      if (seenAdd.has(key)) continue;
      seenAdd.add(key);
      additionalDates.push(e);
    }
  }
  additionalDates.sort((a, b) => a.date.localeCompare(b.date));
  if (additionalDates.length) {
    console.log(`  [listings] +${additionalDates.length} across ${orders.length} order(s): ${additionalDates.map(d => d.date + '(' + d.before + ')').join(', ')}`);
  }

  const docs = orders.map(o => ({
    name: `Order_${o.date}.pdf`,
    type: 'Court Order',
    date: o.date,
    url: o.orderLink,
    size: '—'
  }));

  // row.listingDate is like "15-05-2026\n(Court No. 5)" or "15/05/2026 Court No. 5"
  const listMatch = row.listingDate.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/);
  const nextDate  = listMatch ? normaliseDate(listMatch[1]) : null;
  if (!nextDate) console.log(`  [debug] listingDate raw: "${row.listingDate}"`);

  // row.parties is like "PLAINTIFF NAME VS. DEFENDANT NAME"
  const title = row.parties
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\S)(VS\.)/gi, '$1 $2')
    .trim() || parsed.raw;

  // Classify from real PDF order text (way more signal than the generic
  // listing-page text we used to scan).
  const classifierCorpus = [
    title,
    pageText,
    ...parsedTexts.filter(Boolean)
  ].join(' ');
  const classification = classifyIprType(classifierCorpus);
  const detectedType = classification.type || 'other';
  console.log(`  [classify] type=${detectedType} scores=${JSON.stringify(classification.scores)}`);

  return {
    id:          `m_${parsed.type.replace(/[^a-z0-9]/gi,'')}_${parsed.number}_${parsed.year}`,
    caseNo:      parsed.raw,
    title,
    type:        detectedType,
    stage:       guessStage(statusText),
    status:      statusText,
    judge:       null,
    client:      null,
    lastDate,
    nextDate,
    notes:       null,
    timeline,
    additionalDates,
    tasks:       [],
    docs,
    lastScraped: new Date().toISOString()
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const allCases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));

  // Single-case fast path: SCRAPE_CASE env var (set by workflow_dispatch input)
  // lets us re-scrape just one case in ~30s instead of looping all of them.
  const singleCase = (process.env.SCRAPE_CASE || '').trim();
  const cases = singleCase ? [singleCase] : allCases;

  console.log('LexTrack DHC Scraper');
  console.log(singleCase
    ? `Single-case mode: ${singleCase}`
    : `Full sync: ${cases.length} cases`);
  console.log(`No CAPTCHA service needed — reading answer from DOM directly.\n`);

  // Validate mode
  if (process.argv.includes('--test')) {
    console.log('[TEST MODE] Validating case numbers only...');
    cases.forEach(c => {
      try {
        const p = parseCaseNumber(c);
        console.log(`  ✓ ${c} → type="${p.type}" num="${p.number}" year="${p.year}"`);
      } catch(e) {
        console.log(`  ✗ ${c} → ${e.message}`);
      }
    });
    return;
  }

  // Pre-load scraped.json into priorScrapedMap so buildCaseObject can skip
  // AI extraction for orders that already have intelligence from a prior run.
  // Keyed by normalised caseNo (no spaces, no slashes, lowercase) so input
  // shape variation doesn't break the lookup.
  try {
    const prior = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    for (const e of (prior || [])) {
      if (e && e.caseNo) priorScrapedMap.set(_normCaseKey(e.caseNo), e);
    }
    console.log(`Pre-loaded ${priorScrapedMap.size} prior cases for AI intel cache.\n`);
  } catch {
    console.log('No prior scraped.json — first run, all orders will need AI extraction.\n');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const results = [];

  for (const caseNo of cases) {
    let succeeded = false;
    try {
      const data = await scrapeCase(browser, caseNo);
      results.push(data);
      // Treat "case found and parsed" as success — a 0-results error
      // response shouldn't trigger the polite delay since it didn't
      // actually load DHC's case-status full path.
      succeeded = !data?.error;
    } catch (err) {
      console.error(`  ✗ Skipping ${caseNo}: ${err.message}`);
      results.push({ caseNo, error: err.message, lastScraped: new Date().toISOString() });
    }
    // Polite delay between successful case-status loads only — DHC's
    // page already takes ~10-15s per scrape so we're not hammering them
    // even at 2s spacing. Skipping the delay for failed/0-result cases
    // shaves ~5s × N off every sync where N is the count of stale cases
    // in config (e.g. typo'd case numbers, disposed cases delisted).
    if (succeeded) await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  // Merge: start from existing cases, replace/add the freshly scraped ones.
  // This way single-case runs don't drop the other cases from scraped.json.
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch(_) {}

  const norm = s => s.replace(/[\s\/]/g,'').toLowerCase();
  const merged = [...existing];
  results.forEach(fresh => {
    const idx = merged.findIndex(e => norm(e.caseNo) === norm(fresh.caseNo));
    if (idx >= 0) {
      const old = merged[idx];
      merged[idx] = {
        ...fresh,
        client:   old.client   || fresh.client,
        tasks:    old.tasks?.length  ? old.tasks  : (fresh.tasks  || []),
        docs:     old.docs?.length   ? old.docs   : (fresh.docs   || []),
        lastDate: fresh.lastDate || old.lastDate,
        timeline: fresh.timeline?.length ? fresh.timeline : (old.timeline || [])
      };
    } else {
      merged.push(fresh);
    }
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Scraped ${results.length} cases → data/scraped.json`);
  console.log(`✓ ${new Date().toISOString()}`);

  const errors = results.filter(r => r.error);
  if (errors.length) {
    console.log(`\n⚠ ${errors.length} case(s) failed:`);
    errors.forEach(e => console.log(`  ${e.caseNo}: ${e.error}`));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
