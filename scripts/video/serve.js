/**
 * 录屏用本地静态服务：带 .html 回退（对齐 Cloudflare Pages 的整洁 URL 行为）。
 * 用法：node scripts/video/serve.js   → http://127.0.0.1:8899/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', '..', 'dist');
const PORT = 8899;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    const candidates = [urlPath];
    if (!path.extname(urlPath)) candidates.push(urlPath + '.html'); // /topics/x → /topics/x.html

    for (const c of candidates) {
      const file = path.join(DIST, c);
      if (!file.startsWith(DIST)) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  })
  .listen(PORT, '127.0.0.1', () => console.log('dist served at http://127.0.0.1:' + PORT));
