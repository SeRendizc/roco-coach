#!/usr/bin/env node
// 登录助手：起一个**真 Chrome**、用 CDP 把登录后的 cookie 抓回来存好。
//
// 为什么需要它
// ------------
// 三个源卡在同一个地方——**登录态**，而不是技术做不到：
//   * 贴吧正文页 `/p/<tid>` → 「百度安全验证」（要 BDUSS）
//   * NGA 全站 → 403「访客不能直接访问」（要 ngapassport cookie）
//   * 小红书 → 搜索页只有骨架，正文要 web_session
//   * 小黑盒 → App 接口要签名，但网页版登录后的会话能拿到分享页数据
// 与其去逆向各家签名（脆弱、随版本失效），不如**让人扫码登录一次**，
// 然后把浏览器里那份 cookie 复用给命令行工具。这是稳定侧。
//
// 实现：零依赖。用 Node 内置 WebSocket 直连 Chrome DevTools Protocol，
// `Network.getAllCookies` 取 cookie。不装 puppeteer/playwright。
//
// 用法
// ----
//   node scripts/sources/login-helper.mjs tieba
//   node scripts/sources/login-helper.mjs xiaohongshu --timeout 600
//   node scripts/sources/login-helper.mjs --list
//   node scripts/sources/login-helper.mjs --show tieba     # 看已存会话（值做遮罩）
//   node scripts/sources/login-helper.mjs --paste tieba 'BDUSS=xxx; STOKEN=yyy'   # 手工粘贴
//   node scripts/sources/login-helper.mjs --check          # 检查所有已存会话是否还在用
//
// 产物：`.dsh-sources/sessions.json`（已在 .gitignore 覆盖范围内，**不要提交**）

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT, SESSION_FILE, UA, cookieFor, fetchText, loadSessions, parseArgv, printHelp, saveSession} from './lib.mjs';

const SOURCES = {
  tieba: {
    label: '百度贴吧',
    url: 'https://tieba.baidu.com/',
    expect: ['BDUSS'],
    domain: ['baidu.com'],
  },
  nga: {
    label: 'NGA 艾泽拉斯国家地理',
    url: 'https://ngabbs.com/',
    expect: ['ngaPassportUid', 'ngaPassportCid'],
    domain: ['ngabbs.com', 'nga.cn', '178.com'],
  },
  xiaohongshu: {
    label: '小红书',
    url: 'https://www.xiaohongshu.com/explore',
    expect: ['web_session'],
    domain: ['xiaohongshu.com'],
  },
  xiaoheihe: {
    label: '小黑盒',
    url: 'https://www.xiaoheihe.cn/',
    expect: ['heybox_id', 'user_heybox_id', 'token', 'pkey'],
    domain: ['xiaoheihe.cn', 'max-c.com'],
  },
  bilibili: {
    label: 'B 站（只为字幕，读接口无需登录）',
    url: 'https://www.bilibili.com/',
    expect: ['SESSDATA'],
    domain: ['bilibili.com'],
  },
  douyin: {
    label: '抖音',
    url: 'https://www.douyin.com/',
    expect: ['sessionid', 'sessionid_ss', 'ttwid'],
    domain: ['douyin.com'],
  },
};

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// 极简 CDP 客户端（Node 内置 WebSocket）
// ---------------------------------------------------------------------------

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error(`CDP 连接失败：${e?.message ?? 'unknown'}`)));
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const {resolve: res, reject: rej} = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForDevtools(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function cookiesFor(port, domains) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const {webSocketDebuggerUrl} = await res.json();
  const cdp = new Cdp(webSocketDebuggerUrl);
  await cdp.connect();
  const {cookies} = await cdp.send('Network.getAllCookies');
  cdp.close();
  const wanted = cookies.filter((c) => domains.some((d) => c.domain.includes(d)));
  const map = {};
  for (const c of wanted) map[c.name] = c.value;
  return map;
}

