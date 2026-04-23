# IPR Practice Management App — Complete Implementation Plan

## Executive Summary
**Goal:** Enter case number → instantly see last date, next date, order summary, full case timeline, and actionable insights.

**Duration:** 10 days (if coding full-time; 2-3 weeks part-time)

**Architecture:** Frontend (HTML/React) + Backend (Node.js) + Database (PostgreSQL) + AI (Claude API)

---

## PHASE 0: Tech Stack & Architecture (Day 0-1)

### Frontend
- **Framework:** React (TypeScript) — clean, component-based
- **UI:** Tailwind CSS + shadcn/ui (clean, professional legal UI)
- **State:** TanStack Query (for server sync) + Zustand (local state)
- **Deployed on:** Vercel (free tier works)

### Backend
- **Runtime:** Node.js + Express
- **Database:** PostgreSQL (free tier on Railway or Render)
- **Scraper:** Puppeteer (headless Chrome) — controls browser automatically
- **OCR:** Tesseract.js or cloud (Google Cloud Vision)
- **AI:** Claude API (via @anthropic-ai/sdk)
- **Job Queue:** Node-cron (simple scheduling) or Bull (advanced)
- **Deployed on:** Railway or DigitalOcean ($12/month)

### Data Flow
```
User enters case number
    ↓
Frontend sends to Backend
    ↓
Backend scrapes DHC website (eCourts.gov.in)
    ↓
Backend downloads PDFs of orders
    ↓
Backend extracts text from PDFs (OCR)
    ↓
Backend sends text to Claude AI
    ↓
Claude returns: summary + next steps
    ↓
Backend stores in PostgreSQL
    ↓
Frontend displays dashboard
```

---

## PHASE 1: Frontend & Database Setup (Day 1-2)

### What Gets Built
1. **Case Input Screen**
   - Single text field: "Enter case number"
   - Button: "Fetch Case Details"
   - Loading state animation
   - Error handling

2. **Case List Screen**
   - All your cases stored locally + in DB
   - Shows: Case No., Party Name, Status, Last Date, Next Date
   - Click to open case detail

3. **Case Detail Dashboard** (empty shell for now)
   - Headers: Case info, dates, party names
   - Sections:
     - Last Hearing Date & Order Summary
     - Next Hearing Date & Cause List
     - Full Case Timeline (chronological)
     - Actionable Checklist
     - Related Documents

4. **Database Schema**
   ```sql
   CREATE TABLE cases (
     id UUID PRIMARY KEY,
     case_number VARCHAR(255) UNIQUE,
     party_name VARCHAR(500),
     judge_name VARCHAR(255),
     created_at TIMESTAMP,
     updated_at TIMESTAMP
   );

   CREATE TABLE case_history (
     id UUID PRIMARY KEY,
     case_id UUID REFERENCES cases(id),
     hearing_date DATE,
     order_summary TEXT,
     order_pdf_url VARCHAR(500),
     status VARCHAR(100),
     created_at TIMESTAMP
   );

   CREATE TABLE actionable_items (
     id UUID PRIMARY KEY,
     case_id UUID REFERENCES cases(id),
     action_description TEXT,
     due_date DATE,
     priority VARCHAR(50),
     status VARCHAR(50),
     created_at TIMESTAMP
   );

   CREATE TABLE documents (
     id UUID PRIMARY KEY,
     case_id UUID REFERENCES cases(id),
     document_type VARCHAR(100),
     document_url VARCHAR(500),
     uploaded_at TIMESTAMP
   );
   ```

### API Endpoints (Backend)
```
POST /api/cases
  Input: { case_number }
  Output: { case_id, status: "scraping" }

GET /api/cases/:case_id
  Output: { case_number, party_name, last_date, next_date, history: [] }

GET /api/cases/:case_id/timeline
  Output: Chronological case events

GET /api/cases/:case_id/actions
  Output: [ { action, due_date, priority } ]
```

**Deliverable:** React app with mock data + empty backend scaffold

---

## PHASE 2: DHC Web Scraper (Day 2-3)

### What Gets Built
A **Node.js script** using Puppeteer that:

1. Opens eCourts.gov.in/High Court of Delhi
2. Types case number in search
3. Extracts:
   - Case status
   - Parties (plaintiff, defendant)
   - Judge name
   - Last hearing date & outcome
   - Next hearing date
   - All order PDF links
4. Downloads PDF files to a folder
5. Returns data to backend in structured format

### Scraper Pseudocode
```javascript
async function scrapeDHCCase(caseNumber) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Navigate to eCourts
  await page.goto('https://services.ecourts.gov.in/ecourtssearch/');
  
  // Fill in case number
  await page.type('input[name="case_number"]', caseNumber);
  await page.click('button[type="submit"]');
  
  // Wait for results
  await page.waitForSelector('.case-details');
  
  // Extract data
  const caseData = await page.evaluate(() => {
    return {
      caseNumber: document.querySelector('.case-no')?.textContent,
      parties: document.querySelector('.parties')?.textContent,
      lastDate: document.querySelector('.last-date')?.textContent,
      nextDate: document.querySelector('.next-date')?.textContent,
      orderLinks: Array.from(document.querySelectorAll('a.order-pdf'))
        .map(a => a.href)
    };
  });
  
  // Download PDFs
  for (let link of caseData.orderLinks) {
    await downloadPDF(link);
  }
  
  await browser.close();
  return caseData;
}
```

