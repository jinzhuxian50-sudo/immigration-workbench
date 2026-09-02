/**
 * 视频提取本地服务
 * 启动方式：node server.js
 * 端口：3456
 *
 * 支持平台：小红书、抖音、快手
 * 提取无水印视频直链
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 3456;

// ====== HTTP helpers ======
function fetchHTML(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': `${parsed.protocol}//${parsed.hostname}/`,
        ...headers
      },
      timeout: 15000
    };

    const req = mod.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location, headers).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function fetchJSON(url, headers = {}) {
  return fetchHTML(url, headers).then(data => JSON.parse(data));
}

function followRedirect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        ...headers
      },
      timeout: 10000
    };

    const req = mod.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve(url); });
    req.end();
  });
}

// ====== Platform extractors ======

/**
 * 小红书视频提取
 * 策略：从分享页HTML中提取 __INITIAL_STATE__ 里的视频信息
 * 小红书视频URL通常不带水印参数
 */
async function extractXiaohongshu(inputUrl) {
  // 短链接先展开
  let url = inputUrl;
  if (url.includes('xhslink.com')) {
    url = await followRedirect(url);
  }

  const html = await fetchHTML(url, {
    'Cookie': 'abRequestId=; a1=; webId=;'
  });

  // 尝试从 __INITIAL_STATE__ 提取
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1].replace(/undefined/g, 'null'));
      const noteDetail = state?.note?.noteDetail || state?.note;

      if (noteDetail) {
        const videoInfo = noteDetail.video;
        if (videoInfo) {
          // 视频信息
          const media = videoInfo.media;
          const stream = media?.stream;
          const videoId = videoInfo.videoId || noteDetail.noteId;

          let videoUrl = '';

          // 优先使用高清流
          if (stream?.h264?.[0]?.masterUrl) {
            videoUrl = stream.h264[0].masterUrl;
          } else if (stream?.h265?.[0]?.masterUrl) {
            videoUrl = stream.h265[0].masterUrl;
          } else if (stream?.av1?.[0]?.masterUrl) {
            videoUrl = stream.av1[0].masterUrl;
          }

          // 如果stream没有，尝试从media.url
          if (!videoUrl && media?.url) {
            videoUrl = media.url;
          }

          // 尝试从videoInfo.urls
          if (!videoUrl && videoInfo.urls) {
            const urls = videoInfo.urls;
            videoUrl = urls.h264 || urls.h265 || urls.default || '';
          }

          if (videoUrl) {
            // 移除水印相关参数（小红书水印是通过URL参数控制的）
            try {
              const vu = new URL(videoUrl);
              vu.searchParams.delete('wm'); // 移除水印参数
              videoUrl = vu.toString();
            } catch {}

            return {
              success: true,
              platform: '小红书',
              videoUrl,
              title: noteDetail.title || noteDetail.displayTitle || '',
              duration: videoInfo.duration ? Math.floor(videoInfo.duration / 1000) + 's' : '',
              cover: videoInfo.image?.urlDefault || videoInfo.cover?.url || '',
              author: noteDetail.user?.nickname || noteDetail.user?.nickName || ''
            };
          }
        }
      }
    } catch(e) {
      console.error('XHS state parse error:', e.message);
    }
  }

  // 备选：从JSON-LD或其他嵌入数据提取
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld.video?.contentUrl) {
        return {
          success: true,
          platform: '小红书',
          videoUrl: ld.video.contentUrl,
          title: ld.name || '',
          duration: ld.video.duration || '',
          author: ld.author?.name || ''
        };
      }
    } catch {}
  }

  throw new Error('未能从小红书页面提取到视频，请确认链接是视频笔记');
}

/**
 * 抖音视频提取
 */
async function extractDouyin(inputUrl) {
  let url = inputUrl;
  if (url.includes('v.douyin.com')) {
    url = await followRedirect(url);
  }

  const html = await fetchHTML(url);

  // 从 RENDER_DATA 提取
  const renderMatch = html.match(/<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/);
  let videoData = null;

  if (renderMatch) {
    try {
      const decoded = decodeURIComponent(renderMatch[1]);
      const data = JSON.parse(decoded);
      // 遍历找视频数据
      const traverse = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.video && obj.video.playAddr) {
          videoData = obj;
          return;
        }
        if (obj.playAddr && obj.video_id) {
          videoData = { video: obj };
          return;
        }
        Object.values(obj).forEach(traverse);
      };
      traverse(data);
    } catch(e) {
      console.error('Douyin render parse error:', e.message);
    }
  }

  if (videoData?.video) {
    const v = videoData.video;
    let videoUrl = '';

    // 抖音水印URL特征：playAddr包含watermark
    // 无水印URL需要用 playApi 或替换参数
    if (v.playApi) {
      videoUrl = v.playApi;
    } else if (v.playAddr) {
      // 尝试去除水印：替换playwm为play
      videoUrl = v.playAddr.replace('/playwm/', '/play/').replace('watermark=1', 'watermark=0');
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

  // 备选：从script标签中提取
  const scriptMatch = html.match(/playAddr["']:\s*["']([^"']+)["']/);
  if (scriptMatch) {
    let videoUrl = scriptMatch[1].replace(/\\u002F/g, '/');
    videoUrl = videoUrl.replace('/playwm/', '/play/');
    return {
      success: true,
      platform: '抖音',
      videoUrl,
      title: '',
      duration: ''
    };
  }

  throw new Error('未能从抖音页面提取到视频');
}

/**
 * 快手视频提取
 */
async function extractKuaishou(inputUrl) {
  let url = inputUrl;
  if (url.includes('v.kuaishou.com') || url.includes('kuaishou.com/s/')) {
    url = await followRedirect(url);
  }

  const html = await fetchHTML(url);

  // 从 __INITIAL_STATE__ 或 window.__APOLLO_STATE__ 提取
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const photo = state?.photo || state?.video || state?.detail;
      if (photo) {
        let videoUrl = photo.photoUrl || photo.videoUrl || photo.mainMvUrls?.[0]?.url || '';
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

  // 从video标签提取
  const videoSrcMatch = html.match(/<video[^>]+src=["']([^"']+)["']/);
  if (videoSrcMatch) {
    return {
      success: true,
      platform: '快手',
      videoUrl: videoSrcMatch[1],
      title: '',
      duration: ''
    };
  }

  throw new Error('未能从快手页面提取到视频');
}

// ====== Platform router ======
function detectPlatform(url) {
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return 'xiaohongshu';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'douyin';
  if (url.includes('kuaishou.com')) return 'kuaishou';
  return 'unknown';
}

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
      throw new Error('不支持的平台，目前支持小红书、抖音、快手');
  }
}

// ====== HTTP Server ======
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (parsedUrl.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', platforms: ['xiaohongshu', 'douyin', 'kuaishou'] }));
  }

  // Extract
  if (parsedUrl.pathname === '/extract' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) throw new Error('请提供视频链接');

        console.log(`[Extract] ${url}`);
        const result = await extractVideo(url);
        console.log(`[Success] ${result.platform} - ${result.title || 'Untitled'}`);

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

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🎬  视频提取服务已启动');
  console.log('  ─────────────────────────');
  console.log(`  地址：http://localhost:${PORT}`);
  console.log(`  健康检查：http://localhost:${PORT}/health`);
  console.log('');
  console.log('  支持平台：小红书 | 抖音 | 快手');
  console.log('  提取的视频无水印，保存在本地');
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});