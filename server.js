const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 8080;

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