### Key Challenge: eCourts Structure
- eCourts has CAPTCHA on some pages
- Solution: Use 2captcha service (₹100 per 1000 CAPTCHAs) OR cache results for 24hrs

**Deliverable:** Standalone scraper script that returns structured case data

---

## PHASE 3: PDF OCR & Text Extraction (Day 3-4)

### What Gets Built
A pipeline that:

1. Takes downloaded PDF (court order)
2. Extracts text using OCR (Tesseract or Google Cloud Vision)
3. Cleans up the text (remove noise, fix formatting)
4. Stores in database
5. Passes to Claude AI in Phase 4

### Why OCR Matters
Court PDFs are often scanned images (not text-searchable). Tesseract reads the image and converts to text.

### Implementation Choice
**Option A (Free):** Tesseract.js (runs in Node.js, 0 cost, slower)
**Option B (Fast):** Google Cloud Vision API (₹6 per 1000 pages, fast, requires API key)

**Recommendation:** Start with Tesseract.js, switch to Google Vision if too slow.

### Code Snippet
```javascript
const Tesseract = require('tesseract.js');
const fs = require('fs');

async function extractTextFromPDF(pdfPath) {
  const { data: { text } } = await Tesseract.recognize(pdfPath);
  return text;
}
```

**Deliverable:** OCR pipeline that converts PDFs to clean, readable text

---

## PHASE 4: AI Summarization (Claude API) (Day 4-5)

### What Gets Built
A function that:

1. Takes order text from Phase 3
2. Sends to Claude API
3. Claude returns:
   - **What happened:** 3-4 sentence summary of the order
   - **Why it matters:** Legal implications for your case
   - **What you must do:** Specific actions (file appeal, submit documents, etc.)
   - **Timeline:** Deadlines extracted from the order
   - **Threat level:** ⚠️ Critical / ⚠️ Medium / ✅ Favorable

### Claude Prompt Template
```
You are an IPR litigation lawyer assistant. Analyze this Delhi High Court order and provide:

1. WHAT HAPPENED (3-4 sentences):
   - What did the court decide?
   - Who won this round?

2. WHY IT MATTERS (2-3 sentences):
   - What does this mean for this case?
   - What legal precedent does it set?

3. ACTIONABLE NEXT STEPS (bullet points):
   - Specific documents you need to file
   - Specific dates/deadlines
   - Objections to consider
   - Appeals to consider

4. THREAT LEVEL:
   - CRITICAL (your position weakened significantly)
   - MEDIUM (mixed outcome)
   - FAVORABLE (your position strengthened)

5. RELATED CASE LAW:
   - Similar cases that might help/hurt you

---

Order Text:
[INSERT PDF TEXT HERE]
```

### Implementation
```javascript
const Anthropic = require('@anthropic-ai/sdk');

async function summarizeOrder(orderText) {
  const client = new Anthropic();
  
  const message = await client.messages.create({
    model: 'claude-opus-4-7', // Best for legal analysis
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `[PROMPT ABOVE] + ${orderText}`
      }
    ]
  });
  
  return message.content[0].text;
}
```

### Also Build: Case Summary Generator
When user first inputs case number, generate a full-case summary by:
- Scraping all orders from DHC
- Running OCR on each
- Asking Claude: "Summarize the entire case journey from first to last order"

**Deliverable:** API endpoint `/api/summarize` that takes order text and returns AI analysis

---

## PHASE 5: Dashboard & UI Integration (Day 5-6)

### What Gets Built
**Case Detail Screen showing:**

| Section | Content |
|---------|---------|
| **Case Header** | Case No., Party Names, Judge, Status |
| **Critical Dates** | Last Date (with summary) / Next Date (with cause list) |
| **Order Summary** | Latest order summary + threat level badge |
| **Full Timeline** | Chronological list of all hearings |
| **Actionable Checklist** | AI-extracted next steps with due dates |
| **Related Documents** | PDFs, pleadings, affidavits |
| **Auto-Sync Status** | "Last updated: 2 hours ago" + manual refresh button |

### Design Details
- **Color coding:** 
  - 🟢 Green = Favorable
  - 🟡 Yellow = Medium
  - 🔴 Red = Critical/Urgent
- **Mobile-first:** Works on phone while in court
- **Dark mode:** Optional (legal UI often uses dark)

**Deliverable:** Full-featured React dashboard with real data from Phases 1-4

---

## PHASE 6: Nightly Auto-Sync (Day 6-7)

### What Gets Built
A **cron job** that:

1. Every night at 11 PM:
   - Re-scrapes DHC for ALL your cases
   - Downloads new orders
   - Runs OCR + AI summarization
   - Stores in database
   - Alerts you of changes

