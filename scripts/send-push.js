#!/usr/bin/env node
/**
 * LexTrack push-notification dispatcher.
 *
 * Called from sync-all.yml + digest.yml after the scrapers run. Reads:
 *   - data/causelist.json   (current cause-list state)
 *   - data/scraped.json     (current case-status state)
 *   - HEAD versions of both (the previous committed state — i.e. what was
 *     true before this run's commit)
 *
 * Diffs the two and sends a Web Push notification to every subscriber in
 * the PUSH_SUBSCRIPTIONS secret (a JSON array) when:
 *   - a new cause-list entry shows up for a tracked matter, or
 *   - a new order PDF is added to a tracked matter, or
 *   - a tracked matter's nextDate changes
 *
 * Modes:
 *   node send-push.js          — diff mode, fires per-event pushes
 *   node send-push.js --digest — digest mode, fires ONE summary push iff
 *                                there's anything happening in the next 48h
 *                                or any new orders since 24h ago. Silent
 *                                if there's nothing to say.
 *
 * Required env vars (set as GitHub Action secrets):
 *   VAPID_PUBLIC_KEY       — same key embedded in the app
 *   VAPID_PRIVATE_KEY      — generated alongside the public one
 *   VAPID_SUBJECT          — mailto:hardik@... or https://lextrack.app
 *   PUSH_SUBSCRIPTIONS     — primary subscription secret. Either a JSON
 *                            array of PushSubscription objects, or a
 *                            single object (we accept both shapes).
 *   PUSH_SUBSCRIPTIONS_2,  — additional secrets for more devices. The
 *   PUSH_SUBSCRIPTIONS_3,    workflow yaml passes whatever exists; we
 *   ...                      iterate process.env here and merge them.
 *                            New device → add a new numbered secret in
 *                            GitHub, no code change needed.
 *
 * Failures (expired subscriptions, network errors) are logged and don't
 * fail the workflow — pushes are best-effort, never block the data sync.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const webpush = require('web-push');

const MODE = process.argv.includes('--digest') ? 'digest' : 'diff';

// ── Load secrets ────────────────────────────────────────────────────────────
const PUB  = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;

// VAPID_SUBJECT must be either mailto:… or https://… per RFC 8292. The
// web-push library rejects bare strings ("hardik@gmail.com" alone fails
// even though it looks correct). Normalize whatever the user pasted so a
// missing prefix doesn't blow up the workflow.
let SUBJ = (process.env.VAPID_SUBJECT || '').trim() || 'mailto:lextrack@example.com';
if (!/^(mailto:|https?:\/\/)/i.test(SUBJ)) {
  SUBJ = SUBJ.includes('@') ? `mailto:${SUBJ}` : `https://${SUBJ}`;
  console.log(`VAPID_SUBJECT lacked a scheme — normalized to "${SUBJ}".`);
}

if (!PUB || !PRIV) { console.error('VAPID keys missing — skipping push.'); process.exit(0); }

// Collect every PUSH_SUBSCRIPTIONS* secret the workflow exposed. Each
// secret value can be either a single PushSubscription object or a JSON
// array of them.
let subs = [];
const subscriptionEnvKeys = Object.keys(process.env)
  .filter(k => /^PUSH_SUBSCRIPTIONS(_\d+)?$/.test(k))
  .sort();
for (const key of subscriptionEnvKeys) {
  const raw = process.env[key];
  if (!raw || !raw.trim()) continue;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const s of parsed) if (s && s.endpoint) subs.push(s);
    } else if (parsed && parsed.endpoint) {
      subs.push(parsed);
    } else {
      console.warn(`${key}: parsed but not a subscription / array of subscriptions — skipping.`);
    }
  } catch (e) {
    console.warn(`${key}: not valid JSON — skipping.`);
  }
}
// Dedupe by endpoint URL. If the same device's token ends up pasted into
// two secrets (e.g. someone re-subscribes on the same phone), we'd
// otherwise send two pushes for one event.
const byEndpoint = new Map();
for (const s of subs) if (s.endpoint && !byEndpoint.has(s.endpoint)) byEndpoint.set(s.endpoint, s);
subs = [...byEndpoint.values()];

console.log(`Loaded ${subs.length} unique subscription(s) from ${subscriptionEnvKeys.length} secret(s): [${subscriptionEnvKeys.join(', ') || 'none'}]`);
if (subs.length === 0) { console.log('No subscribers, skipping push.'); process.exit(0); }

webpush.setVapidDetails(SUBJ, PUB, PRIV);

// ── Load current + previous state from git ──────────────────────────────────
function readJSON(path)        { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return null; } }
function readJSONFromHEAD(path) {
  try { return JSON.parse(execSync(`git show HEAD:${path}`, { encoding: 'utf8' })); }
  catch (e) { return null; }
}

const causeNow  = readJSON('data/causelist.json')         || { entries: [] };
const causePrev = readJSONFromHEAD('data/causelist.json') || { entries: [] };
const scrapedNow  = readJSON('data/scraped.json')         || [];
const scrapedPrev = readJSONFromHEAD('data/scraped.json') || [];

// ── Helpers ─────────────────────────────────────────────────────────────────
function entryKey(e)   { return `${e.caseNo}|${e.date}|${e.item || ''}`; }
function shortCase(no) { return (no || '').replace(/\s+/g, ''); }

function findCaseTitle(caseNo) {
  const m = scrapedNow.find(s => shortCase(s.caseNo) === shortCase(caseNo));
  return m?.title || caseNo;
}

// ── Send to all subscribers, prune expired ──────────────────────────────────
async function sendToAll(payload) {
  const body = JSON.stringify(payload);
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 24 });
      stillValid.push(sub);
      console.log(`✓ Pushed to ${(sub.endpoint || '').slice(0, 60)}…`);
    } catch (e) {
      // 404 / 410 = subscription expired — drop it. Anything else = log + keep.
      if (e.statusCode === 404 || e.statusCode === 410) {
        console.log(`✗ Dropping expired subscription (${e.statusCode})`);
      } else {
        console.warn(`✗ Push failed (${e.statusCode || '?'}): ${e.message}`);
        stillValid.push(sub);
      }
    }
  }
  return stillValid;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIFF MODE — per-event pushes
// ─────────────────────────────────────────────────────────────────────────────
async function runDiffMode() {
  const events = [];

  // 1) New cause-list entries for tracked matters
  const prevKeys = new Set((causePrev.entries || []).map(entryKey));
  const newCauseEntries = (causeNow.entries || []).filter(e => !prevKeys.has(entryKey(e)));
  for (const e of newCauseEntries) {
    const title = findCaseTitle(e.caseNo);
    const when  = e.date || 'tomorrow';
    const where = [e.court && `Court ${e.court}`, e.item && `Item ${e.item}`, e.judge].filter(Boolean).join(' · ');
    events.push({
      title: `🔔 Listed ${when}`,
      body:  `${title}${where ? '\n' + where : ''}`,
      tag:   `causelist-${e.caseNo}-${e.date}`,
      url:   './#/matter/' + encodeURIComponent(e.caseNo),
      requireInteraction: true,
    });
  }

  // 2) Per-matter changes: orders, next-date, additional listings (JR/court
  //    extracted from order text), stage, judge, status, and timeline length.
  //    Any meaningful state change in DHC's view of a tracked case triggers
  //    a push so Ishi never has to check manually.
  const prevByCase = new Map(scrapedPrev.map(s => [shortCase(s.caseNo), s]));
  const fmtDate = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  for (const m of scrapedNow) {
    const old = prevByCase.get(shortCase(m.caseNo));
    if (!old) {
      // First time we see this case (e.g. via bulk import) — one push.
      events.push({
        title: `🆕 Tracking: ${m.title || m.caseNo}`,
        body:  `${m.caseNo}${m.nextDate ? '\nNext: ' + fmtDate(m.nextDate) : ''}`,
        tag:   `tracked-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
      continue;
    }

    // 2a. New order PDFs uploaded to DHC
    const oldOrders = new Set((old.orders || []).map(o => o.url || o.date));
    const newOrders = (m.orders || []).filter(o => !oldOrders.has(o.url || o.date));
    if (newOrders.length) {
      events.push({
        title: `📄 New order — ${m.title || m.caseNo}`,
        body:  `${newOrders.length} new order${newOrders.length > 1 ? 's' : ''} uploaded${newOrders[0]?.date ? '\nLatest: ' + fmtDate(newOrders[0].date) : ''}`,
        tag:   `orders-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
    }

    // 2b. Main court next-date moved
    if (old.nextDate && m.nextDate && old.nextDate !== m.nextDate) {
      events.push({
        title: `📅 Next date changed — ${m.title || m.caseNo}`,
        body:  `${fmtDate(old.nextDate)} → ${fmtDate(m.nextDate)}`,
        tag:   `nextdate-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
    }

    // 2c. New JR / additional listings extracted from order text. Match by
    //     date+before so a single JR listing doesn't push on every sync.
    const oldAdd = new Set((old.additionalDates || []).map(e => `${e.date}|${e.before}`));
    const newAdd = (m.additionalDates || []).filter(e => !oldAdd.has(`${e.date}|${e.before}`));
    for (const e of newAdd) {
      const before = e.before === 'jr' ? 'Joint Registrar' : "Hon'ble Court";
      events.push({
        title: `📋 New listing — ${m.title || m.caseNo}`,
        body:  `Listed ${fmtDate(e.date)} before the ${before}`,
        tag:   `additional-${m.caseNo}-${e.date}-${e.before}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
        requireInteraction: true,
      });
    }

    // 2d. Stage transition (filed → pleadings → arguments → reserved → disposed)
    if (old.stage && m.stage && old.stage !== m.stage) {
      events.push({
        title: `⚖️ Stage changed — ${m.title || m.caseNo}`,
        body:  `${old.stage} → ${m.stage}`,
        tag:   `stage-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
    }

    // 2e. Judge / coram changed (re-allocation, new bench)
    if (old.judge && m.judge && old.judge !== m.judge) {
      events.push({
        title: `👨‍⚖️ Judge changed — ${m.title || m.caseNo}`,
        body:  `${old.judge} → ${m.judge}`,
        tag:   `judge-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
    }

    // 2f. Status string changed (e.g. "PENDING" → "DISPOSED OF")
    if (old.status && m.status && old.status !== m.status) {
      events.push({
        title: `🔄 Status — ${m.title || m.caseNo}`,
        body:  `${old.status} → ${m.status}`,
        tag:   `status-${m.caseNo}`,
        url:   './#/matter/' + encodeURIComponent(m.caseNo),
      });
    }
  }

  if (events.length === 0) { console.log('No new events — nothing to push.'); return; }
  console.log(`Sending ${events.length} push event(s) to ${subs.length} subscriber(s)…`);
  for (const ev of events) await sendToAll(ev);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIGEST MODE — one summary push per day, only if non-empty
// ─────────────────────────────────────────────────────────────────────────────
async function runDigestMode() {
  const today    = new Date(); today.setHours(0,0,0,0);
  const dayAfter = new Date(today.getTime() + 48 * 60 * 60 * 1000);

  // Hearings in the next 48h (cause list)
  const upcoming = (causeNow.entries || []).filter(e => {
    if (!e.date) return false;
    const d = new Date(e.date);
    if (isNaN(d)) return false;
    return d >= today && d <= dayAfter;
  });

  // Orders uploaded since 24h ago (case status)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let recentOrderCount = 0;
  for (const m of scrapedNow) {
    for (const o of (m.orders || [])) {
      const d = new Date(o.date);
      if (!isNaN(d) && d >= cutoff) recentOrderCount++;
    }
  }

  if (upcoming.length === 0 && recentOrderCount === 0) {
    console.log('Digest: nothing to report — staying silent.');
    return;
  }

  const lines = [];
  if (upcoming.length) {
    lines.push(`${upcoming.length} hearing${upcoming.length > 1 ? 's' : ''} in next 48h`);
    upcoming.slice(0, 3).forEach(e => lines.push(`• ${findCaseTitle(e.caseNo)} — ${e.date}${e.court ? ` (Court ${e.court})` : ''}`));
    if (upcoming.length > 3) lines.push(`• …and ${upcoming.length - 3} more`);
  }
  if (recentOrderCount) lines.push(`${recentOrderCount} new order${recentOrderCount > 1 ? 's' : ''} in last 24h`);

  await sendToAll({
    title: '☀️ LexTrack — your morning brief',
    body:  lines.join('\n'),
    tag:   'morning-digest',
    url:   './',
    requireInteraction: false,
  });
}

(async () => {
  try {
    if (MODE === 'digest') await runDigestMode();
    else                   await runDiffMode();
  } catch (e) {
    console.error('send-push.js error:', e);
    process.exit(0); // never fail the workflow
  }
})();
