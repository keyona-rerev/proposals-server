const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files from /proposals folder
app.use('/proposals', express.static(path.join(__dirname, 'proposals')));

// Index route — lists available proposals (helpful for debugging)
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem; background: #F0F7F7;">
        <h2 style="color: #0D1F2D;">Proposals Server</h2>
        <p style="color: #555;">Running. Proposals are served at <code>/proposals/[slug].html</code></p>
      </body>
    </html>
  `);
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
