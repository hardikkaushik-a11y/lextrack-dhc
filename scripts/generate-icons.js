#!/usr/bin/env node
/**
 * Generate PWA icons for LexTrack at three required sizes:
 *   - 192x192  (Android Chrome standard)
 *   - 512x512  (Android Chrome high-res / splash)
 *   - 180x180  (iOS apple-touch-icon)
 *
 * Renders an HTML mockup of the icon (gold "L" on black, Playfair serif
 * matching the app's brand) into a Puppeteer page, then screenshots the
 * icon container at each size.
 *
 * Run: node scripts/generate-icons.js
 */
const puppeteer = require('puppeteer-extra');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
  { size: 180, file: 'apple-touch-icon.png' },
  // Android adaptive (maskable) icon — needs safe area padding so the
  // launcher can crop it to a circle/squircle without clipping the mark.
  { size: 512, file: 'icon-512-maskable.png', maskable: true }
];

const iconHTML = ({ size, maskable }) => `<!DOCTYPE html><html><head><style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&display=swap');
  html, body { margin:0; padding:0; background:transparent; }
  .icon {
    width: ${size}px;
    height: ${size}px;
    background: #0f0e0c;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    border-radius: ${maskable ? '0' : Math.round(size * 0.22)}px;
  }
  .icon::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 30% 25%, rgba(201,168,76,0.18), transparent 55%);
  }
  .L {
    font-family: 'Playfair Display', serif;
    font-weight: 900;
    color: #c9a84c;
    font-size: ${maskable ? size * 0.45 : size * 0.62}px;
    line-height: 1;
    letter-spacing: -0.04em;
    margin-top: ${maskable ? -size * 0.02 : -size * 0.04}px;
    margin-left: ${-size * 0.03}px;
    text-shadow: 0 ${Math.round(size * 0.01)}px ${Math.round(size * 0.03)}px rgba(0,0,0,0.4);
    z-index: 1;
  }
  .accent {
    position: absolute;
    bottom: ${maskable ? size * 0.22 : size * 0.18}px;
    right: ${maskable ? size * 0.22 : size * 0.18}px;
    width: ${size * 0.09}px;
    height: ${size * 0.09}px;
    border-radius: 50%;
    background: #c9a84c;
    box-shadow: 0 0 ${size * 0.04}px rgba(201,168,76,0.55);
    z-index: 1;
  }
</style></head><body>
  <div class="icon"><div class="L">L</div><div class="accent"></div></div>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const spec of SIZES) {
    const page = await browser.newPage();
    await page.setViewport({ width: spec.size, height: spec.size, deviceScaleFactor: 1 });
    await page.setContent(iconHTML(spec), { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    const el = await page.$('.icon');
    const outFile = path.join(OUT_DIR, spec.file);
    await el.screenshot({ path: outFile, omitBackground: true });
    console.log(`✓ ${spec.file} (${spec.size}x${spec.size}${spec.maskable ? ', maskable' : ''})`);
    await page.close();
  }

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
