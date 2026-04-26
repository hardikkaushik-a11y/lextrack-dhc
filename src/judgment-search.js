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
    // ── CAPTCHA INTERCEPTOR ────────────────────────────────────────────
    // Patch every canvas text method so we catch the answer regardless
    // of how it's drawn. Installed via evaluateOnNewDocument so it's
    // active before the page's own JS runs.
    await page.evaluateOnNewDocument(() => {
      window.__capturedCaptchas = [];
      window.__captchaCalls = [];
      const proto = CanvasRenderingContext2D.prototype;
      ['fillText', 'strokeText'].forEach(method => {
        const orig = proto[method];
        proto[method] = function (text, ...rest) {
          try {
            window.__captchaCalls.push({ method, text: String(text).substring(0, 20) });
            if (typeof text === 'string' && text.length >= 1 && text.length <= 20) {
              window.__capturedCaptchas.push(text);
            }
          } catch (_) {}
          return orig.call(this, text, ...rest);
        };
      });
      // Also: capture characters drawn one-at-a-time by concatenating
      // sequential single-char fills (common in captcha rendering)
    });

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

    // Comprehensive CAPTCHA reconnaissance — dump everything that could
    // plausibly hold the expected answer. We're trying to find the
    // equivalent of the DHC case-status #randomid hidden input.
    const captchaInfo = await page.evaluate(() => {
      const captchaInput = document.querySelector('input[placeholder*="Captcha" i]');
      if (!captchaInput) return { present: false };

      const out = { present: true, candidates: [] };

      // 1. ALL hidden inputs (no name filter)
      document.querySelectorAll('input[type="hidden"]').forEach(el => {
        if (el.value && el.value.length < 20) {
          out.candidates.push({ via: `hidden#${el.id || el.name || '?'}`, value: el.value, name: el.name, id: el.id });
        }
      });

      // 2. ANY input/select with a value that looks like a captcha (4-10 alnum)
      document.querySelectorAll('input, select').forEach(el => {
        if (el === captchaInput) return;
        const v = (el.value || '').trim();
        if (/^[A-Za-z0-9]{4,10}$/.test(v)) {
          out.candidates.push({ via: `value-pattern ${el.tagName.toLowerCase()}#${el.id || el.name || '?'}`, value: v, name: el.name, id: el.id });
        }
      });

      // 3. Any element whose innerText is a 4-8 alnum token AND is near the captcha
      const captchaParent = captchaInput.closest('div, form, section');
      if (captchaParent) {
        captchaParent.querySelectorAll('*').forEach(el => {
          if (el.children.length > 0) return; // leaf nodes only
          const txt = (el.innerText || el.textContent || '').trim();
          if (/^[A-Za-z0-9]{4,8}$/.test(txt)) {
            out.candidates.push({ via: `near-captcha-text ${el.tagName.toLowerCase()}.${el.className}`, value: txt });
          }
        });
      }

      // 4. <img> tags near the captcha — capture src so we know if it's image-based
      const captchaImg = captchaParent?.querySelector('img');
      if (captchaImg) {
        out.captchaImageSrc = captchaImg.src;
        out.captchaImageAlt = captchaImg.alt;
      }
      // Also any <canvas> elements (some captchas render to canvas)
      const canvas = captchaParent?.querySelector('canvas');
      if (canvas) out.captchaCanvas = { width: canvas.width, height: canvas.height };

      // 5. Inline scripts that might leak the answer
      Array.from(document.querySelectorAll('script:not([src])')).forEach(s => {
        const code = s.textContent || '';
        const matches = code.match(/captcha[^"'\n]{0,40}["'`]([A-Za-z0-9]{4,10})["'`]/gi);
        if (matches) out.candidates.push({ via: 'inline-script', value: matches[0].substring(0, 80) });
      });

      // 6. window globals that might hold it (Next.js __NEXT_DATA__, etc.)
      try {
        const nextData = document.querySelector('#__NEXT_DATA__');
        if (nextData) {
          const txt = nextData.textContent || '';
          const m = txt.match(/"captcha[^"]*"\s*:\s*"([A-Za-z0-9]{4,10})"/i);
          if (m) out.candidates.push({ via: '__NEXT_DATA__', value: m[1] });
        }
      } catch (_) {}

      // 7. localStorage / sessionStorage — long shot but cheap
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          if (/captcha/i.test(k) && /^[A-Za-z0-9]{4,10}$/.test(v.trim())) {
            out.candidates.push({ via: `localStorage[${k}]`, value: v.trim() });
          }
        }
      } catch (_) {}
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          const v = sessionStorage.getItem(k) || '';
          if (/captcha/i.test(k) && /^[A-Za-z0-9]{4,10}$/.test(v.trim())) {
            out.candidates.push({ via: `sessionStorage[${k}]`, value: v.trim() });
          }
        }
      } catch (_) {}

      // 8. Walk all data-* attrs on captcha input ancestors
      let walker = captchaInput;
      for (let depth = 0; depth < 5 && walker; depth++) {
        for (const attr of walker.attributes || []) {
          if (attr.name.startsWith('data-') && /^[A-Za-z0-9]{4,10}$/.test(attr.value || '')) {
            out.candidates.push({ via: `ancestor-attr[${depth}] ${attr.name}`, value: attr.value });
          }
        }
        walker = walker.parentElement;
      }

      return out;
    });
    console.log(`[eDHCR] CAPTCHA reconnaissance: present=${captchaInfo.present}`);
    if (captchaInfo.captchaImageSrc) console.log(`[eDHCR]   CAPTCHA image src: ${captchaInfo.captchaImageSrc.substring(0, 200)}`);
    if (captchaInfo.captchaCanvas) console.log(`[eDHCR]   CAPTCHA <canvas>: ${captchaInfo.captchaCanvas.width}x${captchaInfo.captchaCanvas.height}`);
    if (captchaInfo.candidates) {
      console.log(`[eDHCR]   Candidate values found: ${captchaInfo.candidates.length}`);
      captchaInfo.candidates.slice(0, 15).forEach(c => {
        console.log(`     - ${c.via}: "${c.value}"${c.name ? ` (name=${c.name})` : ''}${c.id ? ` (id=${c.id})` : ''}`);
      });
    }

    // Dump the captcha widget HTML so we can see how the answer is presented
    const widgetDump = await page.evaluate(() => {
      const captchaInput = document.querySelector('input[placeholder*="Captcha" i]');
      if (!captchaInput) return null;
      // Walk up 4 levels and dump each ancestor's outerHTML truncated
      const dumps = [];
      let el = captchaInput;
      for (let i = 0; i < 5 && el; i++) {
        const html = (el.outerHTML || '').replace(/\s+/g, ' ');
        dumps.push({ depth: i, tag: el.tagName.toLowerCase(), classes: el.className, html: html.substring(0, 1500) });
        el = el.parentElement;
      }
      // Also: find all <img>, <svg>, <canvas> on the entire page so we know
      // where the captcha is rendered (if it's image-based)
      const allImgs = Array.from(document.querySelectorAll('img')).map(i => ({ src: i.src.substring(0, 200), alt: i.alt, w: i.width, h: i.height })).filter(i => i.src && !/icon|logo|user|dark|light/i.test(i.src + i.alt));
      const allSvgs = Array.from(document.querySelectorAll('svg')).filter(s => s.children.length > 0).slice(0, 5).map(s => ({ classes: s.className.baseVal || '', innerHTML: (s.innerHTML || '').substring(0, 300) }));
      const allCanvas = Array.from(document.querySelectorAll('canvas')).map(c => ({ w: c.width, h: c.height, classes: c.className }));
      return { dumps, allImgs, allSvgs, allCanvas };
    });
    if (widgetDump) {
      console.log('[eDHCR] Captcha widget ancestor dump:');
      widgetDump.dumps.forEach(d => {
        console.log(`     [${d.depth}] <${d.tag} class="${d.classes}">`);
        console.log(`         ${d.html}`);
      });
      console.log(`[eDHCR] Page-wide images (non-icon): ${widgetDump.allImgs.length}`);
      widgetDump.allImgs.slice(0, 5).forEach(i => console.log(`     - ${i.w}x${i.h}: ${i.src}`));
      console.log(`[eDHCR] Page-wide SVGs (non-empty): ${widgetDump.allSvgs.length}`);
      widgetDump.allSvgs.forEach(s => console.log(`     - class="${s.classes}" inner: ${s.innerHTML}`));
      console.log(`[eDHCR] Page-wide canvases: ${widgetDump.allCanvas.length}`);
      widgetDump.allCanvas.forEach(c => console.log(`     - ${c.w}x${c.h} class="${c.classes}"`));
    }

    // Reset the interceptor's buffer, THEN click reload, so the only
    // captcha chars captured belong to the fresh captcha. (Without
    // this reset, the buffer holds the chars from the page's initial
    // captcha + the reload's captcha, and we can't tell them apart.)
    await page.evaluate(() => {
      if (window.__capturedCaptchas) window.__capturedCaptchas.length = 0;
      if (window.__captchaCalls)     window.__captchaCalls.length     = 0;
    });

    const reloadClicked = await page.evaluate(() => {
      const a = document.querySelector('#reload_href, a[id*="reload" i], button[id*="reload" i]');
      if (a) { a.click(); return true; }
      return false;
    });
    console.log(`[eDHCR] Captcha reload triggered: ${reloadClicked}`);
    await new Promise(r => setTimeout(r, 1500));

    // Diagnostic: confirm the canvas actually has pixels drawn on it.
    const canvasInfo = await page.evaluate(() => {
      const c = document.querySelector('canvas#canv, canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      try {
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonTransparent = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonTransparent++;
        return { width: c.width, height: c.height, nonTransparentPixels: nonTransparent, dataUrl: c.toDataURL().substring(0, 80) };
      } catch (e) { return { error: e.message }; }
    });
    console.log(`[eDHCR] Canvas info: ${JSON.stringify(canvasInfo)}`);

    // Read intercepted captcha calls
    const interceptDump = await page.evaluate(() => ({
      captured: window.__capturedCaptchas || [],
      allCalls: window.__captchaCalls || []
    }));
    console.log(`[eDHCR] Intercept calls (${interceptDump.allCalls.length}): ${JSON.stringify(interceptDump.allCalls.slice(0, 30))}`);
    console.log(`[eDHCR] Intercepted strings: ${JSON.stringify(interceptDump.captured)}`);

    // Build the captcha answer. After the reset+reload above, the
    // captured buffer should hold ONLY the fresh captcha's characters.
    // eDHCR draws each char with a separate fillText() call.
    let captchaAnswer = null;
    const plausibleSingle = interceptDump.captured.filter(s => /^[A-Za-z0-9]{4,10}$/.test(s));
    if (plausibleSingle.length) {
      captchaAnswer = plausibleSingle[plausibleSingle.length - 1];
    } else {
      const singleChars = interceptDump.captured.filter(s => /^[A-Za-z0-9]$/.test(s));
      if (singleChars.length >= 4) {
        // Take the last 6 chars (eDHCR captchas appear to be 6-char numeric
        // strings; defensive against any leftover chars in the buffer).
        const len = singleChars.length > 8 ? 6 : singleChars.length;
        captchaAnswer = singleChars.slice(-len).join('');
      }
    }
    console.log(`[eDHCR] Resolved captcha answer: ${JSON.stringify(captchaAnswer)}`);

    const captchaInputEl = await page.$('input[placeholder*="Captcha" i]');
    if (captchaInputEl && captchaAnswer) {
      await captchaInputEl.click({ clickCount: 3 });
      await captchaInputEl.type(captchaAnswer, { delay: 40 });
      console.log(`[eDHCR] Filled CAPTCHA with: "${captchaAnswer}"`);
    } else if (captchaInputEl) {
      console.warn(`[eDHCR] No captcha answer resolved`);
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
