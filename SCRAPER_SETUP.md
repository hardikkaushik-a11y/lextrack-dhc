# GitHub Actions DHC Scraper Setup

## Goal
Every night at 11 PM, automatically fetch latest case dates from Delhi High Court eCourts and update your LexTrack app.

---

## Setup (15 minutes)

### Step 1: Create a GitHub Repo (Free)

1. Go to [github.com](https://github.com) → Sign up (if needed)
2. Click **+ New** → Create new repository
   - Name: `lextrack-dhc-sync`
   - Public (free)
   - **Add README** (check box)
   - **Click Create**

### Step 2: Create Folder Structure

In your repo, create these folders:
```
lextrack-dhc-sync/
├── .github/
│   └── workflows/
│       └── dhc-scraper.yml
├── scraper.js
└── data/
    └── cases.json
```

### Step 3: Add Your Case Numbers

Create `data/cases.json`:
```json
{
  "cases": [
    "CS(COMM)/441/2024",
    "CS(COMM)/112/2024",
    "CS(COMM)/289/2023",
    "OMP(I)(COMM)/88/2024",
    "FAO(OS)(COMM)/45/2024"
  ]
}
```

Replace with your friend's **real case numbers**.

### Step 4: Create the Scraper

Create `scraper.js`:
```javascript
const puppeteer = require('puppeteer');
const fs = require('fs');

const ECOURTS_URL = 'https://services.ecourts.gov.in/ecourtssearch/';

async function scrapeCase(caseNumber) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(ECOURTS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Fill case number
    await page.type('input[name="caseNumber"], input[placeholder*="case"], input[id*="caseNumber"]', caseNumber);
    await page.click('button[type="submit"], button:contains("Search")');
    
    // Wait for results
    await page.waitForTimeout(2000);

    // Extract data
    const result = await page.evaluate((caseNo) => {
      const data = {
        caseNumber: caseNo,
        nextDate: null,
        lastDate: null,
        status: null,
        partyNames: null,
        judge: null
      };

      // Try multiple selectors
      const datePattern = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g;
      const pageText = document.body.innerText;
      const dates = pageText.match(datePattern) || [];

      if (dates.length > 0) data.lastDate = dates[0];
      if (dates.length > 1) data.nextDate = dates[1];

      // Get status
      const statusEl = document.querySelector('[class*="status"], [id*="status"]');
      if (statusEl) data.status = statusEl.textContent.trim().substring(0, 50);

      // Get parties
      const partyEl = document.querySelector('[class*="party"], [class*="parties"]');
      if (partyEl) data.partyNames = partyEl.textContent.trim().substring(0, 100);

      return data;
    }, caseNumber);

    await browser.close();
    return result;
  } catch (error) {
    console.log(`Error scraping ${caseNumber}: ${error.message}`);
    if (browser) await browser.close();
    return {
      caseNumber,
      error: error.message,
      nextDate: null,
      lastDate: null
    };
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync('data/cases.json', 'utf8'));
  const results = [];

  for (const caseNo of config.cases) {
    console.log(`Scraping ${caseNo}...`);
    const result = await scrapeCase(caseNo);
    results.push(result);
    await new Promise(r => setTimeout(r, 1000)); // Delay between requests
  }

  // Save results
  fs.writeFileSync('data/cases.json', JSON.stringify({ cases: config.cases, results }, null, 2));
  console.log('Scraping complete. Results saved to data/cases.json');
}

main().catch(console.error);
```

### Step 5: Create GitHub Actions Workflow

Create `.github/workflows/dhc-scraper.yml`:
```yaml
name: Nightly DHC Case Scraper

on:
  schedule:
    - cron: '0 23 * * *'  # 11 PM daily
  workflow_dispatch:  # Manual trigger option

jobs:
  scrape:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install puppeteer

      - name: Run scraper
        run: node scraper.js
        timeout-minutes: 10

      - name: Commit changes
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add data/cases.json
          git commit -m "🔄 Auto: DHC case data updated - $(date)" || echo "No changes"
          git push
```

### Step 6: Upload to GitHub

1. In your repo, click **Add file** → **Upload files**
2. Upload:
   - `scraper.js`
   - `.github/workflows/dhc-scraper.yml`
   - `data/cases.json`
3. Commit them

---

## Test It

1. Click **Actions** tab in your repo
2. Select **Nightly DHC Case Scraper**
3. Click **Run workflow** → **Run workflow**
4. Watch it run (takes ~5 minutes)
5. Check `data/cases.json` for results

---

## Connect to LexTrack App

Now your friend's LexTrack app can read the scraped data:

In `LexTrack-IPR-App.html`, add this function (after the `matters` array):

```javascript
// Sync from GitHub scraper
async function syncFromGitHub() {
  try {
    const response = await fetch(
      'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/lextrack-dhc-sync/main/data/cases.json'
    );
    const data = await response.json();
    
    if (data.results) {
      data.results.forEach(result => {
        const m = matters.find(x => x.caseNo === result.caseNumber);
        if (m) {
          if (result.nextDate) m.nextDate = result.nextDate;
          if (result.lastDate) m.lastDate = result.lastDate;
          if (result.status) m.notes = result.status;
        }
      });
      
      renderDashboard();
      toast('✓ DHC sync complete', 'success');
    }
  } catch (e) {
    console.error('GitHub sync failed:', e);
  }
}
```

Then add a button in the topbar to trigger sync:
```html
<button class="btn btn-ghost" onclick="syncFromGitHub()">
  🔄 Sync GitHub
</button>
```

---

## How It Works

1. **11 PM nightly:** GitHub Actions runs `scraper.js`
2. **Puppeteer opens browser:** Types case number into eCourts search
3. **Extracts data:** Next date, last date, status
4. **Saves to GitHub:** Updates `data/cases.json`
5. **LexTrack reads it:** Your friend clicks "Sync GitHub" and app pulls latest dates
6. **All automatic:** No server needed, no costs

---

## Cost

- **GitHub Actions:** Free (2,000 minutes/month included)
- **Puppeteer:** Free (runs on GitHub's servers)
- **Total:** ₹0

---

## Troubleshooting

**Scraper says "Not found"?**
- eCourts structure may have changed
- Update the selectors in `scraper.js`
- Test manually on eCourts first

**Dates not extracting?**
- eCourts might show dates differently
- Add more date pattern matching to the regex

**GitHub Action times out?**
- Increase timeout in YAML: `timeout-minutes: 15`
- Add more delays between requests: `setTimeout(3000)` instead of `1000`

---

## Once Running

Your friend has:
- ✅ LexTrack app with real case data (manual + auto-sync)
- ✅ Nightly DHC sync via GitHub (costs ₹0)
- ✅ Claude API for AI analysis (₹200-500/month, optional)
- ✅ Full case timelines, tasks, documents
- ✅ Mobile-friendly dashboard

**Total first-year cost: ₹0-2500 (just Claude API)**
