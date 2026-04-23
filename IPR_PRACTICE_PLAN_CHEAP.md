# IPR Practice App — ZERO-COST Version

## The Goal: Free Forever (or <₹500/month)

---

## Cost Breakdown: Ultra-Cheap Stack

| Component | Old Cost | New Cost | What Changed |
|-----------|----------|----------|--------------|
| Backend Server | ₹500-1000 | **₹0** | GitHub Pages (static) + Vercel Functions (free tier) |
| Database | ₹500 | **₹0** | SQLite (local file) → Supabase free tier (5MB, 500MB bandwidth) |
| Claude API | ₹500-2000 | **₹0-500** | Rate limit to 1 summary/day + bulk processing |
| OCR | ₹0 | **₹0** | Keep Tesseract.js (free) |
| Scraper Server | ₹500 | **₹0** | Run as GitHub Action (free, scheduled nightly) |
| Notifications | ₹500-2000 | **₹0** | Use free email (Gmail SMTP) |
| **TOTAL** | **₹2500-6000** | **₹0-500** | **80% cost reduction** |

---

## New Architecture (100% Free)

```
Your Computer (Local SQLite Database)
    ↓
GitHub Actions (free scheduled scraper, runs nightly)
    ↓
Supabase (free PostgreSQL, syncs with GitHub)
    ↓
Vercel (free React frontend)
    ↓
Vercel Functions (free API layer)
    ↓
Claude API (pay only for actual summaries: ~₹50-100/month)
```

---

## Phase-by-Phase Cost Optimization

### PHASE 1: Frontend (Day 1)

**Cost: ₹0**

- Deploy React app on **Vercel** (free, unlimited projects)
- No backend needed yet
- UI uses mock data

**Why free:**
- Vercel free tier: unlimited static sites, 100GB bandwidth

---

### PHASE 2: Scraper (Day 2-3)

**Cost: ₹0**

**Instead of:** Dedicated Node.js server running 24/7

**Use:** GitHub Actions (free)

**How it works:**
- Write a JavaScript scraper locally
- Push to GitHub
- GitHub Actions runs it automatically every night at 11 PM
- Scraper saves data to a JSON file in your repo
- React app reads that JSON file

**Code Structure:**
```
your-repo/
├── data/
│   ├── cases.json          ← GitHub Actions updates this nightly
│   └── case-details/
│       ├── case-001.json
│       ├── case-002.json
└── .github/
    └── workflows/
        └── daily-scrape.yml  ← Runs scraper automatically
```

**GitHub Actions Workflow (.github/workflows/daily-scrape.yml):**
```yaml
name: Nightly Case Scraper

on:
  schedule:
    - cron: '0 23 * * *'  # 11 PM daily

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - run: npm install puppeteer
      - run: node scraper.js
      
      - name: Commit changes
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add data/
          git commit -m "Auto: Updated case data"
          git push
```

**Why this is free:**
- GitHub Actions free tier: 2,000 minutes/month (enough for daily scrapes)
- No server costs
- Data lives in your GitHub repo

---

### PHASE 3: Database (Day 1)

**Cost: ₹0**

**Instead of:** PostgreSQL server (₹500/month)

**Use:** Supabase Free Tier OR just SQLite

**Option A: SQLite (Simplest)**
- Database is just a `.db` file in your repo
- App reads/writes from it
- Syncs to Supabase occasionally (backup)
- Cost: **₹0**

**Option B: Supabase Free Tier (Scalable)**
- 500MB database size
- 5GB bandwidth
- Real-time sync
- Cost: **₹0** (until you hit limits)

**Recommendation:** Start with Option A (SQLite), graduate to Supabase if you add >100 cases

---

### PHASE 4: OCR (Day 4)

**Cost: ₹0**

Keep Tesseract.js (already free). Process PDFs asynchronously so it doesn't block the app.

**Optimization:** Only OCR new PDFs
- Store a list of "already-OCR'd PDFs"
- Skip previously processed files
- Reduces processing time by 90%

---

### PHASE 5: Claude AI Summarization (Day 5)

