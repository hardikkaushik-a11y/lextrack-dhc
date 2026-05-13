#!/usr/bin/env node
/**
 * LexTrack — Order Intelligence Merger (Tier C / Writer)
 *
 * Three-tier split for AI-on-untrusted-input (May plan, Item 3):
 *   Tier A  src/scraper.js
 *   Tier B  scripts/extract-order-intelligence.js
 *   Tier C  THIS SCRIPT  — reads scraped.json + order-intel.json, validates
 *                          every intel object against the schema, and
 *                          attaches valid ones to matching timeline
 *                          entries. NO API key. NO PDF parsing. Anything
 *                          that doesn't validate is dropped + logged.
 *
 * Validation is paranoid by design — the mapper sees adversarial PDF text
 * and could in theory be coaxed into emitting malformed output. The writer
 * is the schema enforcement point.
 */

const fs = require('fs');
const SCRAPED_PATH = 'data/scraped.json';
const INTEL_PATH   = 'data/order-intel.json';

function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

// ── Schema validation ─────────────────────────────────────────────────────
// Returns { valid: true } or { valid: false, reason: '...' }. Lax on
// nullable fields, strict on enums + types. Caps array lengths so a
// hostile mapper can't blow scraped.json size.
const CLASSIFICATION_VALUES = new Set(['interim','final','procedural','directions','ex-parte','dismissal','other']);
const COSTS_TO_VALUES       = new Set(['plaintiff','defendant','neither']);
const CONFIDENCE_VALUES     = new Set(['high','medium','low']);

function isStringOrNull(v)  { return v === null || typeof v === 'string'; }
function isArrayOfStrings(v, max = 10) {
  if (!Array.isArray(v)) return false;
  if (v.length > max) return false;
  return v.every(x => typeof x === 'string' && x.length < 500);
}

function validateIntel(intel, orderLink) {
  if (!intel || typeof intel !== 'object') return { valid: false, reason: 'not an object' };

  if (!CLASSIFICATION_VALUES.has(intel.classification)) {
    return { valid: false, reason: `bad classification: ${intel.classification}` };
  }
  if (!isStringOrNull(intel.reliefGranted)) {
    return { valid: false, reason: 'reliefGranted must be string|null' };
  }
  if (intel.reliefGranted && intel.reliefGranted.length > 1000) {
    return { valid: false, reason: 'reliefGranted > 1000 chars' };
  }
  if (intel.costsAwarded !== null && intel.costsAwarded !== undefined) {
    if (typeof intel.costsAwarded !== 'object')         return { valid: false, reason: 'costsAwarded shape' };
    if (!isStringOrNull(intel.costsAwarded.amount))      return { valid: false, reason: 'costsAwarded.amount' };
    if (intel.costsAwarded.to !== null && intel.costsAwarded.to !== undefined && !COSTS_TO_VALUES.has(intel.costsAwarded.to)) {
      return { valid: false, reason: 'costsAwarded.to enum' };
    }
  }
  if (!isArrayOfStrings(intel.directions, 5)) return { valid: false, reason: 'directions' };
  if (!isArrayOfStrings(intel.citations, 5))  return { valid: false, reason: 'citations' };
  if (!intel.counsel || typeof intel.counsel !== 'object') return { valid: false, reason: 'counsel' };
  if (!isStringOrNull(intel.counsel.plaintiff)) return { valid: false, reason: 'counsel.plaintiff' };
  if (!isStringOrNull(intel.counsel.defendant)) return { valid: false, reason: 'counsel.defendant' };
  if (typeof intel.summary !== 'string' || intel.summary.length > 2000) {
    return { valid: false, reason: 'summary' };
  }
  if (intel.confidence) {
    for (const k of ['reliefGranted','directions','citations']) {
      if (intel.confidence[k] && !CONFIDENCE_VALUES.has(intel.confidence[k])) {
        return { valid: false, reason: `confidence.${k} enum` };
      }
    }
  }
  return { valid: true };
}

// Sanitise an intel object before persisting: only keep schema fields,
// strip anything else. Belt + braces in case validation passes but the
// mapper sneaked extra keys (e.g. `__proto__`, `eval`).
function sanitiseIntel(intel) {
  const out = {
    classification: intel.classification,
    reliefGranted:  intel.reliefGranted ?? null,
    costsAwarded:   intel.costsAwarded ?? null,
    directions:     [...intel.directions],
    citations:      [...intel.citations],
    counsel:        {
      plaintiff: intel.counsel?.plaintiff ?? null,
      defendant: intel.counsel?.defendant ?? null,
    },
    summary:        intel.summary,
  };
  if (intel.confidence) {
    out.confidence = {
      reliefGranted: intel.confidence.reliefGranted || null,
      directions:    intel.confidence.directions    || null,
      citations:     intel.confidence.citations     || null,
    };
  }
  // Carry through provenance stamps from the mapper (not user-controlled).
  for (const k of ['_extractedAt','_model','_schema','_caseNo','_orderDate']) {
    if (typeof intel[k] === 'string' && intel[k].length < 200) out[k] = intel[k];
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────
const scraped = readJSON(SCRAPED_PATH, []);
const intelMap = readJSON(INTEL_PATH, {});
if (!Array.isArray(scraped) || scraped.length === 0) {
  console.log('[merge-intel] scraped.json empty — nothing to merge.');
  process.exit(0);
}
if (!intelMap || Object.keys(intelMap).length === 0) {
  console.log('[merge-intel] order-intel.json empty — nothing to merge.');
  process.exit(0);
}

let attached = 0, rejected = 0, alreadyPresent = 0;
for (const m of scraped) {
  for (const t of (m.timeline || [])) {
    if (!t || !t.orderLink) continue;
    if (t.intelligence) { alreadyPresent++; continue; }
    const raw = intelMap[t.orderLink];
    if (!raw) continue;
    const { valid, reason } = validateIntel(raw, t.orderLink);
    if (!valid) {
      console.warn(`  [merge-intel] REJECT ${t.orderLink}: ${reason}`);
      rejected++;
      continue;
    }
    t.intelligence = sanitiseIntel(raw);
    attached++;
  }
}

fs.writeFileSync(SCRAPED_PATH, JSON.stringify(scraped, null, 2));
console.log(`[merge-intel] attached ${attached} new, ${alreadyPresent} already present, ${rejected} rejected.`);
