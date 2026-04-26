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

// DD-MM-YYYY or DD/MM/YYYY → YYYY-MM-DD
function normaliseDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  let m = raw.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
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
    return await buildCaseObject(parsed, valid[0], historyData);

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

async function buildCaseObject(parsed, row, history) {
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

  // Fetch + parse EVERY order PDF so analysis sees the full case body.
  // Runs PDF_CONCURRENCY fetches in parallel batches — for a 37-order
  // case at 4-way concurrency that's ~10 batches × ~3s = ~30s instead
  // of ~110s sequential.
  for (let i = 0; i < orders.length; i += PDF_CONCURRENCY) {
    const batch = orders.slice(i, i + PDF_CONCURRENCY);
    const texts = await Promise.all(batch.map(o => fetchPdfText(o.orderLink)));
    batch.forEach((o, j) => { o.orderText = texts[j]; });
  }
  const parsedTexts = orders.map(o => o.orderText);
  const parsedCount = parsedTexts.filter(Boolean).length;
  console.log(`  [pdf] parsed ${parsedCount}/${orders.length} orders (parallel x${PDF_CONCURRENCY})`);

  const timeline = orders.map(o => {
    const summary = summariseOrderText(o.orderText);
    return {
      date: o.date,
      event: 'Court Order',
      detail: summary || 'Order passed by court',
      orderLink: o.orderLink,
      // Keep full text only on the orders we parsed; rest stay light
      orderText: o.orderText || undefined
    };
  });

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

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const results = [];

  for (const caseNo of cases) {
    try {
      const data = await scrapeCase(browser, caseNo);
      results.push(data);
    } catch (err) {
      // Don't let one malformed case kill the entire run
      console.error(`  ✗ Skipping ${caseNo}: ${err.message}`);
      results.push({ caseNo, error: err.message, lastScraped: new Date().toISOString() });
    }
    // Polite delay — don't hammer DHC
    await new Promise(r => setTimeout(r, 5000));
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