**Cost: ₹100-500/month** (best you can do unless you use cheaper LLMs)

**Ways to minimize:**

#### Option 1: Batch Summaries (Save 50%)
Instead of summarizing each case immediately:
- Collect 5-10 new cases
- Summarize once per week in bulk
- Reduces API calls significantly

#### Option 2: Use Cheaper Claude Models
- **claude-opus-4-7** (current): ₹15 per 1M input tokens
- **claude-sonnet-4-6** (faster, cheaper): ₹3 per 1M input tokens
- Savings: **80% cheaper**, still high quality

**Recommendation:** Use **Sonnet 4.6** for summaries, Opus only for complex analysis

#### Option 3: Cache Summaries
- Once summarized, never summarize again
- Store in database
- Reuse forever
- Savings: Near 100% after first month

#### Option 4: Hybrid Approach (Recommended)
```javascript
// Check if we already have a summary
if (case.summary_cached) {
  return case.summary_cached;  // Free
}

// Only call API if missing
const summary = await claude.summarize(orderText);
cacheForever(case.id, summary);
return summary;  // ₹0.01-0.05
```

**Estimated cost:**
- Month 1: ₹200 (summarize all existing cases)
- Month 2+: ₹50 (only new cases)

---

### PHASE 6: Notifications (Day 6)

**Cost: ₹0**

**Instead of:** Twilio SMS (₹5 per message)

**Use:** Gmail (free)

```javascript
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_APP_PASSWORD  // Not your main password
  }
});

await transporter.sendMail({
  from: process.env.GMAIL_EMAIL,
  to: process.env.LAWYER_EMAIL,
  subject: `⚠️ New order in Case ${caseNumber}`,
  html: `<h3>Critical Action Needed</h3>...`
});
```

**Why free:**
- Gmail allows 500 emails/day free
- You'll send maybe 1-2/day

---

## REVISED ARCHITECTURE (Zero-Cost)

```
Phase 1: React App (Vercel Free)
  ↓
Phase 2: GitHub Actions Scraper (Free)
  ↓
Phase 3: SQLite Database (Local File)
  ↓
Phase 4: Tesseract OCR (Free, client-side if possible)
  ↓
Phase 5: Claude API (₹100-500/month, pay-as-you-go)
  ↓
Phase 6: Gmail Notifications (Free)
  ↓
Phase 7: GitHub Repo (Free storage + version control)
```

---

## New Timeline

| Phase | Days | Cost | What You Get |
|-------|------|------|-------------|
| 1. React Frontend (Vercel) | 1 | ₹0 | Live URL, no backend |
| 2. GitHub Actions Scraper | 2 | ₹0 | Nightly auto-fetch |
| 3. SQLite DB + Data Sync | 1 | ₹0 | Persistent storage |
| 4. Tesseract OCR | 1 | ₹0 | PDF text extraction |
| 5. Claude Summarization | 2 | ₹200 | AI insights |
| 6. Email Notifications | 1 | ₹0 | Alerts to your inbox |
| 7. Polish + Deploy | 2 | ₹0 | Live, working app |
| **TOTAL** | **10 days** | **₹200-500** | **Fully functional** |

---

## Month-by-Month Cost

| Month | What's Paid | Cost | Notes |
|-------|------------|------|-------|
| Month 1 | Claude API (50 summaries) | ₹200-300 | Initial case backlog |
| Month 2+ | Claude API (5-10 new cases) | ₹50-100 | Maintenance only |
| Year 1 | Total Claude spend | ₹600-1200 | Less than 1 coffee/day |

---

## Trade-offs (What You Lose)

| Old Feature | Cost | Trade-off |
|------------|------|-----------|
| Real-time sync | ₹500 | Once per day (nightly) — good enough for legal |
| SMS alerts | ₹500 | Email only — works on any device |
| Cloud DB failover | ₹200 | SQLite → backup to GitHub — same result |
| Instant PDF OCR | ₹300 | Batch OCR nightly → instant display — 1 refresh needed |

