# LexTrack — Setup Guide for Your Lawyer Friend

## Step 1: Share the HTML File

1. Download `LexTrack-IPR-App.html` from Downloads folder
2. Send it to your friend via email/WhatsApp/Drive
3. They open it in any browser (Chrome, Safari, Firefox) — no installation needed

**That's it — the app runs locally on their computer.**

---

## Step 2: Populate with Real Case Data

The app currently has 5 sample cases. To add real ones:

### Option A: Manual Entry (Quick)
1. Click **+ New Matter** in the top right
2. Fill in:
   - Case Title (e.g., "ABC Ltd. v. XYZ Ltd.")
   - Case Number (e.g., "CS(COMM)/441/2024")
   - IPR Type (Trademark/Patent/Copyright/Design/GI)
   - Stage (Filed/Pleadings/Arguments/Reserved/Disposed)
   - Client Name
   - Last Date of Hearing
   - Next Date of Hearing
   - Notes
3. Click **Add Matter** — appears instantly

### Option B: Edit the HTML (Bulk Import)
For adding 10+ cases at once:

1. Open `LexTrack-IPR-App.html` in a text editor (VS Code, Notepad, etc.)
2. Find this section (around line 1389):
```javascript
let matters = [
  {
    id: 'm1',
    title: 'Pepsico Inc. v. Parle Agro Pvt. Ltd.',
    caseNo: 'CS(COMM)/441/2024',
    type: 'trademark',
    stage: 'arguments',
    client: 'Pepsico India',
    lastDate: fmt(addDays(today,-14)),
    nextDate: fmt(addDays(today,2)),
    notes: 'Interim injunction granted. Next hearing on liability.',
    timeline: [ ... ],
    tasks: [ ... ],
    docs: [ ... ]
  },
  // MORE CASES HERE
];
```

3. **Replace the sample cases** with real ones. Template:
```javascript
{
  id: 'm6',
  title: 'Party A v. Party B',
  caseNo: 'CS(COMM)/123/2024',
  type: 'trademark',  // or patent, copyright, design, gi
  stage: 'pleadings',  // or filed, arguments, reserved, disposed
  client: 'Client Name',
  lastDate: '2024-05-15',  // YYYY-MM-DD
  nextDate: '2024-06-20',
  notes: 'Brief note about case status',
  timeline: [
    { date: '2024-01-10', event: 'Suit filed', detail: 'Plaint with IA' },
    { date: '2024-02-20', event: 'Notice issued', detail: 'Defendant served' }
  ],
  tasks: [
    { id: 't1', title: 'File written statement', due: '2024-06-10', priority: 'P1', done: false, source: 'manual' }
  ],
  docs: [
    { name: 'Plaint.pdf', type: 'Plaint', size: '1.5 MB' }
  ]
}
```

4. Save the file, refresh the browser — real cases now appear.

---

## Step 3: Add Claude API for Live AI Analysis

### Without API Key:
The app shows smart demo mode (generic but helpful insights). Your friend can use it as-is.

### With API Key (Recommended):
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account (free tier gives ₹100 credits/month)
3. Get an API key
4. **In the HTML file,** find line 1854 and line 1975:
```javascript
headers: { 'Content-Type': 'application/json' },
```

Add your API key like this:
```javascript
headers: { 
  'Content-Type': 'application/json',
  'x-api-key': 'sk-ant-YOUR_API_KEY_HERE'  // ADD THIS LINE
},
```

5. Save, refresh browser
6. Click **✦ AI Analysis** on any matter → real Claude analysis

---

## Step 4: Auto-Sync from Delhi High Court (Optional)

Your friend wants to auto-fetch case dates from eCourts?

Use the GitHub Actions scraper (below). This runs every night and updates case dates automatically.

---

## Keyboard Shortcuts

- **Ctrl/Cmd + K** — Quick case search (if enabled)
- Click matter title → Open full detail page
- Click ✦ AI Analysis → Get AI insights
- Click task checkbox → Mark done/undone

---

## What Gets Saved?

Everything is saved in the **browser's local storage**. 
- Matters
- Tasks
- Hearing dates
- Document links

**Important:** If your friend clears browser cache, data resets. To backup: they can take screenshots or export the HTML file itself (which contains the data).

---

## Troubleshooting

### "AI Analysis shows demo mode"
→ API key not connected. Either:
1. Add API key (see Step 3)
2. Or use demo mode (good enough for mock-ups)

### "My data disappeared"
→ Browser cache cleared. Always backup by saving the HTML file.

### "Can't add matter"
→ Refresh browser, try again. Check browser console (F12 → Console tab) for errors.

---

## Next: Automate DHC Sync (GitHub Actions)

If your friend wants nightly auto-sync from Delhi High Court, give them the `SCRAPER_SETUP.md` file (below) and they can set it up on GitHub.
