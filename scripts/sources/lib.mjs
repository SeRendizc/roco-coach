// 社区源工具共用的小零件：cookie 罐、HTML 抽取、HTTP、证据落盘。
//
// 设计红线（与仓库既有的取证口径一致）
// ------------------------------------
// 1. **fail closed**：取不到就 `status: 'blocked'` / `'login_required'`，**绝不写 0 条**、
//    绝不拿标题猜正文。每个产物都带 `http_status` 与 `blocked_reason`。
// 2. **raw 先落地再解析**：原始响应写进 `data/roco/raw/community/`（已被 .gitignore 覆盖），
//    解析失败时人还能回去看原文。派生 JSON 只放小结果。
// 3. **不引外部依赖**：node: 内置模块 + 手写 HTML 抽取。这些站点没有稳定 API，
//    真正的资产是「URL + header + cookie + 抽取契约」，不是某个库。
//
// 为什么 cookie 要单独存：贴吧正文页、NGA、小红书、小黑盒都卡在登录态。
// `login-helper.mjs` 打开真 Chrome 让人扫码，会话写进 `.dsh-sources/sessions.json`，
// 之后所有工具都从这里取 cookie——这样 DSH 只需要「人登录一次」这一个前提。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const SESSION_FILE = join(ROOT, '.dsh-sources', 'sessions.json');
export const RAW_DIR = join(ROOT, 'data', 'roco', 'raw', 'community');

export const UA = {
  // 贴吧移动版：**UA 决定服务端渲染哪一版**，桌面版是纯 JS 空壳
  tiebaMobile:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  bili:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  heybox:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36; xiaoheihe/1.3.210',
};

// ---------------------------------------------------------------------------
// cookie 罐
// ---------------------------------------------------------------------------

