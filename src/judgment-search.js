/**
 * eDHCR judgment search — Stage 2 of the Legal Research feature.
 *
 * Scrapes https://edhcr.nic.in/ which is the official Delhi High Court
 * Digital Reports (the authoritative DHC equivalent of SCC Online).
 *
 * Triggered on-demand by the search-judgments.yml workflow with a query
 * passed via the SEARCH_QUERY env var. Writes results to
 * data/searches/<hash>.json which the browser polls for.
 *
 * Design notes:
 *   - eDHCR's form is server-rendered. We inspect it at runtime instead
 *     of hard-coding selectors so a UI redesign on their end doesn't
 *     instantly break us — the scraper logs every field it finds.
 *   - Puppeteer-extra + stealth (same as the case-status scraper) so
 *     we look like a real browser.
 *   - On any failure we still write a JSON file with { error, query }
 *     so the browser-side polling knows to stop waiting.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDHCR_URL = 'https://edhcr.nic.in/';
const SEARCHES_DIR = path.join(__dirname, '../data/searches');

// Make a stable filename for a query so the browser can poll for it.
function queryHash(query, mode) {
  return crypto.createHash('sha1').update(`${mode}|${query}`).digest('hex').substring(0, 12);
}

// Inspect the form on eDHCR — returns the input/select/button selectors
// that look right. Logs everything it finds so we can iterate.
async function inspectSearchForm(page) {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, select, textarea, button'));
    return inputs.map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      name: el.name || null,
      id: el.id || null,
      placeholder: el.placeholder || null,
      value: el.value || null,
      text: (el.innerText || '').substring(0, 60).trim()
    }));
  });
}

// Best-effort: find a text input that looks like the search box.
async function findSearchInput(page) {
  const candidates = await page.$$eval(
    'input[type="text"], input[type="search"], input:not([type])',
    els => els.map(el => ({ id: el.id, name: el.name, placeholder: el.placeholder }))
  );
  return candidates;
}

async function searchEDHCR(browser, query, mode = 'Any Words') {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    console.log(`\n[eDHCR] Navigating to ${EDHCR_URL}`);
    await page.goto(EDHCR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    // Snapshot the form for diagnostics
    const fields = await inspectSearchForm(page);
    console.log(`[eDHCR] Form fields detected: ${fields.length}`);
    fields.slice(0, 20).forEach(f => {
      console.log(`  - ${f.tag}${f.type ? `[${f.type}]` : ''} name="${f.name}" id="${f.id}" placeholder="${f.placeholder}" text="${f.text}"`);
    });

    // Try common selectors for the search input
    const searchSelectors = [
      'input[name="search"]',
      'input[name="searchText"]',
      'input[name="query"]',
      'input[name="keyword"]',
      'input[id*="search" i]',
      'input[id*="query" i]',
      'input[placeholder*="search" i]',
      'input[type="search"]',
      'form input[type="text"]'
    ];
    let inputHandle = null;
    for (const sel of searchSelectors) {
      inputHandle = await page.$(sel);
      if (inputHandle) {
        console.log(`[eDHCR] Search input found via selector: ${sel}`);
        break;
      }
    }
    if (!inputHandle) {
      throw new Error('Could not locate a search input on eDHCR. See [eDHCR] logs for the form fields.');
    }

    await inputHandle.click({ clickCount: 3 });
    await inputHandle.type(query, { delay: 30 });

    // Try to set the search mode (Phrase / Any Words / All Words) if exposed
    const modeMap = {
      'Phrase':     ['phrase', 'exact'],
      'Any Words':  ['any', 'or'],
      'All Words':  ['all', 'and']
    };
    const modeKeywords = modeMap[mode] || [];
    for (const kw of modeKeywords) {
      const radio = await page.$(`input[type="radio"][value*="${kw}" i]`);
      if (radio) { await radio.click(); console.log(`[eDHCR] Mode set to "${mode}" via value*="${kw}"`); break; }
      const opt = await page.$(`option[value*="${kw}" i]`);
      if (opt) { await opt.click(); break; }
    }

    // Find a search/submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Search")',
      'button[id*="search" i]',
      'button[name*="search" i]'
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
            btn.click()
          ]);
          submitted = true;
          console.log(`[eDHCR] Submitted via: ${sel}`);
          break;
        }
      } catch (_) {}
    }
    if (!submitted) {
      // Fallback: press Enter in the input
      await inputHandle.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      console.log('[eDHCR] Submitted via Enter key');
    }

    await new Promise(r => setTimeout(r, 2500));

    // Parse the results page. Try multiple plausible structures —
    // table rows, divs with case-link classes, or a generic <a href>
    // pattern that points to a judgment PDF / detail page.
    const results = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      // Strategy 1: any <a> whose href looks like a judgment doc/page
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        const isJudgmentLink = /(judgement|judgment|order|reportable|case|cnr|doc)[_-]?\d|\.pdf(\?|$)/i.test(href);
        if (!isJudgmentLink) return;
        if (seen.has(href)) return;
        seen.add(href);
        const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < 6) return;
        // Try to find surrounding context (date, judges, citation)
        const row = a.closest('tr, li, div.row, div.result, article');
        const context = row ? (row.innerText || '').replace(/\s+/g, ' ').trim() : '';
        items.push({
          title: text.substring(0, 220),
          link: href,
          context: context.substring(0, 500)
        });
      });

      return items.slice(0, 50);
    });

    console.log(`[eDHCR] Parsed ${results.length} candidate results`);

    // Normalise into the same shape as IK results so the UI can render uniformly
    const normalised = results.map(r => {
      // Pull a year out of the context if we can
      const yearMatch = r.context.match(/\b(19|20)\d{2}\b/);
      // Pull a neutral citation (YYYY:DHC:NNNN) if present
      const citationMatch = r.context.match(/\b\d{4}:DHC:\d+\b/i);
      return {
        title: r.title,
        docsource: 'Delhi High Court (eDHCR)',
        publishdate: yearMatch ? yearMatch[0] : null,
        neutralCitation: citationMatch ? citationMatch[0] : null,
        headline: r.context,
        url: r.link,
        source: 'edhcr'
      };
    });

    await page.close();
    return normalised;

  } catch (err) {
    console.error(`[eDHCR] Error: ${err.message}`);
    await page.close();
    throw err;
  }
}

async function main() {
  const query = (process.env.SEARCH_QUERY || '').trim();
  const mode  = (process.env.SEARCH_MODE  || 'Any Words').trim();
  if (!query) {
    console.error('SEARCH_QUERY env var is required');
    process.exit(1);
  }

  if (!fs.existsSync(SEARCHES_DIR)) fs.mkdirSync(SEARCHES_DIR, { recursive: true });

  const hash = queryHash(query, mode);
  const outFile = path.join(SEARCHES_DIR, `${hash}.json`);
  console.log(`Search query: "${query}" (mode=${mode})`);
  console.log(`Output: ${outFile}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const results = await searchEDHCR(browser, query, mode);
    const payload = {
      query, mode, hash,
      source: 'edhcr',
      count: results.length,
      results,
      generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
    console.log(`✓ Wrote ${results.length} results → ${outFile}`);
  } catch (err) {
    fs.writeFileSync(outFile, JSON.stringify({
      query, mode, hash, source: 'edhcr',
      error: err.message,
      results: [],
      generatedAt: new Date().toISOString()
    }, null, 2));
    console.error(`✗ Search failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
