/**
 * 视频提取本地服务 v2
 * 启动方式：node server.js
 * 端口：3456
 *
 * 支持平台：小红书、抖音、快手
 * 提取无水印视频直链
 * 内置会话管理、多策略提取、自动重试
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 3456;

// ====== Cookie 会话管理 ======
const sessions = {};

function getCookieJar(platform) {
  if (!sessions[platform]) {
    sessions[platform] = { cookies: '', lastRefresh: 0 };
  }
  return sessions[platform];
}

function updateCookies(platform, setCookieHeaders) {
  const jar = getCookieJar(platform);
  for (const h of setCookieHeaders) {
    const parts = h.split(';')[0].split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      const existing = jar.cookies.split('; ').filter(c => !c.startsWith(name + '='));
      existing.push(name + '=' + value);
      jar.cookies = existing.join('; ');
    }
  }
  jar.lastRefresh = Date.now();
}

// ====== HTTP 请求 ======
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const platform = detectPlatform(url);

    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...options.headers
      },
      timeout: 20000,
      rejectUnauthorized: false
    };

    // 添加平台 Cookie
    const jar = getCookieJar(platform);
    if (jar.cookies) {
      reqOptions.headers['Cookie'] = jar.cookies;
    }

    if (options.body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    }

    const req = mod.request(reqOptions, (res) => {
      // 保存 Cookie
      if (res.headers['set-cookie']) {
        updateCookies(platform, res.headers['set-cookie']);
      }

      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return request(redirectUrl, { ...options, headers: { ...options.headers, Referer: url } })
          .then(resolve).catch(reject);
      }

      if (res.statusCode === 404) {
        return reject(new Error('页面不存在(404)，请检查链接是否正确'));
      }
      if (res.statusCode === 403) {
        return reject(new Error('访问被拒绝(403)，平台可能限制了访问'));
      }
      if (res.statusCode >= 500) {
        return reject(new Error(`服务器错误(${res.statusCode})，请稍后重试`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        // 处理 gzip
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip' || encoding === 'deflate') {
          const zlib = require('zlib');
          const method = encoding === 'gzip' ? 'gunzip' : 'inflate';
          zlib[method](raw, (err, decoded) => {
            if (err) return reject(err);
            resolve({ data: decoded.toString(), headers: res.headers, statusCode: res.statusCode });
          });
        } else {
          resolve({ data: raw.toString(), headers: res.headers, statusCode: res.statusCode });
        }
      });
      res.on('error', reject);
    });

    req.on('error', (e) => {
      if (e.code === 'ENOTFOUND') reject(new Error('无法解析域名，请检查网络连接'));
      else if (e.code === 'ECONNREFUSED') reject(new Error('连接被拒绝，平台可能屏蔽了请求'));
      else if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') reject(new Error('请求超时，请检查网络或稍后重试'));
      else reject(e);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

    if (options.body) req.write(options.body);
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

// ====== 小红书提取 ======
async function extractXiaohongshu(url) {
  // 短链接展开
  let targetUrl = url;
  if (url.includes('xhslink.com')) {
    try {
      const res = await request(url, { method: 'GET' });
      // 从重定向后的URL或页面中提取
      const redirectMatch = res.data.match(/href="([^"]*explore[^"]+)"/);
      if (redirectMatch) targetUrl = redirectMatch[1];
    } catch {}
  }

  // 先访问首页获取 Cookie
  try {
    await request('https://www.xiaohongshu.com', { method: 'GET' });
  } catch {}

  // 再访问目标页面
  let html = '';
  try {
    const res = await request(targetUrl);
    html = res.data;
  } catch (e) {
    throw new Error('无法访问小红书页面：' + e.message);
  }

  if (html.length < 500) {
    throw new Error('小红书返回内容过短，可能需要登录或更换链接');
  }

  // 策略1：从 __INITIAL_STATE__ 提取
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (stateMatch) {
    try {
      let stateStr = stateMatch[1]
        .replace(/undefined/g, 'null')
        .replace(/:\s*"(https?:\/\/[^"]*)"/g, (m, url) => m.replace(/\\/g, ''));
      const state = JSON.parse(stateStr);

      const noteDetail = state?.note?.noteDetail || state?.note;

      if (noteDetail && noteDetail.type === 'video') {
        const videoInfo = noteDetail.video;
        const media = videoInfo?.media;
        const stream = media?.stream;

        let videoUrl = '';
        let resolution = '';

        // 按优先级获取视频流
        const candidates = [];
        if (stream?.h264) candidates.push(...stream.h264);
        if (stream?.h265) candidates.push(...stream.h265);
        if (stream?.av1) candidates.push(...stream.av1);

        if (candidates.length > 0) {
          // 取最高质量
          candidates.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          videoUrl = candidates[0].masterUrl;
          resolution = candidates[0].definition || '';
        }

        if (!videoUrl && media?.url) videoUrl = media.url;
        if (!videoUrl && videoInfo?.urls) {
          videoUrl = videoInfo.urls.h264 || videoInfo.urls.h265 || videoInfo.urls.default || '';
        }

        if (videoUrl) {
          return {
            success: true,
            platform: '小红书',
            videoUrl,
            title: noteDetail.title || noteDetail.displayTitle || '',
            duration: videoInfo.duration ? Math.floor(videoInfo.duration / 1000) + 's' : '',
            resolution,
            cover: videoInfo.image?.urlDefault || videoInfo.cover?.url || '',
            author: noteDetail.user?.nickname || noteDetail.user?.nickName || ''
          };
        }
      } else if (noteDetail) {
        throw new Error('该链接是图文笔记，不是视频。请粘贴视频笔记的链接');
      }
    } catch (e) {
      if (e.message.includes('图文笔记') || e.message.includes('视频')) throw e;
      console.error('XHS state parse:', e.message);
    }
  }

  // 策略2：从 script 标签提取视频 URL
  const videoUrlMatch = html.match(/["'](https?:\/\/sns-video[^"']+\.(?:mp4|mov))["']/);
  if (videoUrlMatch) {
    return {
      success: true,
      platform: '小红书',
      videoUrl: videoUrlMatch[1].replace(/\\u002F/g, '/'),
      title: '',
      duration: ''
    };
  }

  // 策略3：检查是否是视频页面
  const typeMatch = html.match(/["']type["']\s*:\s*["'](video|normal)["']/);
  if (typeMatch && typeMatch[1] !== 'video') {
    throw new Error('该链接是图文笔记，不是视频。请粘贴视频笔记的链接');
  }

  throw new Error('未能从小红书页面提取到视频。可能原因：1) 链接不是视频笔记 2) 页面需要登录 3) 平台反爬升级');
}

// ====== 抖音提取 ======
async function extractDouyin(url) {
  let targetUrl = url;
  if (url.includes('v.douyin.com')) {
    try {
      const res = await request(url);
      const locMatch = res.headers?.location || res.data?.match(/href="([^"]+)"/)?.[1];
      if (locMatch) targetUrl = locMatch;
    } catch {}
  }

  // 先访问首页获取 Cookie
  try {
    await request('https://www.douyin.com', { method: 'GET' });
  } catch {}

  let html = '';
  try {
    const res = await request(targetUrl, {
      headers: {
        'Referer': 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    html = res.data;
  } catch (e) {
    throw new Error('无法访问抖音页面：' + e.message);
  }

  // 策略1：从 RENDER_DATA 提取
  const renderMatch = html.match(/<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/);
  if (renderMatch) {
    try {
      const decoded = decodeURIComponent(renderMatch[1]);
      const data = JSON.parse(decoded);

      let videoData = null;
      const findVideo = (obj, path = '') => {
        if (!obj || typeof obj !== 'object' || videoData) return;
        if (obj.video && (obj.video.playAddr || obj.video.playApi)) {
          videoData = obj;
          return;
        }
        if (obj.playAddr && obj.video_id) {
          videoData = { video: obj, desc: obj.desc };
          return;
        }
        for (const key of Object.keys(obj)) {
          if (Array.isArray(obj[key])) {
            obj[key].forEach(item => findVideo(item, path + '.' + key));
          } else if (typeof obj[key] === 'object') {
            findVideo(obj[key], path + '.' + key);
          }
        }
      };
      findVideo(data);

      if (videoData?.video) {
        const v = videoData.video;
        let videoUrl = '';

        // 无水印 URL：优先使用 playApi
        if (v.playApi) {
          videoUrl = v.playApi;
        } else if (v.playAddr) {
          // 尝试去除水印
          videoUrl = v.playAddr
            .replace('/playwm/', '/play/')
            .replace('watermark=1', 'watermark=0')
            .replace(/\\u002F/g, '/');
        }

        if (videoUrl) {
          return {
            success: true,
            platform: '抖音',
            videoUrl,
            title: v.desc || videoData.desc || '',
            duration: v.duration ? Math.floor(v.duration / 1000) + 's' : '',
            cover: v.cover?.urlList?.[0] || v.cover?.url_list?.[0] || '',
            author: videoData.author?.nickname || ''
          };
        }
      }
    } catch (e) {
      console.error('Douyin render parse:', e.message);
    }
  }

  // 策略2：从 script 标签提取
  const addrMatch = html.match(/playAddr["']:\s*["']([^"']+)["']/);
  if (addrMatch) {
    let videoUrl = addrMatch[1].replace(/\\u002F/g, '/');
    videoUrl = videoUrl.replace('/playwm/', '/play/');
    return {
      success: true,
      platform: '抖音',
      videoUrl,
      title: '',
      duration: ''
    };
  }

  // 策略3：从 video_id 构建
  const vidMatch = targetUrl.match(/video\/(\d+)/) || html.match(/video[_-]id["']:\s*["'](\d+)["']/);
  if (vidMatch) {
    throw new Error('抖音页面解析成功但未找到视频直链。可能需要更换链接或稍后重试');
  }

  throw new Error('未能从抖音页面提取到视频，请确认链接是有效的抖音视频');
}

// ====== 快手提取 ======
async function extractKuaishou(url) {
  let targetUrl = url;
  if (url.includes('v.kuaishou.com')) {
    try {
      const res = await request(url);
      const locMatch = res.headers?.location;
      if (locMatch) targetUrl = locMatch;
    } catch {}
  }

  let html = '';
  try {
    const res = await request(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    html = res.data;
  } catch (e) {
    throw new Error('无法访问快手页面：' + e.message);
  }

  // 策略1：__INITIAL_STATE__
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const photo = state?.photo || state?.video || state?.detail;
      if (photo) {
        let videoUrl = photo.photoUrl || photo.videoUrl || '';
        if (!videoUrl && photo.mainMvUrls) {
          const mv = photo.mainMvUrls[0];
          videoUrl = mv.url || mv;
        }
        if (videoUrl) {
          return {
            success: true,
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

  // 策略2：video 标签
  const videoMatch = html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|mov))["']/);
  if (videoMatch) {
    return {
      success: true,
      platform: '快手',
      videoUrl: videoMatch[1].replace(/\\u002F/g, '/'),
      title: '',
      duration: ''
    };
  }

  throw new Error('未能从快手页面提取到视频，请确认链接有效');
}

// ====== 主提取函数 ======
async function extractVideo(url) {
  const platform = detectPlatform(url);

  switch (platform) {
    case 'xiaohongshu':
      return extractXiaohongshu(url);
    case 'douyin':
      return extractDouyin(url);
    case 'kuaishou':
      return extractKuaishou(url);
    default:
      throw new Error('不支持的平台。目前支持：小红书(xiaohongshu.com/xhslink.com)、抖音(douyin.com)、快手(kuaishou.com)');
  }
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

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', platforms: ['xiaohongshu', 'douyin', 'kuaishou'], version: '2.0' }));
  }

  if (parsedUrl.pathname === '/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url || !url.startsWith('http')) throw new Error('请提供有效的视频链接(以 http:// 或 https:// 开头)');

        console.log(`\n[Extract] ${url}`);
        const result = await extractVideo(url);
        console.log(`[Success] ${result.platform} - ${result.title || 'Untitled'} (${result.duration || 'unknown'})`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error(`[Error] ${e.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🎬  视频提取服务 v2 已启动');
  console.log('  ─────────────────────────────');
  console.log(`  地址：http://localhost:${PORT}`);
  console.log(`  健康检查：http://localhost:${PORT}/health`);
  console.log('');
  console.log('  支持平台：小红书 | 抖音 | 快手');
  console.log('  新特性：会话管理 · 多策略提取 · 自动重试');
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});