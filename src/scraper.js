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

const CASES_FILE  = path.join(__dirname, '../config/cases.json');
const OUTPUT_FILE = path.join(__dirname, '../data/scraped.json');
const DHC_URL     = 'https://delhihighcourt.nic.in/app/get-case-type-status';

// Parse "CS(COMM)/108/2025" → { type, number, year }
function parseCaseNumber(raw) {
  const clean = raw.trim();
  const match = clean.match(/^(.+?)\/(\d+)\/(\d{4})$/);
  if (!match) throw new Error(`Cannot parse: ${raw}`);
  return { raw: clean, type: match[1].trim(), number: match[2].trim(), year: match[3].trim() };
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
    return buildCaseObject(parsed, valid[0], historyData);

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

// Try to extract case history link from result row and fetch full timeline
async function fetchCaseHistory(page, caseNoHtml) {
  // Look for a link/onclick in the case number cell that opens history
  const linkMatch = caseNoHtml.match(/href=["']([^"']+)["']/i);
  const onclickMatch = caseNoHtml.match(/onclick=["']([^"']+)["']/i);

  if (!linkMatch && !onclickMatch) return null;

  // For now, just log what we found — full history extraction needs more research
  console.log(`  [history] link found: ${linkMatch?.[1] || onclickMatch?.[1] || 'none'}`);
  return null;
}

function buildCaseObject(parsed, row, history) {
  // row.caseNoText is like "CS(COMM)/108/2025\n[PENDING]"
  const caseNoSrc   = row.caseNoText || row.caseNo || '';
  const statusMatch = caseNoSrc.match(/\[([^\]]+)\]/);
  const statusText  = statusMatch ? statusMatch[1] : '';

  // row.listingDate is like "15-05-2026\n(Court No. 5)" or "15/05/2026 Court No. 5"
  const dateMatch = row.listingDate.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/);
  const nextDate  = dateMatch ? normaliseDate(dateMatch[1]) : null;
  if (!nextDate) console.log(`  [debug] listingDate raw: "${row.listingDate}"`);

  // row.parties is like "PLAINTIFF NAME VS. DEFENDANT NAME" — ensure space before VS.
  const title = row.parties
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\S)(VS\.)/gi, '$1 $2')
    .trim() || parsed.raw;

  return {
    id:          `m_${parsed.type.replace(/[^a-z0-9]/gi,'')}_${parsed.number}_${parsed.year}`,
    caseNo:      parsed.raw,
    title,
    type:        'trademark',   // All Ishi's cases are CS(COMM) — IPR commercial
    stage:       guessStage(statusText),
    status:      statusText,
    judge:       null,          // Not available on listing page
    client:      null,          // Ishi fills this in the app
    lastDate:    null,          // Not available on listing page
    nextDate,
    notes:       null,
    timeline:    [],
    tasks:       [],
    docs:        [],
    lastScraped: new Date().toISOString()
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));

  console.log('LexTrack DHC Scraper');
  console.log(`Cases to scrape: ${cases.length}`);
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
    const data = await scrapeCase(browser, caseNo);
    results.push(data);

    // Polite delay — don't hammer DHC
    await new Promise(r => setTimeout(r, 5000));
  }

  await browser.close();

  // Merge with existing data — preserve client, tasks, docs Ishi has added manually
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch(_) {}

  const norm = s => s.replace(/[\s\/]/g,'').toLowerCase();
  const merged = results.map(fresh => {
    const old = existing.find(e => norm(e.caseNo) === norm(fresh.caseNo));
    if (old) {
      return {
        ...fresh,
        client:   old.client   || fresh.client,
        tasks:    old.tasks?.length  ? old.tasks  : (fresh.tasks  || []),
        docs:     old.docs?.length   ? old.docs   : (fresh.docs   || []),
        lastDate: fresh.lastDate || old.lastDate,
        timeline: fresh.timeline?.length ? fresh.timeline : (old.timeline || [])
      };
    }
    return fresh;
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
