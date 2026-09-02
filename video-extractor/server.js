/**
 * 视频提取本地服务 v3
 * 启动方式：node server.js
 * 端口：3456
 *
 * 双模式：
 * 1. 直接提取：抖音、快手等平台直接抓取
 * 2. 浏览器提取：小红书等需要登录的平台，通过浏览器插件提取
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3456;
const REQUEST_FILE = path.join(__dirname, 'request.json');
const RESULT_FILE = path.join(__dirname, 'result.json');

// ====== HTTP 请求 ======
function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': `${parsed.protocol}//${parsed.hostname}/`,
        ...extraHeaders
      },
      timeout: 15000,
      rejectUnauthorized: false
    };

    const req = mod.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchPage(loc, extraHeaders).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip' || encoding === 'deflate') {
          const zlib = require('zlib');
          zlib[encoding === 'gzip' ? 'gunzip' : 'inflate'](raw, (err, d) => {
            if (err) return reject(err);
            resolve(d.toString());
          });
        } else {
          resolve(raw.toString());
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ====== 平台检测 ======
function detectPlatform(url) {
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return 'xiaohongshu';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'douyin';
  if (url.includes('kuaishou.com')) return 'kuaishou';
  return 'unknown';
}

// ====== 直接提取：小红书 ======
function extractXHS(html) {
  // 找 masterUrl
  const muMatch = html.match(/masterUrl["']?\s*:\s*["'](https?:\/\/[^"']+)["']/);
  if (!muMatch) return null;

  const videoUrl = muMatch[1].replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\u003D/g, '=');

  // 提取元数据
  const titleMatch = html.match(/"displayTitle"\s*:\s*"([^"]+)"/) || html.match(/"title"\s*:\s*"([^"\u4e00-\u9fff]*[\u4e00-\u9fff][^"]*)"/);
  const authorMatch = html.match(/"nickname"\s*:\s*"([^"]+)"/);
  const wMatch = html.match(/"width"\s*:\s*(\d+)/);
  const hMatch = html.match(/"height"\s*:\s*(\d+)/);
  const durMatch = html.match(/"duration"\s*:\s*(\d+)/);
  const fpsMatch = html.match(/"fps"\s*:\s*(\d+)/);
  const qualMatch = html.match(/"qualityType"\s*:\s*"([^"]+)"/);
  const brMatch = html.match(/"avgBitrate"\s*:\s*(\d+)/);

  let title = titleMatch ? titleMatch[1] : '';
  const skipWords = ['想了解些什么？', '搜索小红书', '做旅行攻略', '答疑解惑'];
  if (skipWords.includes(title)) title = '';

  const w = wMatch ? parseInt(wMatch[1]) : 0;
  const h = hMatch ? parseInt(hMatch[1]) : 0;
  const res = w && h ? `${w}x${h}` : (qualMatch ? qualMatch[1] : '');
  const dur = durMatch ? Math.floor(parseInt(durMatch[1]) / 1000) + 's' : '';
  const fps = fpsMatch ? fpsMatch[1] + 'fps' : '';
  const br = brMatch ? Math.round(parseInt(brMatch[1]) / 1000) + 'kbps' : '';

  return {
    platform: '小红书',
    videoUrl,
    title,
    author: authorMatch ? authorMatch[1] : '',
    duration: dur,
    resolution: [res, fps, br].filter(Boolean).join(' · ') || res
  };
}

// ====== 直接提取：抖音 ======
function extractDouyin(html) {
  const renderMatch = html.match(/<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/);
  if (renderMatch) {
    try {
      const data = JSON.parse(decodeURIComponent(renderMatch[1]));
      let videoData = null;
      const find = (obj) => {
        if (!obj || typeof obj !== 'object' || videoData) return;
        if (obj.video && (obj.video.playAddr || obj.video.playApi)) { videoData = obj; return; }
        if (obj.playAddr && obj.video_id) { videoData = { video: obj }; return; }
        Object.values(obj).forEach(v => { if (typeof v === 'object') find(v); });
      };
      find(data);

      if (videoData?.video) {
        const v = videoData.video;
        let videoUrl = v.playApi || v.playAddr || '';
        videoUrl = videoUrl.replace('/playwm/', '/play/').replace('watermark=1', 'watermark=0').replace(/\\u002F/g, '/');
        if (videoUrl) {
          return {
            platform: '抖音',
            videoUrl,
            title: v.desc || videoData.desc || '',
            duration: v.duration ? Math.floor(v.duration / 1000) + 's' : '',
            author: videoData.author?.nickname || ''
          };
        }
      }
    } catch {}
  }

  const addrMatch = html.match(/playAddr["']:\s*["']([^"']+)["']/);
  if (addrMatch) {
    return {
      platform: '抖音',
      videoUrl: addrMatch[1].replace(/\\u002F/g, '/').replace('/playwm/', '/play/'),
      title: '', duration: ''
    };
  }
  return null;
}

// ====== 直接提取：快手 ======
function extractKuaishou(html) {
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const photo = state?.photo || state?.video || state?.detail;
      if (photo) {
        let videoUrl = photo.photoUrl || photo.videoUrl || '';
        if (!videoUrl && photo.mainMvUrls) videoUrl = photo.mainMvUrls[0]?.url || photo.mainMvUrls[0] || '';
        if (videoUrl) {
          return {
            platform: '快手',
            videoUrl,
            title: photo.caption || photo.text || '',
            duration: photo.duration ? Math.floor(photo.duration / 1000) + 's' : '',
            author: photo.userName || photo.authorName || ''
          };
        }
      }
    } catch {}
  }
  return null;
}

// ====== 直接提取入口 ======
async function directExtract(url) {
  const platform = detectPlatform(url);
  if (platform === 'unknown') return null;

  let html;
  try {
    html = await fetchPage(url);
  } catch {
    return null;
  }

  if (html.length < 1000) return null;

  let result = null;
  switch (platform) {
    case 'xiaohongshu': result = extractXHS(html); break;
    case 'douyin': result = extractDouyin(html); break;
    case 'kuaishou': result = extractKuaishou(html); break;
  }

  return result;
}

// ====== 浏览器提取队列 ======
function saveRequest(url) {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify({
    url,
    time: new Date().toISOString(),
    platform: detectPlatform(url),
    status: 'pending'
  }, null, 2));
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

// ====== HTTP Server ======
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Health
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: '3.0' }));
  }

  // Direct extract
  if (parsedUrl.pathname === '/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url?.startsWith('http')) throw new Error('请提供有效链接');

        console.log(`[Direct] ${url}`);
        const result = await directExtract(url);

        if (result) {
          console.log(`[OK] ${result.platform} - ${result.title || 'Untitled'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, mode: 'direct', ...result }));
        } else {
          // 直接提取失败，加入浏览器队列
          const platform = detectPlatform(url);
          saveRequest(url);
          console.log(`[Queue] ${url} → 浏览器提取队列`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            mode: 'browser',
            platform,
            message: '此链接需要浏览器提取，请在聊天中告诉AI助手"提取视频"',
            requestSaved: true
          }));
        }
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Queue a URL for browser extraction (manual trigger)
  if (parsedUrl.pathname === '/queue' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body);
        saveRequest(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '已加入浏览器提取队列' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Get current request (for AI agent to read)
  if (parsedUrl.pathname === '/request' && req.method === 'GET') {
    const reqData = getRequest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reqData || { status: 'empty' }));
    return;
  }

  // Save result (for AI agent to write)
  if (parsedUrl.pathname === '/result' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        saveResult(data);
        // Clear the request
        fs.writeFileSync(REQUEST_FILE, JSON.stringify({ status: 'completed' }));
        console.log(`[Browser OK] ${data.videoUrl?.substring(0, 60)}...`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Poll result (for page to check)
  if (parsedUrl.pathname === '/poll' && req.method === 'GET') {
    const result = getResult();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result || { status: 'waiting' }));
    return;
  }

  // Clear result
  if (parsedUrl.pathname === '/clear' && req.method === 'POST') {
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
  console.log('  🎬  视频提取服务 v3 已启动');
  console.log('  ─────────────────────────────');
  console.log(`  地址：http://localhost:${PORT}`);
  console.log('  模式：直接提取 + 浏览器提取队列');
  console.log('  支持：小红书 | 抖音 | 快手');
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});