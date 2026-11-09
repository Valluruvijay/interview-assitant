const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const testFilePath = path.join(__dirname, 'test-proctor-shield.html');

const server = http.createServer((req, res) => {
  if (fs.existsSync(testFilePath)) {
    const html = fs.readFileSync(testFilePath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('test-proctor-shield.html not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🛡️ Proctor Test Server running at: http://localhost:${PORT}`);
  console.log(`Tampermonkey automatically runs on this HTTP URL in Chrome!`);
  console.log(`Press Ctrl+C to stop.`);
  console.log(`========================================================\n`);
});
