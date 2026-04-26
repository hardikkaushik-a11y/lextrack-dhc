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

    // From logs: eDHCR's search field is <textarea id="search">, NOT an
    // <input>. Submit button has text "Search Now". Mode is selected via
    // separate <button> elements with text "Phrase" / "Any Words" / "All Words".
    const inputHandle = await page.$('textarea#search')
                     || await page.$('textarea[placeholder*="judgment" i]')
                     || await page.$('textarea[placeholder*="search" i]')
                     || await page.$('textarea');
    if (!inputHandle) {
      throw new Error('Could not locate the eDHCR search textarea. See [eDHCR] form-field log above.');
    }
    console.log('[eDHCR] Using textarea#search for query input');

    // Click the mode button (Phrase / Any Words / All Words). These are <button>s,
    // not radios — so we match by visible text.
    const modeClicked = await page.evaluate((wantedMode) => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => (b.innerText || '').trim().toLowerCase() === wantedMode.toLowerCase());
      if (target) { target.click(); return true; }
      return false;
    }, mode);
    console.log(`[eDHCR] Mode button "${mode}" ${modeClicked ? 'clicked' : 'not found — using default'}`);

    // Type the query into the textarea
    await inputHandle.click({ clickCount: 3 });
    await inputHandle.type(query, { delay: 30 });
    console.log(`[eDHCR] Typed query into textarea#search`);

    // Detect CAPTCHA + try to read its expected value from the DOM
    // (DHC case-status uses #randomid; eDHCR may use a similar trick)
    const captchaInfo = await page.evaluate(() => {
      const captchaInput = document.querySelector('input[placeholder*="Captcha" i]');
      if (!captchaInput) return { present: false };
      // Try common hidden-answer patterns
      const candidates = ['#randomid', '#captcha', '#captchaText', 'input[type="hidden"][name*="captcha" i]'];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.value && el.value.length < 12) return { present: true, expected: el.value, via: sel };
      }
      // Sibling/label scan — sometimes the captcha text is rendered as visible HTML
      const parent = captchaInput.closest('div,form,section');
      const visibleText = (parent?.innerText || '').match(/\b[A-Z0-9]{4,8}\b/);
      return { present: true, expected: visibleText ? visibleText[0] : null, via: 'text-scan' };
    });
    console.log(`[eDHCR] CAPTCHA: ${JSON.stringify(captchaInfo)}`);
    if (captchaInfo.present && captchaInfo.expected) {
      const captchaInput = await page.$('input[placeholder*="Captcha" i]');
      if (captchaInput) {
        await captchaInput.click({ clickCount: 3 });
        await captchaInput.type(captchaInfo.expected, { delay: 30 });
        console.log(`[eDHCR] Filled CAPTCHA with "${captchaInfo.expected}" (via ${captchaInfo.via})`);
      }
    } else if (captchaInfo.present) {
      console.warn('[eDHCR] CAPTCHA present but answer not found — submit may fail');
    }

    // Click the "Search Now" button by text (more reliable than [type="submit"]
    // because the page has multiple submit buttons)
    const submitClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => /search\s*now/i.test(b.innerText || ''));
      if (target) { target.click(); return true; }
      return false;
    });
    console.log(`[eDHCR] "Search Now" button clicked: ${submitClicked}`);

    if (!submitClicked) {
      // Last resort: press Enter inside the textarea
      await inputHandle.press('Enter');
      console.log('[eDHCR] Submitted via Enter key (fallback)');
    }

    // eDHCR likely renders results via AJAX into the same page rather than
    // navigating away. Wait for either a navigation or a results container.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
      page.waitForSelector('table tbody tr, .results, .result-item, [class*="result" i] a[href]', { timeout: 25000 }).catch(() => null)
    ]);
    await new Promise(r => setTimeout(r, 2500));

    // Snapshot what's on screen now so we can see if the search worked
    const postUrl = page.url();
    const bodyTextSample = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').substring(0, 600));
    console.log(`[eDHCR] After submit — URL: ${postUrl}`);
    console.log(`[eDHCR] Page text (first 600 chars): ${bodyTextSample}`);

    // Parse the results page. eDHCR uses a React/Next-style SPA where
    // each result is rendered as a card with its title + metadata.
    // We try the structured approach first, and dump diagnostic info
    // about the DOM if it doesn't yield enough.
    const { results, diagnostics } = await page.evaluate(() => {
      const items = [];
      const seen = new Set();

      // Helpers
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const isResultTitle = t => t.length > 12 && t.length < 350 && !/^(home|search|view|read|next|prev|page|english|hindi|all\s+rights)/i.test(t);

      // Strategy A: cards with anchors pointing to judgment pages
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        const isLikely = /(judg|order|case|cite|doc|pdf|view)/i.test(href) && !/(manual|userman|home|about|contact|cdn|css|\.png|\.jpg|\.svg)/i.test(href);
        if (!isLikely) return;
        if (seen.has(href)) return;
        const text = clean(a.innerText || a.textContent);
        if (!isResultTitle(text)) return;
        seen.add(href);
        const card = a.closest('article, li, tr, [class*="card" i], [class*="result" i], [class*="item" i], div');
        const context = card ? clean(card.innerText) : text;
        items.push({ title: text.substring(0, 280), link: href, context: context.substring(0, 600) });
      });

      // Strategy B: card-shaped <div>s with substantial text, even without an anchor.
      // eDHCR sometimes renders the result row + a separate "View" button.
      if (items.length < 3) {
        document.querySelectorAll('div, article, li').forEach(node => {
          const txt = clean(node.innerText);
          if (!isResultTitle(txt)) return;
          if (txt.length < 30) return;
          // Look for an action link inside
          const link = node.querySelector('a[href]');
          const href = link ? link.href : '';
          if (href && seen.has(href)) return;
          if (!href && items.some(i => i.title === txt.substring(0, 280))) return;
          if (href) seen.add(href);
          // Heuristic: must look like a judgment line (contains "v." or "vs" or court+year)
          const looksLikeCase = /\b(v\.?|vs\.?|versus)\b/i.test(txt) || /\b(19|20)\d{2}\b/.test(txt);
          if (!looksLikeCase) return;
          items.push({ title: txt.substring(0, 280), link: href || '', context: txt.substring(0, 600) });
        });
      }

      // Diagnostics — emit a sample of the DOM so we can iterate quickly
      const diagnostics = {
        anchorCount: document.querySelectorAll('a[href]').length,
        cardCount: document.querySelectorAll('[class*="card" i], [class*="result" i], [class*="item" i]').length,
        sampleClassList: Array.from(document.querySelectorAll('div, li, article'))
          .filter(n => /v\.|vs\.|trademark|passing|infringement|registration/i.test(n.innerText || ''))
          .slice(0, 5)
          .map(n => ({ tag: n.tagName.toLowerCase(), classes: n.className, snippet: clean(n.innerText).substring(0, 200) }))
      };

      return { results: items.slice(0, 50), diagnostics };
    });

    console.log(`[eDHCR] Parsed ${results.length} candidate results`);
    console.log(`[eDHCR] DOM diagnostics: anchors=${diagnostics.anchorCount}, cards=${diagnostics.cardCount}`);
    diagnostics.sampleClassList.forEach((s, i) => {
      console.log(`[eDHCR]   sample ${i + 1}: <${s.tag} class="${s.classes}"> "${s.snippet}"`);
    });

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