function mask(v) {
  const s = String(v ?? '');
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}(len ${s.length})`;
}

// ---------------------------------------------------------------------------

async function login(source, opts) {
  const cfg = SOURCES[source];
  if (!cfg) throw new Error(`未知源：${source}。可选：${Object.keys(SOURCES).join(', ')}`);
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome/Chromium/Edge，请先安装其一，或用 --paste 手工粘贴 cookie');

  const port = 9222 + Math.floor(Math.random() * 200);
  const profile = join(ROOT, '.dsh-sources', 'chrome-profile');
  mkdirSync(profile, {recursive: true});
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    cfg.url,
  ];
  process.stdout.write(`启动 Chrome（独立 profile，不动你日常浏览器）…\n`);
  const child = spawn(chrome, args, {stdio: 'ignore', detached: false});
  const timeoutMs = (Number(opts.timeout) || 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  let saved = null;

  try {
    if (!(await waitForDevtools(port))) throw new Error('Chrome 没起来（DevTools 端口无响应）');
    process.stdout.write(`\n请在刚打开的窗口里登录【${cfg.label}】。\n检测到 ${cfg.expect.join(' / ')} 就会自动保存，最多等 ${timeoutMs / 1000}s。\n`);
    while (Date.now() < deadline) {
      const jar = await cookiesFor(port, cfg.domain);
      const hit = cfg.expect.filter((k) => jar[k]);
      if (hit.length > 0) {
        const path = saveSession(source, jar, {label: cfg.label, detected: hit, source_url: cfg.url});
        saved = {jar, hit, path};
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
      process.stdout.write('.');
    }
    if (!saved) throw new Error(`超时（${timeoutMs / 1000}s）没检测到 ${cfg.expect.join('/')}。可以加大 --timeout，或用 --paste 手工粘贴。`);
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  process.stdout.write(`\n已保存 ${saved.hit.join(', ')} → ${saved.path.replace(ROOT + '/', '')}\n`);
  process.stdout.write(`字段：${Object.keys(saved.jar).join(', ')}\n`);
  return 0;
}

/** 拿一个受保护页面验证会话到底还有没有用——会话会过期，必须能验。 */
async function checkSession(source) {
  const {header, source: from} = cookieFor(source);
  if (!header) return {source, status: 'no_session'};
  if (source === 'tieba') {
    const res = await fetchText('https://tieba.baidu.com/p/11042156380?lp=5028&mo_device=1', {ua: UA.tiebaMobile, cookie: header});
    const wall = /百度安全验证/.test(res.text);
    return {source, cookie_source: from, http_status: res.status, status: wall ? 'expired_or_blocked' : 'valid', bytes: res.bytes};
  }
  if (source === 'nga') {
    const res = await fetchText('https://ngabbs.com/', {ua: UA.desktop, cookie: header});
    return {source, cookie_source: from, http_status: res.status, status: res.status === 200 ? 'valid' : 'expired_or_blocked', bytes: res.bytes};
  }
  if (source === 'xiaohongshu') {
    const res = await fetchText('https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo', {
      ua: UA.desktop,
      cookie: header,
      headers: {referer: 'https://www.xiaohongshu.com/'},
    });
    let ok = false;
    try {
      ok = JSON.parse(res.text)?.success === true;
    } catch {
      /* ignore */
    }
    return {source, cookie_source: from, http_status: res.status, status: ok ? 'valid' : 'expired_or_blocked'};
  }
  if (source === 'bilibili') {
    const res = await fetchText('https://api.bilibili.com/x/web-interface/nav', {ua: UA.bili, cookie: header});
    let name = null;
    try {
      const j = JSON.parse(res.text);
      name = j?.data?.uname ?? null;
    } catch {
      /* ignore */
    }
    return {source, cookie_source: from, http_status: res.status, status: name ? 'valid' : 'expired_or_blocked', user: name};
  }
  return {source, cookie_source: from, status: 'no_checker'};
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const [cmd, arg] = opts._;

  if (opts.list || (!cmd && !opts.show && !opts.paste && !opts.check)) {
    printHelp([
      '登录助手——把「需要登录的社区源」变成一次性操作。',
      '',
      `可用源：${Object.entries(SOURCES).map(([k, v]) => `${k}(${v.label})`).join('  ')}`,
      '',
      '用法：',
      '  login-helper.mjs <源> [--timeout 600]     # 开 Chrome，扫码登录后自动存 cookie',
      '  login-helper.mjs --show <源>              # 看已存会话（值遮罩）',
      '  login-helper.mjs --paste <源> \'k=v; k=v\'  # 手工粘贴（不想开浏览器时）',
      '  login-helper.mjs --check                  # 逐个验证已存会话是否过期',
      '',
      `会话文件：${SESSION_FILE.replace(ROOT + '/', '')}（不要提交）`,
    ]);
    return cmd ? 2 : 0;
  }

  if (opts.show) {
    const all = loadSessions();
    const s = all[opts.show];
    if (!s) {
      process.stdout.write(`${opts.show}: 无会话\n`);
      return 1;
    }
    process.stdout.write(`${opts.show}  (${s.saved_at ?? '?'})\n`);
    for (const [k, v] of Object.entries(s.cookies ?? {})) process.stdout.write(`  ${k} = ${mask(v)}\n`);
    if (s.cookie) process.stdout.write(`  (整串) ${mask(s.cookie)}\n`);
    return 0;
  }

  if (opts.paste) {
    // 两种写法都收： `--paste tieba 'k=v; k=v'`（源在 flag 后面）
    //            和 `--paste 'tieba k=v; k=v'`（shell 没加引号被拼成一串）
    const raw = String(opts.paste);
    const src = SOURCES[raw.split(/\s+/)[0]] ? raw.split(/\s+/)[0] : arg;
    if (!src || !SOURCES[src]) throw new Error(`未知源：${src ?? '(缺)'}。可选：${Object.keys(SOURCES).join(', ')}`);
    const cookie = (SOURCES[raw.split(/\s+/)[0]] ? raw.slice(src.length) : String(arg ?? '')).trim();
    if (!cookie) throw new Error("用法：--paste <源> 'k=v; k=v'");
    const jar = Object.fromEntries(
      cookie
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
        }),
    );
    const path = saveSession(src, jar, {label: SOURCES[src]?.label ?? src, detected: ['(pasted)']});
    process.stdout.write(`已保存 → ${path.replace(ROOT + '/', '')}\n`);
    return 0;
  }

  if (opts.check) {
    const all = loadSessions();
    const keys = Object.keys(all);
    if (keys.length === 0) {
      process.stdout.write('没有任何已存会话。先跑 login-helper.mjs <源>。\n');
      return 1;
    }
    const rows = [];
    for (const k of keys) rows.push(await checkSession(k));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return rows.every((r) => r.status === 'valid') ? 0 : 1;
  }

  return login(cmd, opts);
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`login-helper 失败：${e?.message ?? e}\n`);
    process.exit(1);
  });
