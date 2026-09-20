// 浏览器资源路径契约（结构重构的护栏）
//
// 为什么需要它：结构性移动会同时改变 import 说明符和服务器读取的磁盘路径，
// 一处弄错，页面就白屏——而白屏是最难从测试输出里看出来的故障
// （几百项测试可能全绿，浏览器里一行 JS 都不执行）。
// 这条契约把「路径是否自洽」变成会大声失败的断言。
//
// 仓库布局（重构后）：
//   src/client/  页面入口与静态资源（index.html / app.js / *.css）
//   src/game/    游戏内核（engine / content / progression / rules）
//   src/coach/   教练浏览器侧模块
//   src/server/  Node 服务入口与其 helpers
//   tests/       测试；tests/evals/ 是评测与数据域测试
//
// 关于 URL：server.js 把 **URL 路径直接当仓库相对路径**读文件，
// 所以浏览器按 import 说明符解析出的 URL 与白名单条目、与磁盘路径同构。
// 页面 URL 是例外，见 server.js 的 PAGE_ALIASES：/ 、/index.html 、/connect.html
// 三个短路径是对外契约（文档与用户书签都写着它们），必须一直可用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const ENTRY = 'src/client/app.js';
const PAGE = 'src/client/index.html';

/** 从 index.html 里取出本地脚本/样式引用 */
function localAssetsFromHtml() {
  const html = readFileSync(join(ROOT, PAGE), 'utf8');
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const url = m[1];
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:') || url.startsWith('#')) continue;
    if (/\.(js|mjs|css)$/.test(url)) out.add(url.replace(/^\.\//, '').replace(/^\//, ''));
  }
  return [...out];
}

/** 从入口出发沿 import 图推导浏览器模块集合（与 server.js 的 browserModules 同语义） */
function browserModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) continue;
      queue.push(relative(ROOT, resolve(dirname(join(ROOT, rel)), m[1])).replace(/\\/g, '/'));
    }
  }
  return seen;
}

test('结构契约：index.html 引用的每个本地模块都真实存在', () => {
  const assets = localAssetsFromHtml();
  assert.ok(assets.length > 0, 'index.html 应当引用本地模块');
  for (const a of assets) {
    assert.ok(existsSync(join(ROOT, a)), `index.html 引用了 ${a}，但仓库里没有这个文件`);
  }
  assert.ok(assets.includes(ENTRY),
    `index.html 的 JS 入口应当是 ${ENTRY}，实际 ${assets.filter((x) => x.endsWith('.js'))}`);
});

test('结构契约：入口模块图里每个相对 import 都解析到真实文件', () => {
  const mods = browserModules(ENTRY);
  assert.ok(mods.size >= 8, `模块图应当有一定规模，实际 ${mods.size}`);
  for (const rel of mods) {
    assert.ok(existsSync(join(ROOT, rel)), `模块图里的 ${rel} 在磁盘上不存在`);
  }
});

test('结构契约：全仓 js/mjs 的相对 import 都指向真实文件', () => {
  const files = git(['ls-files', '*.js', '*.mjs']).split('\n').filter(Boolean);
  const bad = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      const target = resolve(dirname(join(ROOT, f)), spec);
      const ok = existsSync(target) || existsSync(`${target}.js`) || existsSync(`${target}.mjs`) || existsSync(join(target, 'index.js'));
      if (!ok) bad.push(`${f} -> ${spec}`);
    }
  }
  assert.deepEqual(bad, [], `有 import 指向不存在的文件：\n${bad.join('\n')}`);
});

test('结构契约：src/ tests/ tools/ 下的每个文件都被 git 跟踪', () => {
  // 同时接受「已提交」与「已 add 但还没提交」：重构过程中会短暂处于后者。
  // 真正要拦的是「磁盘上有、但 git 永远看不到」——那说明被 .gitignore 吞了，或者忘了 add。
  const tracked = new Set([
    ...git(['ls-files']).split('\n'),
    ...git(['diff', '--cached', '--name-only']).split('\n'),
  ]);
  const stray = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = relative(ROOT, p).replace(/\\/g, '/');
        if (!tracked.has(rel)) stray.push(rel);
      }
    }
  };
  for (const d of ['src', 'tests', 'tools']) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  assert.deepEqual(stray, [], `src/ tests/ tools/ 下有未被 git 跟踪的文件：\n${stray.join('\n')}`);
});

test('结构契约：仓库顶层只允许约定俗成的目录与文件', () => {
  const allowedDirs = new Set(['src', 'tests', 'tools', 'scripts', 'docs', 'data', 'knowledge',
    'reports', 'report', 'output', 'checkpoints', 'training']);
  // 顶层只允许这些文件。注意：文档一律进 docs/，
  // 所以这里**没有** COACH-ACCEPTANCE.md / DEEPSEEK.md / coach-design-notes.md 等文档（它们都在 docs/）。
  // 曾经允许过它们，结果它们就真的留在根目录了——允许清单必须等于实际想要的形态。
  const allowedFiles = new Set(['.gitignore', 'package.json', 'README.md',
    'requirements-agent.lock.txt']);
  const entries = readdirSync(join(ROOT), { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'tmp');
  const unexpected = [];
  for (const e of entries) {
    if (e.isDirectory()) { if (!allowedDirs.has(e.name)) unexpected.push(`${e.name}/`); }
    else if (!allowedFiles.has(e.name)) unexpected.push(e.name);
  }
  assert.deepEqual(unexpected, [],
    `仓库顶层出现了未登记的条目。要么把它归入 src/tests/tools，要么加进这条测试的允许清单并说明理由：\n${unexpected.join('\n')}`);
});

test('结构契约：URL 空间与磁盘空间同构，页面短路径可用', async () => {
  const { createCoachServer } = await import('../../src/server/index.js');
  const server = createCoachServer({ semantic: false, fetchImpl: async () => { throw Error('测试环境不允许联网'); } });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    // ① 模块图里每个模块都必须取得到（这正是「白名单或路径拼接写错」的症状）
    const problems = [];
    for (const rel of browserModules(ENTRY)) {
      const r = await fetch(base + rel);
      if (r.status !== 200) problems.push(`${rel} -> HTTP ${r.status}`);
    }
    assert.deepEqual(problems, [], `从 HTTP 拿不到的浏览器模块：\n${problems.join('\n')}`);

    // ② 页面短路径是对外契约
    for (const p of ['', 'index.html', 'connect.html']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `页面路径 /${p} 应当可用，实际 ${r.status}`);
    }

    // ③ 白名单是唯一边界：非白名单文件（含目录穿越尝试）一律取不到
    for (const bad of ['package.json', 'src/server/index.js', '../package.json', 'src/../../package.json', '.git/config']) {
      const r = await fetch(base + bad);
      assert.equal(r.status, 404, `${bad} 不在白名单里，应当 404，实际 ${r.status}`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
