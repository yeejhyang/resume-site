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

/**
 * 按起始标签匹配平衡的闭合块（支持任意 HTML 标签）。
 * 返回块的 [start, end) 区间与 openTag。
 */
function extractBlock(html, startPos) {
  const openTagEnd = html.indexOf('>', startPos) + 1;
  const openTag = html.slice(startPos, openTagEnd);
  const tagNameMatch = openTag.match(/^<(\w+)/);
  if (!tagNameMatch) return null;
  const tagName = tagNameMatch[1];
  // 同时扫描开标签和闭标签，正确配对嵌套深度
  const tagRe = new RegExp('<\\/?\\s*' + tagName + '\\b[^>]*>', 'g');
  tagRe.lastIndex = openTagEnd;
  let depth = 1; // 起点这个开标签
  let m;
  while ((m = tagRe.exec(html))) {
    const token = m[0];
    if (token.charAt(1) === '/') {
      depth--;
      if (depth === 0) {
        return { start: startPos, end: m.index + m[0].length, openTag };
      }
    } else {
      depth++;
    }
  }
  return null;
}

/** 向前找某个 class 的 div 开标签（支持带其他属性） */
function findClassDivStart(html, className, fromIndex) {
  const re = new RegExp('<div\\b[^>]*class="' + className + '"[^>]*>', 'g');
  let found = -1;
  let m;
  while ((m = re.exec(html))) {
    if (m.index <= fromIndex) found = m.index;
    else break;
  }
  return found;
}

/**
 * 定位某个 section（按标题文本）的完整块区间。
 */
function findSection(html, sectionName) {
  const pat = escapeRegExp(sectionName);
  const re = new RegExp(pat);
  const m = re.exec(html);
  if (!m) return null;
  // 从标题位置向前找 class="section" 的 div 起点（支持带 id 等属性）
  const secStart = findClassDivStart(html, 'section', m.index);
  if (secStart < 0) return null;
  return extractBlock(html, secStart);
}

/**
 * 定位某个 .qa 块（按问题标题文本）的完整区间。
 * 返回 { start, end, openTag, qStart, qEnd, aStart, aEnd, qContent }
 */