export function loadSessions() {
  if (!existsSync(SESSION_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 取某个源的发货 cookie 串。会话文件形如：
 *   { "tieba": {"cookies": {"BDUSS": "...", "STOKEN": "..."}, "saved_at": "..."} }
 * 也接受直接塞整串 `{"tieba": {"cookie": "a=1; b=2"}}`，方便手工粘贴。
 */
export function cookieFor(source, overrides = {}) {
  if (overrides.cookie) return {header: overrides.cookie, source: 'cli'};
  const s = loadSessions()[source];
  if (!s) return {header: '', source: 'none'};
  if (typeof s.cookie === 'string' && s.cookie.trim()) return {header: s.cookie.trim(), source: 'session(raw)'};
  if (s.cookies && typeof s.cookies === 'object') {
    const header = Object.entries(s.cookies)
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (header) return {header, source: `session(${s.saved_at ?? 'unknown'})`};
  }
  return {header: '', source: 'none'};
}

export function saveSession(source, cookies, extra = {}) {
  const all = loadSessions();
  all[source] = {
    cookies,
    saved_at: new Date().toISOString(),
    ...extra,
  };
  mkdirSync(dirname(SESSION_FILE), {recursive: true});
  writeFileSync(SESSION_FILE, JSON.stringify(all, null, 2) + '\n');
  return SESSION_FILE;
}

// ---------------------------------------------------------------------------
// HTTP + 取证
// ---------------------------------------------------------------------------

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 抓一次，返回 { status, finalUrl, contentType, bytes, ms, sha, text }。
 * 不抛异常给调用方去猜：网络层错误包成 status=0 + error，让上层按 blocked 处理。
 */
export async function fetchText(url, {ua = UA.desktop, headers = {}, cookie = '', charset = 'utf-8', timeoutMs = 20000} = {}) {
  const h = {
    'user-agent': ua,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  if (cookie) h.cookie = cookie;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {headers: h, redirect: 'follow', signal: ctl.signal});
    const buf = Buffer.from(await res.arrayBuffer());
    clearTimeout(timer);
    let text;
    try {
      text = new TextDecoder(charset === 'gbk' ? 'gb18030' : charset, {fatal: false}).decode(buf);
    } catch {
      text = new TextDecoder('utf-8', {fatal: false}).decode(buf);
    }
    return {
      status: res.status,
      finalUrl: res.url,
      contentType: res.headers.get('content-type') ?? '',
      bytes: buf.length,
      ms: Date.now() - t0,
      sha: sha256(buf),
      text,
      buffer: buf,
    };
  } catch (err) {
    return {status: 0, finalUrl: url, contentType: '', bytes: 0, ms: Date.now() - t0, sha: '', text: '', error: String(err?.message ?? err)};
  }
}

/** 原始响应落地（.gitignore 覆盖），返回相对路径。 */
export function saveRaw(source, name, res) {
  if (!res.buffer) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(RAW_DIR, source, day);
  mkdirSync(dir, {recursive: true});
  const file = join(dir, `${name}.raw`);
  writeFileSync(file, res.buffer);
  const meta = join(dir, `${name}.meta.json`);
  const {buffer, text, ...rest} = res;
  writeFileSync(meta, JSON.stringify({...rest, text_head: text.slice(0, 400)}, null, 2));
  return {raw: file.replace(ROOT + '/', ''), meta: meta.replace(ROOT + '/', '')};
}

// ---------------------------------------------------------------------------
// HTML 抽取（够用就好，不做通用解析器）
// ---------------------------------------------------------------------------

const NAMED = {nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"'};

export function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39|#34);/g, (_, n) => NAMED[n] ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export function stripTags(s) {
  return unescapeHtml(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** 抽可见正文：去 script/style/标签，压空白。用于「有没有内容」这类判断。 */
export function htmlToText(html) {
  return unescapeHtml(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * 「这页到底是空壳还是正文」的判据。
 *
 * 比正则匹配文案可靠得多——实测踩到的坑：贴吧 `/p/<tid>` 在
 *   * 桌面 UA → 11192B「**百度安全验证**」页
 *   * 移动 UA → 7091B「**贴吧小程序**」SPA 空壳页（标题是"贴吧小程序"，正文全空）
 * 两种都**不含**「百度安全验证」四个字在可见文本里，所以只按文案匹配会把空壳判成成功。
 * 这里改成「**必须找到正文标记**」才放行：markers 一个都没有 → js_shell。
 *
 * @param html      原始 HTML
 * @param markers   只有真正文页才会出现的字符串（如 `p_content` / `d_post_content`）
 */
export function classifyPage(html, {markers = [], minBytes = 0, status = 200, text} = {}) {
  const h = String(html ?? '');
  const visible = text ?? htmlToText(h);
  if (status === 0) return {kind: 'fetch_failed'};
  if (status === 403) return {kind: 'http_403'};
  if (/百度安全验证/.test(visible) || /百度安全验证/.test(h)) return {kind: 'baidu_security_check'};
  if (/访客不能直接访问|ERROR:\s*1[15]|未登录\s*\(ERROR/.test(visible)) return {kind: 'nga_guest_blocked'};
  if (minBytes && Buffer.byteLength(h) < minBytes) return {kind: 'too_small'};
  // markers 必须在"可见文本够不够"之前判：SPA 空壳的可见文本本来就是空的，
  // 先判文本长度会把「结构变了」误报成「文字太少」——两种原因的下一步动作不一样。
  if (markers.length > 0 && !markers.some((m) => h.includes(m))) {
    return {kind: 'js_shell_or_structure_changed', visible_len: visible.length, hint: `未找到正文标记 ${markers.join(' | ')}`};
  }
  if (visible.length < 40) return {kind: 'too_little_visible_text', visible_len: visible.length};
  return {kind: 'ok'};
}

/**
 * 只按「页面特征」判定被挡的原因（没有正文标记可用时用这个）。
 *
 * 注意别再包一层「返回字符串或 null」的薄封装：那会丢掉 kind 与 hint，
 * 让两条调用路径判出不同的 reason（踩过：同一页在 search 路由报
 * `too_little_visible_text`、在 thread 路由报 `js_shell_or_structure_changed`，
 * 同一份 HTTP 响应，两个结论——不可复现的日志比没有日志更坏）。
 */
export function detectWall(text, status) {
  const k = classifyPage(text, {status});
  return k.kind === 'ok' ? null : k;
}

/** 统一的「wall → {content_kind, blocked_reason, hint}」映射，避免各处自己拼字符串。 */
export function wallVerdict(wall, {loginSource = null} = {}) {
  if (!wall) return {content_kind: 'ok', blocked_reason: null, hint: null};
  const kind = wall.kind;
  const needsLogin = ['http_403', 'baidu_security_check', 'js_shell_or_structure_changed', 'nga_guest_blocked', 'fetch_failed', 'too_little_visible_text', 'too_small'].includes(kind);
  return {
    content_kind: kind,
    blocked_reason: kind,
    hint: needsLogin && loginSource ? `要登录态或结构已变：先跑 node scripts/sources/login-helper.mjs ${loginSource}` : (wall.hint ?? null),
  };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function writeOut(path, obj) {
  const p = resolve(path);
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

export function parseArgv(argv) {
  const opts = {_: []};
  // 这些开关的值**允许含空格**（cookie 串就是 'k=v; k=v; ...'）：shell 没加引号时
  // 会被拆成 ['BDUSS=x;', 'STOKEN=y']，这里按「下一个真实 flag 之前都是值」重新拼回。
  const RAW_VALUE_FLAGS = new Set(['paste', 'cookie', 'header', 'keys']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
      continue;
    }
    if (RAW_VALUE_FLAGS.has(key)) {
      const parts = [argv[++i]];
      // 片段特征：含 '=' 或是 'k=v;' 这种 cookie 对。不满足就停下——
      // 这样 `--paste tieba 'BDUSS=x'` 不会把后面的位置参数吃进来。
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--') && /[=;]/.test(argv[i + 1])) parts.push(argv[++i]);
      opts[key] = parts.join(' ');
      continue;
    }
    opts[key] = next;
    i += 1;
  }
  return opts;
}

/** 极简参数表 → stdout，便于 `--help` 与「参数写错时别静默」。 */
export function printHelp(lines) {
  process.stdout.write(lines.join('\n') + '\n');
}
