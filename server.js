const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

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
