const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filename) {
  ensureDir(DATA_DIR);
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return []; }
}

function writeJSON(filename, data) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 Not Found</h1>');
  }
}

// ====== API Routes ======
async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // GET /api/analytics
  if (url.pathname === '/api/analytics' && method === 'GET') {
    return sendJSON(res, readJSON('analytics.json'));
  }
  // POST /api/analytics
  if (url.pathname === '/api/analytics' && method === 'POST') {
    const body = await parseBody(req);
    const { date, followers, likes, comments, shares, views } = body;
    const data = readJSON('analytics.json');
    const idx = data.findIndex(d => d.date === date);
    const entry = { date, followers: +followers, likes: +likes, comments: +comments, shares: +shares, views: +views };
    if (idx >= 0) data[idx] = entry; else data.push(entry);
    data.sort((a, b) => a.date.localeCompare(b.date));
    writeJSON('analytics.json', data);
    return sendJSON(res, { success: true, data });
  }
  // DELETE /api/analytics/:date
  if (method === 'DELETE' && url.pathname.startsWith('/api/analytics/')) {
    const date = decodeURIComponent(url.pathname.split('/api/analytics/')[1]);
    const data = readJSON('analytics.json').filter(d => d.date !== date);
    writeJSON('analytics.json', data);
    return sendJSON(res, { success: true });
  }

  // GET /api/inspirations
  if (url.pathname === '/api/inspirations' && method === 'GET') {
    return sendJSON(res, readJSON('inspirations.json'));
  }
  // POST /api/inspirations
  if (url.pathname === '/api/inspirations' && method === 'POST') {
    const body = await parseBody(req);
    const data = readJSON('inspirations.json');
    const entry = { id: Date.now(), ...body, time: new Date().toLocaleString('zh-CN') };
    data.unshift(entry);
    writeJSON('inspirations.json', data);
    return sendJSON(res, { success: true, entry });
  }
  // DELETE /api/inspirations/:id
  if (method === 'DELETE' && url.pathname.startsWith('/api/inspirations/')) {
    const id = +url.pathname.split('/api/inspirations/')[1];
    const data = readJSON('inspirations.json').filter(d => d.id !== id);
    writeJSON('inspirations.json', data);
    return sendJSON(res, { success: true });
  }

  // GET /api/account-snapshot
  if (url.pathname === '/api/account-snapshot' && method === 'GET') {
    const fp = path.join(__dirname, 'analytics', 'data.json');
    if (fs.existsSync(fp)) return sendJSON(res, JSON.parse(fs.readFileSync(fp, 'utf-8')));
    return sendJSON(res, null);
  }
  // POST /api/account-snapshot
  if (url.pathname === '/api/account-snapshot' && method === 'POST') {
    const body = await parseBody(req);
    const fp = path.join(__dirname, 'analytics', 'data.json');
    fs.writeFileSync(fp, JSON.stringify(body, null, 2), 'utf-8');
    return sendJSON(res, { success: true });
  }

  // GET /api/knowledge/weekly
  if (url.pathname === '/api/knowledge/weekly' && method === 'GET') {
    const kbDir = path.join(__dirname, 'knowledge-base', 'weekly');
    if (!fs.existsSync(kbDir)) return sendJSON(res, []);
    const weeks = fs.readdirSync(kbDir)
      .filter(d => fs.statSync(path.join(kbDir, d)).isDirectory())
      .sort().reverse();
    const result = weeks.map(w => {
      const df = path.join(kbDir, w, 'data.json');
      if (fs.existsSync(df)) {
        const d = JSON.parse(fs.readFileSync(df, 'utf-8'));
        return { week: w, ...d };
      }
      return { week: w, topics: [] };
    });
    return sendJSON(res, result);
  }

  sendJSON(res, { error: 'Not found' }, 404);
}

// ====== Server ======
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    return handleAPI(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  🌐 移民行业工作台已启动`);
  console.log(`  📍 http://localhost:${PORT}`);
  console.log(`  📁 数据存储: ${DATA_DIR}\n`);
});