**None of these hurt functionality. Lawyers check email daily anyway.**

---

## Setup Instructions

### Step 1: Create GitHub Repo (Free)
```bash
git init ipr-practice-app
cd ipr-practice-app
mkdir -p .github/workflows data/case-details
touch scraper.js data/cases.json
```

### Step 2: Create GitHub Actions Workflow
File: `.github/workflows/daily-scrape.yml`
```yaml
name: Nightly Scraper
on:
  schedule:
    - cron: '0 23 * * *'
  workflow_dispatch:

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm install puppeteer
      - run: node scraper.js
      - run: |
          git config user.email "action@github.com"
          git config user.name "GH Action"
          git add data/
          git commit -m "Auto: Case data updated" || true
          git push
```

### Step 3: Write Scraper (scraper.js)
```javascript
const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrapeCases() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Your case numbers (edit this)
  const caseNumbers = ['2024/DHC/12345', '2024/DHC/12346'];
  
  const allCases = [];
  
  for (let caseNum of caseNumbers) {
    await page.goto('https://services.ecourts.gov.in/ecourtssearch/');
    await page.type('input[placeholder="Case Number"]', caseNum);
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    
    const caseData = await page.evaluate(() => {
      return {
        caseNumber: document.querySelector('.case-number')?.textContent,
        nextDate: document.querySelector('.next-date')?.textContent,
        lastDate: document.querySelector('.last-date')?.textContent,
        status: document.querySelector('.status')?.textContent,
      };
    });
    
    allCases.push(caseData);
  }
  
  fs.writeFileSync('data/cases.json', JSON.stringify(allCases, null, 2));
  
  await browser.close();
}

scrapeCases().catch(console.error);
```

### Step 4: Deploy React App to Vercel
```bash
# Create React app
npx create-react-app ipr-app
cd ipr-app

# Connect to GitHub
git remote add origin https://github.com/YOUR_USERNAME/ipr-practice-app
git push -u origin main

# Deploy to Vercel (automatic)
# Just go to vercel.com, import your GitHub repo, click deploy
# Done in 30 seconds
```

### Step 5: Read Data from GitHub in React
```javascript
// In your React component
import { useEffect, useState } from 'react';

export function CasesList() {
  const [cases, setCases] = useState([]);
  
  useEffect(() => {
    // Read from GitHub raw content
    fetch('https://raw.githubusercontent.com/YOUR_USERNAME/ipr-practice-app/main/data/cases.json')
      .then(r => r.json())
      .then(setCases);
  }, []);
  
  return (
    <div>
      {cases.map(c => (
        <div key={c.caseNumber}>
          <h3>{c.caseNumber}</h3>
          <p>Next: {c.nextDate}</p>
        </div>
      ))}
    </div>
  );
}
```

---

## Why This Actually Works

1. **GitHub Actions runs scraper nightly** → No server needed
2. **Vercel hosts React for free** → No hosting costs
3. **SQLite in repo** → No database server needed
4. **Claude API** → Only ₹200-500/month (unavoidable for AI)
5. **Gmail notifications** → Free SMTP

**Total monthly cost: ₹200-500 (just Claude API)**

---

## What You'll Have

✅ Live app at `yourapp.vercel.app`
✅ Nightly auto-sync of all cases
✅ AI summaries of orders
✅ Full case timelines
✅ Email alerts
✅ Mobile-friendly dashboard
✅ Everything in a GitHub repo (backup + version control)

---

## The Only Real Cost

**Claude API: ₹200-500/month**

This is because:
- You need AI to summarize complex legal orders
- No free LLM is good enough for law
- Claude is the cheapest option that works

If you want ZERO cost:
- Use GPT-4 free trial (limited)
- Use Llama locally (worse quality)
- Hand-summarize orders (defeats the purpose)

---

## Next Steps

**You decide:**

1. ✅ **Approve this zero-cost version** → I build it
2. 🤔 **Ask questions** → Clarify anything
3. ⚡ **Make changes** → Tell me what to adjust

Once you approve, I'll generate exact code ready to deploy.
