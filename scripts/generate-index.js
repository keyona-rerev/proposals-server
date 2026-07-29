#!/usr/bin/env node
/**
 * generate-index.js
 *
 * Rebuilds the root index.html from whatever's actually in /proposals.
 *
 * Non-destructive by design: it first reads the CURRENT index.html and
 * remembers every card it already knows about (name, slug, date, which
 * venture bucket it lives under). Those are preserved exactly as-is.
 *
 * Only genuinely new files (never seen in index.html before) get their
 * name/date/bucket resolved. For new files the order of precedence is:
 *   1. a <!-- meta: ... --> comment at the top of the HTML file
 *   2. the slug-based guess (legacy behaviour)
 * Files that no longer exist in /proposals are dropped. Hand-edit a
 * name/bucket once and it sticks on every future run, because this script
 * always reads its own prior output as the source of truth for "known" entries.
 *
 * Gated documents (listed in protected.json) render with a "Protected" badge.
 *
 * Run from the repo root: node scripts/generate-index.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROPOSALS_DIR = path.join(ROOT, 'proposals');
const INDEX_PATH = path.join(ROOT, 'index.html');
const MANIFEST_PATH = path.join(ROOT, 'protected.json');

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const VENTURE_ORDER = ['rerev', 'btc', 'prismm', 'infra'];
const VENTURE_TITLES = {
  rerev: 'ReRev Labs',
  btc: 'BlackTech Capital',
  prismm: 'Prismm',
  infra: 'Client Infrastructure Builds',
};

// ---------- 0. Which documents are gated ----------

function loadGatedSlugs() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return new Set(Array.isArray(parsed.gated) ? parsed.gated : []);
  } catch (err) {
    console.warn(`protected.json unreadable (${err.message}) — badges omitted this run.`);
    return new Set();
  }
}

const GATED = loadGatedSlugs();

function isGated(slug) {
  return GATED.has(String(slug).replace(/\/$/, ''));
}

// ---------- 1. Discover what's actually on disk ----------

function discoverProposals() {
  const entries = fs.readdirSync(PROPOSALS_DIR, { withFileTypes: true });
  const found = []; // { href, slug, file }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // .gitkeep-noop, dotfiles

    if (entry.isDirectory()) {
      const indexFile = path.join(PROPOSALS_DIR, entry.name, 'index.html');
      if (fs.existsSync(indexFile)) {
        found.push({ href: `/proposals/${entry.name}/`, slug: `${entry.name}/`, file: indexFile });
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      const slug = entry.name.replace(/\.html$/i, '');
      found.push({ href: `/proposals/${entry.name}`, slug, file: path.join(PROPOSALS_DIR, entry.name) });
    }
  }

  return found;
}

// ---------- 2. Read what index.html already knows ----------

function parseExistingIndex() {
  const known = new Map(); // href -> { name, slug, date, ventureKey, ventureTitle }

  if (!fs.existsSync(INDEX_PATH)) return known;

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const ventureBlockRe = /<div class="venture" data-venture="([^"]+)">\s*<div class="venture-title">([^<]*)<\/div>\s*<div class="grid">([\s\S]*?)<\/div>\s*<\/div>/g;
  // The trailing card-lock span is optional so cards written before gating
  // existed still parse, and gated cards round-trip without being seen as new.
  const cardRe = /<a class="card" href="([^"]+)"[^>]*>\s*<span class="card-name">([^<]*)<\/span>\s*<span class="card-slug">([^<]*)<\/span>\s*<span class="card-date">([^<]*)<\/span>\s*(?:<span class="card-lock">[^<]*<\/span>\s*)?<\/a>/g;

  let ventureMatch;
  while ((ventureMatch = ventureBlockRe.exec(html)) !== null) {
    const [, ventureKey, ventureTitleRaw, gridHtml] = ventureMatch;
    const ventureTitle = unescapeHtml(ventureTitleRaw.trim());
    let cardMatch;
    cardRe.lastIndex = 0;
    while ((cardMatch = cardRe.exec(gridHtml)) !== null) {
      const [, href, name, slug, date] = cardMatch;
      known.set(href, {
        name: unescapeHtml(name.trim()),
        slug: unescapeHtml(slug.trim()),
        date: unescapeHtml(date.trim()),
        ventureKey,
        ventureTitle,
      });
    }
  }

  return known;
}

// ---------- 3. Resolve metadata for genuinely new entries ----------

// Reads a <!-- meta: client=Acme; venture=rerev; title=Partnership Overview; date=2026-07 -->
// comment from the head of the file. Any subset of keys is fine.
function readMeta(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const bytes = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8');

    const m = head.match(/<!--\s*meta:\s*([^>]*?)\s*-->/i);
    if (!m) return null;

    const meta = {};
    for (const pair of m[1].split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      const val = pair.slice(eq + 1).trim();
      if (key && val) meta[key] = val;
    }
    return Object.keys(meta).length ? meta : null;
  } catch (err) {
    return null;
  }
}

function ventureFromMeta(meta) {
  if (!meta || !meta.venture) return null;
  const key = meta.venture.trim().toLowerCase();
  return { key, title: VENTURE_TITLES[key] || meta.venture.trim() };
}

// Accepts "2026-07" or "2026-7"
function dateFromMeta(meta) {
  if (!meta || !meta.date) return null;
  const m = meta.date.trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const mm = parseInt(m[2], 10);
  if (mm < 1 || mm > 12) return null;
  return { label: `${MONTHS[mm]} ${m[1]}` };
}

function guessVenture(slug) {
  const clean = slug.replace(/\/$/, '');
  if (clean.startsWith('rerev-')) return { key: 'rerev', title: VENTURE_TITLES.rerev };
  if (clean.startsWith('btc-')) return { key: 'btc', title: VENTURE_TITLES.btc };
  if (clean.startsWith('prismm-')) return { key: 'prismm', title: VENTURE_TITLES.prismm };
  return { key: 'infra', title: VENTURE_TITLES.infra };
}

function guessDate(slug) {
  const clean = slug.replace(/\/$/, '');

  // Trailing -MMYY, e.g. rerev-offerings-grid-0626
  let m = clean.match(/-(\d{2})(\d{2})$/);
  if (m) {
    const mm = parseInt(m[1], 10);
    if (mm >= 1 && mm <= 12) return { label: `${MONTHS[mm]} 20${m[2]}`, sortKey: parseInt(`20${m[2]}${String(mm).padStart(2, '0')}`, 10) };
  }

  // Trailing -monYYYY, e.g. btc-ic-package-jun2026
  m = clean.match(/-([a-z]{3})(\d{4})$/i);
  if (m && MONTH_ABBR[m[1].toLowerCase()]) {
    const mm = MONTH_ABBR[m[1].toLowerCase()];
    return { label: `${MONTHS[mm]} ${m[2]}`, sortKey: parseInt(`${m[2]}${String(mm).padStart(2, '0')}`, 10) };
  }

  return { label: '—', sortKey: -1 };
}

function guessName(slug) {
  let s = slug.replace(/\/$/, '');
  s = s.replace(/^(rerev|btc|prismm)-/, '');
  s = s.replace(/-\d{4}$/, '');
  s = s.replace(/-[a-z]{3}\d{4}$/i, '');
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function dateSortKey(dateLabel) {
  if (!dateLabel || dateLabel === '—') return -1;
  const m = dateLabel.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return -1;
  const mm = MONTHS.indexOf(m[1]);
  if (mm < 1) return -1;
  return parseInt(`${m[2]}${String(mm).padStart(2, '0')}`, 10);
}

// ---------- 4. Build the merged, current entry list ----------

function buildEntries() {
  const onDisk = discoverProposals();
  const known = parseExistingIndex();

  const buckets = new Map(); // ventureKey -> { title, entries: [] }
  const newlyAdded = [];

  for (const { href, slug, file } of onDisk) {
    let record = known.get(href);

    if (!record) {
      const meta = readMeta(file);
      const venture = ventureFromMeta(meta) || guessVenture(slug);
      const dateResolved = dateFromMeta(meta) || guessDate(slug);
      const name = (meta && meta.title) ? meta.title : guessName(slug);

      record = {
        name,
        slug,
        date: dateResolved.label,
        ventureKey: venture.key,
        ventureTitle: venture.title,
      };
      newlyAdded.push({ href, name: record.name, venture: venture.title, viaMeta: !!meta });
    }

    if (!buckets.has(record.ventureKey)) {
      buckets.set(record.ventureKey, { title: record.ventureTitle, entries: [] });
    }
    buckets.get(record.ventureKey).entries.push({ href, ...record });
  }

  // Sort within each bucket: newest first, undated items sink to the bottom,
  // ties broken alphabetically by name for stability.
  for (const bucket of buckets.values()) {
    bucket.entries.sort((a, b) => {
      const diff = dateSortKey(b.date) - dateSortKey(a.date);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
  }

  // Order the venture sections consistently.
  const orderedKeys = [
    ...VENTURE_ORDER.filter((k) => buckets.has(k)),
    ...[...buckets.keys()].filter((k) => !VENTURE_ORDER.includes(k)),
  ];

  return { buckets, orderedKeys, newlyAdded };
}

// ---------- 5. Render HTML ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Reverses escapeHtml. Needed because parseExistingIndex() reads back text
// that was already escaped on a prior run — if it's stored as-is and then
// escaped again on the next render, every regeneration adds one more layer
// of "&amp;" (e.g. "Tiers & Journeys" -> "&amp;" -> "&amp;amp;" -> ...).
// Decoding one entity per pass (up to the first ';') and looping until
// stable exactly undoes however many layers have accumulated.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  times: '\u00D7',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  nbsp: '\u00A0',
};

function unescapeHtml(str) {
  let prev = String(str);
  for (let i = 0; i < 1000; i++) {
    const next = prev.replace(/&([a-zA-Z0-9#]+?);/g, (full, ent) => {
      const key = ent.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : full;
    });
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function renderCard(entry) {
  const lock = isGated(entry.slug)
    ? `\n          <span class="card-lock">Protected</span>`
    : '';
  return `        <a class="card" href="${escapeHtml(entry.href)}" target="_blank">
          <span class="card-name">${escapeHtml(entry.name)}</span>
          <span class="card-slug">${escapeHtml(entry.slug)}</span>
          <span class="card-date">${escapeHtml(entry.date)}</span>${lock}
        </a>`;
}

function renderVentureBlock(key, bucket) {
  const cards = bucket.entries.map(renderCard).join('\n');
  return `    <div class="venture" data-venture="${escapeHtml(key)}">
      <div class="venture-title">${escapeHtml(bucket.title)}</div>
      <div class="grid">
${cards}
      </div>
    </div>`;
}

function todayLabel() {
  const d = new Date();
  return `${MONTHS[d.getMonth() + 1]} ${d.getDate()}, ${d.getFullYear()}`;
}

function render(buckets, orderedKeys) {
  const ventureBlocks = orderedKeys.map((key) => renderVentureBlock(key, buckets.get(key))).join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proposals Index — ReRev Labs</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F0F7F7;
    --primary: #0D1F2D;
    --body-text: #3D5166;
    --cyan: #1A9E9E;
    --purple: #7C3AED;
    --gradient: linear-gradient(90deg, #1A9E9E, #7C3AED);
    --font-heading: 'Outfit', sans-serif;
    --font-body: 'Inter', sans-serif;
    --card-border: rgba(13,31,45,0.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--primary);
    font-family: var(--font-body);
    line-height: 1.6;
    padding: 48px 24px 80px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  .wordmark { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 32px; }
  .wordmark-bar { width: 26px; height: 3px; background: var(--gradient); border-radius: 2px; }
  .wordmark-text { font-family: var(--font-heading); font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); }
  h1 { font-family: var(--font-heading); font-size: clamp(28px, 4vw, 40px); font-weight: 700; margin-bottom: 8px; letter-spacing: -0.02em; }
  .sub { color: var(--body-text); font-size: 15px; margin-bottom: 8px; }
  .updated { color: var(--body-text); font-size: 12px; opacity: 0.7; margin-bottom: 40px; }
  .search {
    width: 100%; padding: 12px 16px; margin-bottom: 36px;
    border: 1px solid var(--card-border); border-radius: 10px;
    font-family: var(--font-body); font-size: 14px; background: white; color: var(--primary);
  }
  .search:focus { outline: none; border-color: var(--cyan); }
  .venture { margin-bottom: 40px; }
  .venture-title {
    font-family: var(--font-heading); font-size: 13px; font-weight: 600;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--purple);
    margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--card-border);
  }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .card {
    display: flex; flex-direction: column; gap: 4px;
    background: white; border: 1px solid var(--card-border); border-radius: 10px;
    padding: 14px 16px; text-decoration: none; color: var(--primary);
    transition: box-shadow 0.15s ease, transform 0.15s ease;
  }
  .card:hover { box-shadow: 0 2px 12px rgba(13,31,45,0.08); transform: translateY(-1px); }
  .card-name { font-family: var(--font-heading); font-size: 14px; font-weight: 600; }
  .card-slug { font-size: 11.5px; color: var(--body-text); opacity: 0.75; font-family: monospace; }
  .card-date { font-size: 11px; color: var(--cyan); font-weight: 500; }
  .card-lock {
    align-self: flex-start; margin-top: 2px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--purple); background: rgba(124,58,237,0.08);
    border: 1px solid rgba(124,58,237,0.18); border-radius: 20px; padding: 2px 8px;
  }
  .no-results { color: var(--body-text); font-size: 14px; display: none; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--card-border); font-size: 12px; color: var(--body-text); opacity: 0.7; }
</style>
</head>
<body>
<div class="wrap">

  <div class="wordmark">
    <div class="wordmark-bar"></div>
    <span class="wordmark-text">ReRev Labs</span>
  </div>

  <h1>Proposals Index</h1>
  <p class="sub">Every live link in one place. Click a card to open it.</p>
  <p class="updated">Last updated: ${todayLabel()} · auto-generated on every push</p>

  <input type="text" class="search" id="searchBox" placeholder="Search by name, slug, or keyword..." onkeyup="filterCards()">
  <p class="no-results" id="noResults">No matches. Check the spelling or browse below.</p>

  <div id="ventureContainer">

${ventureBlocks}

  </div>

  <p class="no-results" id="bottomNote" style="opacity:0.6; font-size:12px; margin-top:24px;">
    This page is regenerated automatically every time a proposal is pushed to main. If something looks off, check scripts/generate-index.js.
  </p>

  <footer>
    keyona-rerev/proposals-server &middot; auto-deployed via Railway
  </footer>

</div>

<script>
  function filterCards() {
    const q = document.getElementById('searchBox').value.toLowerCase().trim();
    const cards = document.querySelectorAll('.card');
    const ventures = document.querySelectorAll('.venture');
    let anyVisible = false;

    cards.forEach(card => {
      const text = card.textContent.toLowerCase();
      const match = text.includes(q);
      card.style.display = match ? 'flex' : 'none';
      if (match) anyVisible = true;
    });

    ventures.forEach(v => {
      const hasVisible = Array.from(v.querySelectorAll('.card')).some(c => c.style.display !== 'none');
      v.style.display = hasVisible ? 'block' : 'none';
    });

    document.getElementById('noResults').style.display = anyVisible ? 'none' : 'block';
  }
</script>

</body>
</html>
`;
}

// ---------- 6. Main ----------

function main() {
  const { buckets, orderedKeys, newlyAdded } = buildEntries();
  const html = render(buckets, orderedKeys);
  fs.writeFileSync(INDEX_PATH, html, 'utf8');

  const totalCards = [...buckets.values()].reduce((n, b) => n + b.entries.length, 0);
  console.log(`index.html regenerated: ${totalCards} proposal(s) across ${buckets.size} venture bucket(s). ${GATED.size} gated.`);
  if (newlyAdded.length) {
    console.log(`Newly added (safe to hand-edit, will persist):`);
    for (const item of newlyAdded) {
      console.log(`  + ${item.href}  →  "${item.name}" (${item.venture})${item.viaMeta ? ' [from meta comment]' : ' [guessed from slug]'}`);
    }
  } else {
    console.log('No new proposals detected.');
  }
}

main();
