/**
 * 本地静态服务 + 答案读写 API
 * 用于在浏览器中编辑「标准答案」后直接写回源 HTML 文件。
 *
 * 启动：node server.js  (默认端口 8080)
 * 访问：http://localhost:8080/index.html
 *
 * 约定：key = 问题标题文本（qtext），后端用它在源文件里定位答案块 `.a`。
 *   GET  /api/answer/get?file=X&key=QTEXT  -> { ok, innerHtml }
 *   POST /api/answer/save {file,key,innerHtml} -> { ok }
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 按「问题标题文本 qtext」定位答案块 .a。
 *
 * 流程：
 *   1) 用转义 qtext 找到问题标题所在位置（源文件里 .q 为纯文本）。
 *   2) 从该位置向后找到第一个 `<div class="a"` 开头的答案块起点。
 *   3) 用「平衡 div 计数」数到匹配的闭合 </div>，返回整块。
 * 返回 null 表示未找到。
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAnswerBlock(html, qtext) {
  const pat = escapeRegExp(qtext);
  const qRe = new RegExp(pat);
  const qMatch = qRe.exec(html);
  if (!qMatch) return null;
  const qPos = qMatch.index;

  // 从问题位置向后找答案块起点 <div class="a"
  const aRe = /<div\s+class="a"/g;
  aRe.lastIndex = qPos;
  const aMatch = aRe.exec(html);
  if (!aMatch) return null;
  const blockStart = aMatch.index;
  const openTagEnd = html.indexOf('>', blockStart) + 1;

  // 平衡 div 计数，找匹配的闭合 </div>
  let depth = 0;
  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = blockStart;
  let m;
  let end = blockStart;
  let found = false;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    if (tag.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        end = m.index + tag.length;
        found = true;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (!found) return null;

  return {
    start: blockStart,
    end: end,
    openTag: html.slice(blockStart, openTagEnd),
    innerHtml: html.slice(openTagEnd, end - '</div>'.length),
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API: 读取某个答案块 ----
  if (pathname === '/api/answer/get' && req.method === 'GET') {
    const file = url.searchParams.get('file');
    const key = url.searchParams.get('key');
    if (!file || !key) return sendJson(res, 400, { ok: false, error: '缺少 file/key 参数' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      const html = fs.readFileSync(safeFile, 'utf8');
      const block = extractAnswerBlock(html, key);
      if (!block) return sendJson(res, 404, { ok: false, error: '未找到该答案块' });
      return sendJson(res, 200, { ok: true, innerHtml: block.innerHtml });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---- API: 写回答案块 ----
  if (pathname === '/api/answer/save' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, key, innerHtml } = body;
    if (!file || !key || typeof innerHtml !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 file/key/innerHtml' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      const content = fs.readFileSync(safeFile, 'utf8');
      const block = extractAnswerBlock(content, key);
      if (!block) return sendJson(res, 404, { ok: false, error: '未找到该答案块' });
      const rebuilt = block.openTag + innerHtml + '</div>';
      const newContent = content.slice(0, block.start) + rebuilt + content.slice(block.end);
      fs.writeFileSync(safeFile, newContent, 'utf8');
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---- 静态文件 ----
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(ROOT, filePath));
  if (!abs.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`✅ 服务已启动: http://localhost:${PORT}/index.html`);
});
