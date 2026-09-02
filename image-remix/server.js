/**
 * 图片仿照服务
 * 启动方式：node server.js
 * 端口：3457
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3457;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const REQUEST_FILE = path.join(__dirname, 'request.json');
const RESULT_FILE = path.join(__dirname, 'result.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveRequest(data) {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(data, null, 2));
}

function getRequest() {
  try { return JSON.parse(fs.readFileSync(REQUEST_FILE, 'utf-8')); } catch { return null; }
}

function saveResult(data) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(data, null, 2));
}

function getResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8')); } catch { return null; }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
  }

  // Upload image
  if (url.pathname === '/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const { imageData, prompt } = body;

        if (!imageData) throw new Error('请上传图片');

        // Save image
        const ext = imageData.startsWith('data:image/png') ? 'png' :
                   imageData.startsWith('data:image/jpeg') ? 'jpg' :
                   imageData.startsWith('data:image/webp') ? 'webp' : 'png';
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

        // Save request
        saveRequest({
          imagePath: filepath,
          imageName: filename,
          prompt: prompt || '仿照这张图片的风格，生成一张类似的图片',
          time: new Date().toISOString(),
          status: 'pending'
        });

        console.log(`[Upload] ${filename} (${(Buffer.byteLength(base64) / 1024).toFixed(1)}KB)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: '图片已上传，请在聊天中告诉AI助手"仿照图片"',
          filename
        }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Get request
  if (url.pathname === '/request' && req.method === 'GET') {
    const reqData = getRequest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reqData || { status: 'empty' }));
    return;
  }

  // Save result
  if (url.pathname === '/result' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        saveResult(data);
        saveRequest({ status: 'completed' });
        console.log(`[Result] ${data.outputPath || 'generated'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Poll result
  if (url.pathname === '/poll' && req.method === 'GET') {
    const result = getResult();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result || { status: 'waiting' }));
    return;
  }

  // Serve generated image
  if (url.pathname.startsWith('/output/') && req.method === 'GET') {
    const filename = path.basename(url.pathname);
    const filepath = path.join(UPLOADS_DIR, filename);
    try {
      const data = fs.readFileSync(filepath);
      const ext = path.extname(filename).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'image/png';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  // Clear
  if (url.pathname === '/clear' && req.method === 'POST') {
    try { fs.unlinkSync(RESULT_FILE); } catch {}
    try { fs.writeFileSync(REQUEST_FILE, JSON.stringify({ status: 'empty' })); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🎨  图片仿照服务已启动');
  console.log('  ────────────────────────');
  console.log(`  地址：http://localhost:${PORT}`);
  console.log('  功能：上传图片 → AI 仿照生成');
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});