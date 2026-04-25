/**
 * LexTrack DHC Scraper
 * Scrapes case details from Delhi High Court eCourts portal
 * Uses 2Captcha to solve CAPTCHAs automatically
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { Solver } = require('2captcha');
const fs = require('fs');
const path = require('path');

const TEST_MODE = process.argv.includes('--test');
const API_KEY = process.env.TWO_CAPTCHA_API_KEY;
const solver = API_KEY ? new Solver(API_KEY) : null;

const CASES_FILE = path.join(__dirname, '../config/cases.json');
const OUTPUT_FILE = path.join(__dirname, '../data/scraped.json');
const DHC_URL = 'https://delhihighcourt.nic.in/case_status_case_no.asp';

// Parse "CS(COMM)/550/2022" into { type: 'CS(COMM)', number: '550', year: '2022' }
function parseCaseNumber(raw) {
  const clean = raw.trim();
  // Format: TYPE/NUMBER/YEAR  e.g. CS(COMM)/550/2022
  const match = clean.match(/^([A-Z(). ]+)\/(\d+)\/(\d{4})$/i);
  if (!match) throw new Error(`Cannot parse case number: ${raw}`);
  return {
    raw: clean,
    type: match[1].trim(),
    number: match[2].trim(),
    year: match[3].trim()
  };
}

// Solve CAPTCHA using 2Captcha service
async function solveCaptcha(page, captchaSelector) {
  if (!solver) throw new Error('No 2Captcha API key set');

  // Get CAPTCHA image as base64
  const captchaEl = await page.$(captchaSelector);
  if (!captchaEl) throw new Error('CAPTCHA element not found');

  const captchaBase64 = await page.evaluate(el => {
    const canvas = document.createElement('canvas');
    canvas.width = el.naturalWidth || el.width;
    canvas.height = el.naturalHeight || el.height;
    canvas.getContext('2d').drawImage(el, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, captchaEl);

  console.log('  Sending CAPTCHA to 2Captcha...');
  const result = await solver.imageCaptcha(captchaBase64);
  console.log(`  CAPTCHA solved: "${result.data}"`);
  return result.data;
}

// Scrape a single case from DHC
async function scrapeCase(browser, caseInput) {
  const parsed = parseCaseNumber(caseInput);
  console.log(`\nScraping: ${caseInput}`);

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(DHC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('form', { timeout: 10000 });

    // Fill in case type
    const typeSelectors = ['select[name="case_type"]', 'select#case_type', 'select[name="caseType"]'];
    for (const sel of typeSelectors) {
      try {
        await page.select(sel, parsed.type);
        break;
      } catch(_) {}
    }

    // Fill in case number
    const numSelectors = ['input[name="case_no"]', 'input#case_no', 'input[name="caseNo"]'];
    for (const sel of numSelectors) {
      try {
        await page.type(sel, parsed.number, { delay: 50 });
        break;
      } catch(_) {}
    }

    // Fill in year
    const yearSelectors = ['select[name="year"]', 'select#year', 'input[name="year"]'];
    for (const sel of yearSelectors) {
      try {
        const tag = await page.$eval(sel, el => el.tagName.toLowerCase());
        if (tag === 'select') await page.select(sel, parsed.year);
        else await page.type(sel, parsed.year, { delay: 50 });
        break;
      } catch(_) {}
    }

    // Solve CAPTCHA
    const captchaSelectors = ['img#captcha', 'img.captcha', 'img[src*="captcha"]'];
    let captchaSolved = false;
    for (const sel of captchaSelectors) {
      try {
        const exists = await page.$(sel);
        if (exists) {
          const solution = await solveCaptcha(page, sel);
          const inputSelectors = ['input[name="captcha"]', 'input#captcha', 'input[name="cap_code"]'];
          for (const iSel of inputSelectors) {
            try {
              await page.type(iSel, solution, { delay: 50 });
              captchaSolved = true;
              break;
            } catch(_) {}
          }
          break;
        }
      } catch(_) {}
    }

    if (!captchaSolved) console.log('  Warning: No CAPTCHA found or could not solve');

    // Submit form
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('input[type="submit"], button[type="submit"]')
    ]);

    // Parse the results page
    const data = await page.evaluate((caseInput) => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.trim() : null;
      };

      const getAllText = (sel) => {
        return Array.from(document.querySelectorAll(sel)).map(el => el.textContent.trim());
      };

      // Extract table rows — DHC shows case info in tables
      const tables = Array.from(document.querySelectorAll('table'));
      const extracted = {};

      tables.forEach(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (cells.length >= 2) {
            const key = cells[0].textContent.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
            const val = cells[1].textContent.trim();
            if (key && val) extracted[key] = val;
          }
        });
      });

      // Try to extract hearing history table
      const hearingRows = [];
      document.querySelectorAll('table tr').forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 2) {
          const cellText = cells.map(c => c.textContent.trim());
          // Look for date patterns in cells
          const datePattern = /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/;
          if (datePattern.test(cellText[0]) || datePattern.test(cellText[1])) {
            hearingRows.push(cellText);
          }
        }
      });

      return { extracted, hearingRows, pageTitle: document.title, pageText: document.body.innerText };
    }, caseInput);

    // Parse extracted data into our format
    const result = buildCaseObject(parsed, data);
    await page.close();
    return result;

  } catch (err) {
    await page.close();
    console.error(`  Error scraping ${caseInput}: ${err.message}`);
    return {
      caseNo: caseInput,
      error: err.message,
      lastScraped: new Date().toISOString()
    };
  }
}

// Convert raw scraped data into LexTrack matter format
function buildCaseObject(parsed, raw) {
  const { extracted, hearingRows } = raw;

  // Extract parties (plaintiff v defendant)
  const title =
    extracted['petitioner'] && extracted['respondent']
      ? `${extracted['petitioner']} v. ${extracted['respondent']}`
      : extracted['party_name'] || extracted['case_title'] || parsed.raw;

  // Extract dates
  const nextDate = extracted['next_date_of_hearing'] ||
    extracted['next_hearing_date'] ||
    extracted['next_date'] || null;

  const lastDate = extracted['last_date_of_hearing'] ||
    extracted['last_hearing_date'] ||
    extracted['date_of_hearing'] || null;

  // Extract judge
  const judge = extracted['judge'] ||
    extracted['bench'] ||
    extracted['coram'] || null;

  // Build timeline from hearing history rows
  const timeline = hearingRows.map((row, i) => ({
    date: normaliseDate(row[0] || row[1]),
    event: row[2] || row[1] || 'Hearing',
    detail: row[3] || row[2] || ''
  })).filter(t => t.date);

  // Determine IPR type from case type
  const type = guessType(parsed.type);

  // Determine stage
  const stageRaw = extracted['case_status'] || extracted['status'] || '';
  const stage = guessStage(stageRaw);

  return {
    id: `m_${parsed.type.replace(/[^a-z0-9]/gi, '')}_${parsed.number}_${parsed.year}`,
    caseNo: parsed.raw,
    title,
    type,
    stage,
    judge,
    client: null,           // Ishi fills this in the app
    lastDate: normaliseDate(lastDate),
    nextDate: normaliseDate(nextDate),
    notes: extracted['remarks'] || extracted['notes'] || null,
    timeline,
    tasks: [],
    docs: [],
    lastScraped: new Date().toISOString()
  };
}

function guessType(caseType) {
  const t = caseType.toLowerCase();
  if (t.includes('cs') || t.includes('comm')) return 'trademark';
  if (t.includes('pat')) return 'patent';
  if (t.includes('copy')) return 'copyright';
  if (t.includes('des')) return 'design';
  return 'trademark';
}

function guessStage(status) {
  const s = status.toLowerCase();
  if (s.includes('dispos') || s.includes('decid') || s.includes('decreed')) return 'disposed';
  if (s.includes('reserv')) return 'reserved';
  if (s.includes('arg')) return 'arguments';
  if (s.includes('plead') || s.includes('written statement') || s.includes('reply')) return 'pleadings';
  return 'filed';
}

// Convert various date formats to YYYY-MM-DD
function normaliseDate(raw) {
  if (!raw) return null;
  raw = raw.trim();

  // DD-MM-YYYY or DD/MM/YYYY
  let m = raw.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

  // YYYY-MM-DD already
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return raw;

  // DD Mon YYYY (e.g. 15 Jan 2025)
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                   jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  m = raw.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i);
  if (m && months[m[2].toLowerCase()]) {
    return `${m[3]}-${months[m[2].toLowerCase()]}-${m[1].padStart(2,'0')}`;
  }

  return null;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  console.log(`LexTrack DHC Scraper`);
  console.log(`Cases to scrape: ${cases.length}`);
  console.log(`2Captcha: ${solver ? 'Connected' : 'NOT SET — set TWO_CAPTCHA_API_KEY'}`);

  if (TEST_MODE) {
    console.log('\n[TEST MODE] Validating case numbers only...');
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

  if (!solver) {
    console.error('\nERROR: TWO_CAPTCHA_API_KEY environment variable not set.');
    console.error('Get your API key from https://2captcha.com and add it as a GitHub Secret.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = [];
  for (const caseNo of cases) {
    const data = await scrapeCase(browser, caseNo);
    results.push(data);

    // Polite delay between requests — don't hammer DHC
    console.log('  Waiting 4 seconds before next case...');
    await new Promise(r => setTimeout(r, 4000));
  }

  await browser.close();

  // Merge with existing data (preserve client field and manual notes)
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch(_) {}

  const merged = results.map(fresh => {
    const old = existing.find(e => e.caseNo === fresh.caseNo);
    if (old) {
      return {
        ...fresh,
        client: old.client || fresh.client,   // preserve client name
        notes: fresh.notes || old.notes,       // prefer fresh notes, fallback to old
        tasks: old.tasks || [],                // preserve tasks
        docs: old.docs || []                   // preserve docs
      };
    }
    return fresh;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Scraped ${results.length} cases → data/scraped.json`);
  console.log(`✓ ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