function findQABlock(html, qtext) {
  const pat = escapeRegExp(qtext);
  const re = new RegExp(pat);
  const m = re.exec(html);
  if (!m) return null;
  const qPos = m.index;
  // 向前找 class="q" 的 div 起点（支持带其他属性）
  const qTagStart = findClassDivStart(html, 'q', qPos);
  if (qTagStart < 0) return null;
  const qBlock = extractBlock(html, qTagStart);
  if (!qBlock) return null;
  // 向后找 class="qa" 的 div 起点（在 q 之前）
  const qaTagStart = findClassDivStart(html, 'qa', qTagStart);
  if (qaTagStart < 0) return null;
  const qaBlock = extractBlock(html, qaTagStart);
  if (!qaBlock) return null;
  // 在 qa 块内部找 class="a" 的 div
  const aRe = new RegExp('<div\\b[^>]*class="a"[^>]*>', 'g');
  aRe.lastIndex = qBlock.end;
  const aMatch = aRe.exec(html);
  let aBlock = null;
  if (aMatch && aMatch.index < qaBlock.end) {
    aBlock = extractBlock(html, aMatch.index);
  }
  return {
    qaStart: qaBlock.start,
    qaEnd: qaBlock.end,
    qStart: qBlock.start,
    qEnd: qBlock.end,
    aStart: aBlock ? aBlock.start : -1,
    aEnd: aBlock ? aBlock.end : -1,
    qContent: html.slice(qBlock.openTag.length + qBlock.start, qBlock.end - '</div>'.length).trim(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API: 更新问题标题 + 答案（按旧标题定位） ----
  if (pathname === '/api/qa/update' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, oldTitle, newTitle, answerHtml } = body;
    if (!file || !oldTitle || !newTitle) return sendJson(res, 400, { ok: false, error: '缺少参数' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      let content = fs.readFileSync(safeFile, 'utf8');
      const qa = findQABlock(content, oldTitle);
      if (!qa) return sendJson(res, 404, { ok: false, error: '未找到该问题' });
      // 替换问题标题
      content = content.slice(0, qa.qStart + '<div class="q">'.length) + newTitle + content.slice(qa.qEnd - '</div>'.length);
      // 替换答案（若提供）
      if (typeof answerHtml === 'string' && qa.aStart >= 0) {
        content = content.slice(0, qa.aStart + '<div class="a">'.length) + answerHtml + content.slice(qa.aEnd - '</div>'.length);
      }
      fs.writeFileSync(safeFile, content, 'utf8');
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---- API: 删除问题 ----
  if (pathname === '/api/qa/delete' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, title } = body;
    if (!file || !title) return sendJson(res, 400, { ok: false, error: '缺少参数' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      const content = fs.readFileSync(safeFile, 'utf8');
      const qa = findQABlock(content, title);
      if (!qa) return sendJson(res, 404, { ok: false, error: '未找到该问题' });
      const newContent = content.slice(0, qa.qaStart) + content.slice(qa.qaEnd);
      fs.writeFileSync(safeFile, newContent, 'utf8');
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---- API: 在指定 section 追加新问题 ----
  if (pathname === '/api/qa/add' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, sectionName, title, answerHtml } = body;
    if (!file || !sectionName || !title) return sendJson(res, 400, { ok: false, error: '缺少参数' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      const content = fs.readFileSync(safeFile, 'utf8');
      const sec = findSection(content, sectionName);
      if (!sec) return sendJson(res, 404, { ok: false, error: '未找到该 section' });
      const ans = (typeof answerHtml === 'string' && answerHtml) ? answerHtml : '<p></p>';
      const newQA = '\n  <div class="qa">\n    <div class="q">' + title + '</div>\n    <div class="a">\n      ' + ans + '\n    </div>\n  </div>';
      // 在 section 的闭合 </div> 前插入
      const insertPos = sec.end - '</div>'.length;
      const newContent = content.slice(0, insertPos) + newQA + content.slice(insertPos);
      fs.writeFileSync(safeFile, newContent, 'utf8');
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---- API: 重排 section 顺序 + 可选改名 ----
  if (pathname === '/api/section/reorder' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, sections } = body; // sections: [{oldName, newName?}]
    if (!file || !Array.isArray(sections) || !sections.length) return sendJson(res, 400, { ok: false, error: '缺少参数' });
    const safeFile = path.normalize(path.join(ROOT, file));
    if (!safeFile.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: '非法路径' });
    try {
      const content = fs.readFileSync(safeFile, 'utf8');
      // 解析所有 section 块（按原文顺序，支持 class="section" 带其他属性）
      const secs = [];
      const secTagRe = /<div\b[^>]*class="section"[^>]*>/g;
      let sm;
      while ((sm = secTagRe.exec(content))) {
        const block = extractBlock(content, sm.index);
        if (!block) break;
        // 提取该 section 的标题
        const h2m = content.indexOf('<h2>', block.start);
        const h2End = content.indexOf('</h2>', h2m);
        let name = '';
        if (h2m >= 0 && h2End > h2m && h2m < block.end) name = content.slice(h2m + '<h2>'.length, h2End);
        secs.push({ name: name, block: block });
        secTagRe.lastIndex = block.end;
      }
      if (!secs.length) return sendJson(res, 404, { ok: false, error: '未找到 section' });

      // 按新顺序重建
      let rebuilt = '';
      sections.forEach(function (s) {
        const orig = secs.find(function (x) { return x.name === s.oldName; });
        if (!orig) return;
        let blk = content.slice(orig.block.start, orig.block.end);
        // 改名：替换 <h2>name</h2>
        if (s.newName && s.newName !== s.oldName) {
          const h2m = blk.indexOf('<h2>');
          const h2End = blk.indexOf('</h2>', h2m);
          if (h2m >= 0 && h2End > h2m) blk = blk.slice(0, h2m + '<h2>'.length) + s.newName + blk.slice(h2End);
        }
        rebuilt += '\n' + blk + '\n';
      });
      // 用重建后的 section 块替换原文中的所有 section 块
      const firstStart = secs[0].block.start;
      const lastEnd = secs[secs.length - 1].block.end;
      const newContent = content.slice(0, firstStart) + rebuilt + content.slice(lastEnd);
      fs.writeFileSync(safeFile, newContent, 'utf8');
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

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