### Implementation
```javascript
const cron = require('node-cron');

cron.schedule('0 23 * * *', async () => {
  const allCases = await db.getCases();
  
  for (let caseRecord of allCases) {
    const freshData = await scrapeDHCCase(caseRecord.case_number);
    const hasChanges = checkForNewOrders(caseRecord, freshData);
    
    if (hasChanges) {
      await notifyUser(caseRecord.lawyer_email, caseRecord);
    }
    
    await updateDatabase(caseRecord.id, freshData);
  }
});
```

**Deliverable:** Automated sync running on backend server

---

## PHASE 7: Notifications (Day 7-8)

### What Gets Built
Alert system that notifies you when:
- New order is uploaded ✉️ Email
- Hearing date is approaching 🔔 Email + SMS
- Case status changes 📲 WhatsApp (via Twilio)
- AI detects critical action needed ⚠️ Urgent email

### Integration
- **Email:** Nodemailer (free with Gmail)
- **SMS:** Twilio (₹8 per SMS)
- **WhatsApp:** Twilio WhatsApp Business API (₹5 per message)

**Decision:** Start with email only. Add SMS/WhatsApp if budget allows.

**Deliverable:** Notification system fully integrated

---

## PHASE 8: Polish & Deployment (Day 8-10)

### Frontend Deployment
- Push React app to Vercel (10 mins)
- Domain: `yourname-iprapp.vercel.app`

### Backend Deployment
- Push Node.js code to Railway or DigitalOcean
- Connect PostgreSQL database
- Set up environment variables (API keys)
- Test all endpoints

### Testing Checklist
- [ ] Case lookup works
- [ ] Scraper pulls correct data
- [ ] OCR extracts readable text
- [ ] Claude summarization is accurate
- [ ] Dashboard displays correctly
- [ ] Mobile responsive
- [ ] Auto-sync runs nightly
- [ ] Notifications send

### Security Checklist
- [ ] No API keys in frontend code
- [ ] HTTPS enforced
- [ ] Database encrypted
- [ ] Rate limiting on scraper (don't DDoS DHC)

**Deliverable:** Live, working app at custom domain

---

## Timeline & Effort Estimate

| Phase | Days | What You'll Have |
|-------|------|-----------------|
| 0 | 1 | Architecture decided, tools chosen |
| 1 | 2 | Frontend scaffold + empty dashboard |
| 2 | 2 | DHC scraper working (returns raw data) |
| 3 | 1 | OCR pipeline (PDFs → text) |
| 4 | 1 | Claude summarization (text → insights) |
| 5 | 2 | Full dashboard with real data |
| 6 | 1 | Nightly auto-sync |
| 7 | 1 | Email notifications |
| 8 | 2 | Deployment + testing |
| **TOTAL** | **13 days** | **Live app** |

---

## Cost Breakdown (Monthly)

| Component | Cost | Notes |
|-----------|------|-------|
| **Backend (Railway/DO)** | ₹500-1000 | Small Node.js server |
| **Database (PostgreSQL)** | ₹0-500 | Free tier → paid as you scale |
| **Claude API** | ₹500-2000 | ~₹0.50 per case summary |
| **Tesseract OCR** | ₹0 | Free (self-hosted) |
| **Twilio SMS** | ₹500-2000 | If you use notifications |
| **Domain** | ₹500 | Optional custom domain |
| **TOTAL** | **₹2000-6000** | ~$25-75/month |

---

## Key Decision Points (You Decide Now)

### Decision 1: Scraper Robustness
- **Option A:** Simple Puppeteer (fast to build, may break if DHC changes)
- **Option B:** Robust with error handling + fallback (slower to build, production-ready)
- **Recommendation:** Start with Option A, switch to B after first month

### Decision 2: CAPTCHA Handling
- **Option A:** Manual solve (you type CAPTCHA when prompted)
- **Option B:** 2captcha service (automatic, costs ₹100 per 1000)
- **Recommendation:** Option A for now

### Decision 3: Database
- **Option A:** PostgreSQL (professional, ₹500/month on Railway)
- **Option B:** SQLite (simple, runs locally, limited scaling)
- **Recommendation:** PostgreSQL (worth it)

### Decision 4: OCR Speed
- **Option A:** Tesseract.js (free, 30-60 seconds per PDF)
- **Option B:** Google Cloud Vision (fast, ₹6 per 1000 pages)
- **Recommendation:** Start with Tesseract, switch to Google Vision if slow

---

## What Happens After Deployment?

### Week 1-2: Testing
- Add 5-10 of your real cases
- Verify scraper accuracy
- Check AI summaries
- Fine-tune prompts

### Week 3+: Optimization
- Cache DHC data (don't re-scrape every time)
- Add case templates
- Build analytics (which issues appear most?)
- Consider: Document automation (draft pleadings automatically)

---

## Next Steps

**You decide:**

1. ✅ **Approve this plan** → I start building Phase 1 tomorrow
2. 🔄 **Modify the plan** → Tell me what to change
3. ❓ **Ask questions** → Clarify anything above

**Once you approve, I'll:**
- Generate the exact code structure
- Set up the React project
- Create the database schema
- Build the scraper
- Deploy to your own servers

Sound good?
