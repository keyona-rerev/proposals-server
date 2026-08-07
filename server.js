const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Optional per-document gating
//
// protected.json declares WHICH slugs are gated. Credentials never live in the
// repo — each gated document reads one Railway environment variable:
//
//   GATE_<SLUG_UPPERCASED_UNDERSCORED>  =  "username:password"
//
// e.g. slug "acme-partnership-0726" -> GATE_ACME_PARTNERSHIP_0726
//
// Fails CLOSED in every direction:
//   - slug listed but env var missing/malformed -> 403, never served open
//   - protected.json present but unparseable    -> 503 across /proposals
//   - protected.json absent                     -> everything open (default)
// ---------------------------------------------------------------------------

const MANIFEST_PATH = path.join(__dirname, 'protected.json');

let gatedSlugs = new Set();
let manifestBroken = false;

try {
  if (fs.existsSync(MANIFEST_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    gatedSlugs = new Set(Array.isArray(parsed.gated) ? parsed.gated : []);
    console.log(`Gating active for ${gatedSlugs.size} document(s).`);
  } else {
    console.log('No protected.json found — all proposals open.');
  }
} catch (err) {
  manifestBroken = true;
  console.error('protected.json unreadable — sealing /proposals as a precaution:', err.message);
}

function envVarNameFor(slug) {
  return 'GATE_' + slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

// First path segment identifies the document, so directory-style proposals
// (e.g. /proposals/deck-0726/slides/01/slide.html) are gated as a whole.
function slugFromPath(reqPath) {
  const first = reqPath.split('/').filter(Boolean)[0] || '';
  let decoded = first;
  try { decoded = decodeURIComponent(first); } catch (e) { /* malformed escape */ }
  return decoded.replace(/\.html$/i, '');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function noticePage(heading, message) {
  return `<html>
      <body style="font-family: sans-serif; padding: 2rem; background: #F0F7F7;">
        <h2 style="color: #0D1F2D;">${heading}</h2>
        <p style="color: #555;">${message}</p>
      </body>
    </html>`;
}

app.use('/proposals', (req, res, next) => {
  if (manifestBroken) {
    return res.status(503).send(noticePage('Temporarily unavailable', 'Please try again shortly.'));
  }

  const slug = slugFromPath(req.path);
  if (!gatedSlugs.has(slug)) return next(); // open by default

  const raw = process.env[envVarNameFor(slug)];
  if (!raw || !raw.includes(':')) {
    console.warn(`Gated slug "${slug}" has no valid ${envVarNameFor(slug)} — denying access.`);
    return res.status(403).send(noticePage('Protected document', 'This document is protected and is not currently available.'));
  }

  const sep = raw.indexOf(':');
  const wantUser = raw.slice(0, sep);
  const wantPass = raw.slice(sep + 1);

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString(); } catch (e) { decoded = ''; }
    const i = decoded.indexOf(':');
    if (i > -1) {
      const gotUser = decoded.slice(0, i);
      const gotPass = decoded.slice(i + 1);
      if (safeEqual(gotUser, wantUser) && safeEqual(gotPass, wantPass)) return next();
    }
  }

  // Realm scoped per document so browsers don't reuse one doc's credentials on another.
  res.set('WWW-Authenticate', `Basic realm="${slug.replace(/"/g, '')}"`);
  return res.status(401).send(noticePage('Protected document', 'Enter the username and password provided with this link.'));
});

// ---------------------------------------------------------------------------
// Capacity Cart intake — workshop cart submissions
//
// POST /api/capacity-cart
// Emails the participant their plan and copies Keyona. Requires RESEND_API_KEY.
// Fails soft: a bad send never blocks the participant's confirmation screen.
// ---------------------------------------------------------------------------

const CART_FROM = process.env.CART_FROM || 'ReRev Labs <hello@rerev.io>';
const CART_BCC = process.env.CART_BCC || 'keyona@rerev.io';

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function cartEmailHtml(b) {
  const items = Array.isArray(b.cart_items) ? b.cart_items : [];
  const diy = items.filter(i => i.type === 'diy');
  const build = items.filter(i => i.type !== 'diy');
  const list = (rows, color) => rows.length
    ? `<ul style="margin:0 0 22px;padding-left:18px;color:#3D5166;font-size:15px;line-height:1.7">${rows.map(r => `<li><strong style="color:#0D1F2D">${esc(r.title)}</strong> <span style="color:#8b9bab;font-size:13px">— ${esc(r.aisle)}</span></li>`).join('')}</ul>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
    <p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#1A9E9E;margin:0 0 10px">ReRev Labs</p>
    <h1 style="font-size:26px;color:#0D1F2D;margin:0 0 6px">${esc(b.name)}'s capacity plan</h1>
    <p style="color:#3D5166;font-size:15px;line-height:1.6;margin:0 0 28px">${esc(b.organization)}</p>
    ${diy.length ? `<h2 style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#0D7E7E;margin:0 0 10px">Doing myself</h2>${list(diy)}` : ''}
    ${build.length ? `<h2 style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5B21B6;margin:0 0 10px">Want built</h2>${list(build)}` : ''}
    <p style="color:#3D5166;font-size:14px;line-height:1.7;border-top:1px solid #e6eef0;padding-top:20px;margin:0">
      Start with one. The smallest item on this list that you'd notice being gone.<br><br>
      Reply to this email if you want help with anything under <em>Want built</em>.<br><br>
      — Keyona
    </p>
  </div>`;
}

app.post('/api/capacity-cart', async (req, res) => {
  const b = req.body || {};
  console.log('[capacity-cart]', JSON.stringify({ ...b, stage: b.stage }));

  // Confirm immediately. The room never waits on an email provider.
  res.json({ ok: true });

  if (b.stage !== 'checkout') return;
  if (!process.env.RESEND_API_KEY) {
    return console.warn('[capacity-cart] RESEND_API_KEY not set — logged only, no email sent.');
  }

  const to = [];
  if (b.email && /.+@.+\..+/.test(b.email)) to.push(b.email);
  if (!to.length) to.push(CART_BCC);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: CART_FROM,
        to,
        bcc: [CART_BCC],
        reply_to: CART_BCC,
        subject: `${b.name || 'Your'} capacity plan — ${(Array.isArray(b.cart_items) ? b.cart_items.length : 0)} items`,
        html: cartEmailHtml(b)
      })
    });
    if (!r.ok) console.error('[capacity-cart] resend failed', r.status, await r.text());
    else console.log('[capacity-cart] emailed', to.join(', '));
  } catch (err) {
    console.error('[capacity-cart] resend threw', err.message);
  }
});

// Serve assets (images, etc.) from /assets folder
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve static files from /proposals folder — extensions: ['html'] allows extensionless URLs
app.use('/proposals', express.static(path.join(__dirname, 'proposals'), { extensions: ['html'] }));

// Index route — serves the master index.html listing every live proposal link
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).send(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem; background: #F0F7F7;">
        <h2 style="color: #0D1F2D;">Proposal not found</h2>
        <p style="color: #555;">This proposal link may be invalid or expired.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Proposals server running on port ${PORT}`);
});
