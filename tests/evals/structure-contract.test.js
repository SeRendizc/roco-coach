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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// 服务器导出的资源白名单与模块图：契约测试直接核对**服务器认定的事实**，
// 而不是自己再算一遍（各自算一遍就会各自漂，白屏那次就是这么漏过去的）。
import {publicAssets, browserModules as serverBrowserModules, moduleSpecifiers} from '../../src/server/index.js';

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

// ── Coach 核心的「不读 DOM、不依赖页面」契约 ─────────────────────────────────
//
// 人类这轮的硬要求：「Coach 核心必须只消费这份契约，绝不读 DOM 细节，也绝不读隐藏的
// 对手状态」。隐藏信息那一半已经有真判据（game-adapter.js 的 FOE_BENCH_FIELDS 白名单
// + tests/evals/roco/game-adapter.test.js 里的 hidden_field_leaked 反证）；DOM 这一半
// 在这之前**只有注释**（game-adapter.js 第 18-19 行）和「它能在 Node 里跑起来」这个间接
// 证据：有人往核心里加一行 `document.title`、或者静态 import 一次 `node:fs`，
// 全仓没有任何一条测试会红。下面四条（两条判据 + 各自的反证）把它变成会大声失败的断言。
//
// 口径（必须写清楚，否则这条守卫会被读成「整个 src/coach 都干净」——那是不对的）：
//   · 核心入口：`src/coach/game-adapter.js`（游戏适配契约核心）
//             + `src/coach/compare-model.js`（并列比较模型）。
//   · 核心图：从这两个入口出发，沿**静态** import / `export … from` 边递归可达的模块
//     （现在 15 个：12 个 src/coach/** + 3 个 src/game/**）。动态 `import()` 不算依赖边
//     （理由见上面「浏览器模块图里不许 node:*」那条的注释：浏览器根本不执行它）。
//   · DOM 扫描只扫**核心图 ∩ src/coach/**（现在 12 个文件），而且核心图在 DOM 扫描
//     这条里**不展开页面层**（见 COACH_CORE_DESCEND）：
//       - `src/game/**` 在核心图上，但它是游戏内核、不是 Coach 核心，所以不进 DOM 扫描
//         （它的 node:*/页面层依赖由核心图那条规则覆盖）；
//       - `src/coach/**` 里**不在**核心图上的 10 个模块（client.js / companion.js /
//         local-model.js / retrieval.js / roco-client.js / runtime.js / scheduler.js /
//         session.js / shadow-tools.js / toolbox.js）明确**不在口径内**：它们在浏览器侧跑，
//         允许碰 DOM。
//     这条守卫声明的是「核心图干净」，**不是**「整个 src/coach 干净」。
//     这不是假想的例外：`companion.js` 里就有一个叫 `window` 的局部变量（时间窗口），
//     照字面扫会当场误报——所以那条规则还必须排除「本文件自己声明过的同名标识符」。

/** Node 内置模块判定：`node:*` 前缀，或裸内置名。浏览器图与核心图两条守卫共用一份清单。 */
const NODE_BUILTINS = ['fs', 'path', 'url', 'child_process', 'crypto', 'os'];
const isNodeSpecifier = (spec) => spec.startsWith('node:') || NODE_BUILTINS.includes(spec);

/**
 * 静态依赖说明符：`import … from 'x'`、`import 'x'`、`export … from 'x'` 三种。
 *
 * 刻意**不**匹配动态 `import('x')`：它在浏览器里不会执行，也不会让模块解析失败。
 * 仓库里的活样例是 intervention-model.js 第 98 行——那处 `import('node:fs')` 就在**行首**，
 * 所以「行首的 import 就是静态 import」这个直觉是错的。正则要求 `import` 后面跟**空白**，
 * 因此 `import(` 与 `import (` 都不会被当成依赖边。
 */
function staticDependencies(src) {
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)[ \t]*import\s+(?!\()(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)[ \t]*export\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** 把相对说明符解析成仓库相对路径；解析不到真实文件时返回 null（null 就是「核心图有洞」）。 */
function resolveRelative(fromRel, spec) {
  const target = resolve(dirname(join(ROOT, fromRel)), spec);
  const hit = [target, `${target}.js`, `${target}.mjs`, join(target, 'index.js')].find((p) => existsSync(p));
  return hit ? relative(ROOT, hit).replace(/\\/g, '/') : null;
}

const CORE_ENTRIES = ['src/coach/game-adapter.js', 'src/coach/compare-model.js'];
const CORE_SCOPE_PREFIX = 'src/coach/';

/** 核心静态 import 图（仓库相对路径的集合）。
 *
 *  `descend` 决定「哪些模块可以继续展开」。DOM 扫描用
 *  `descend: COACH_CORE_DESCEND`（页面层只记录、不展开），理由见下面那条
 *  `COACH_CORE_DESCEND` 的注释。
 */
function coreGraph(entries = CORE_ENTRIES, {descend = () => true} = {}) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!descend(rel)) continue;
    let src;
    try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const spec of staticDependencies(src)) {
      if (!spec.startsWith('.')) continue;   // node:*/裸模块不是文件依赖，由 isNodeSpecifier 单独判
      queue.push(resolveRelative(rel, spec)
        || relative(ROOT, resolve(dirname(join(ROOT, rel)), spec)).replace(/\\/g, '/'));
    }
  }
  return seen;
}

/**
 * DOM 扫描的口径开关：页面层模块**只记录、不展开**。
 *
 * 为什么需要它：核心一旦（违规地）伸进页面层，页面模块会直接 import 页面侧的 coach——
 * `src/client/roco.js` 就 import 了 `src/coach/companion.js`——于是「核心」的口径会被
 * companion.js 这类**允许碰 DOM** 的浏览器代码污染，报出来的命中全是噪声。
 * 挡住展开，DOM 扫描的范围就永远是那 12 个核心文件，与「页面层违规」这件事分开报。
 */
const COACH_CORE_DESCEND = (rel) => !rel.startsWith('src/client/');

/** 相对依赖是否落到页面层。单独拿出来是为了让反证能直接调用**规则本身**，而不是抄一份。 */
function pageLayerDependency(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const target = resolveRelative(fromRel, spec);
  return target && target.startsWith('src/client/') ? target : null;
}

/** 被点名的浏览器全局。用标识符而不是裸词：`myWindow`、`obj.fetch` 都不算「使用全局」。 */
const BROWSER_GLOBAL_NAMES = ['document', 'window', 'localStorage', 'navigator', 'fetch', 'XMLHttpRequest'];

/**
 * 代码里对浏览器全局的**真实使用**（返回 match，带 index，便于报行号）。
 *
 * 除了「前面不是 `.`/标识符字符」之外，还要排掉三类**不是读全局**的写法：
 *   ① 本文件自己声明过同名 → 整个文件都不算「读全局」。`src/coach/companion.js` 里真的
 *      有一个叫 `window` 的**局部变量**（时间窗口：`const window=rows.slice(-4)`），
 *      它跟浏览器全局毫无关系；
 *   ② 对象字面量的**键**与解构重命名（`{window: run}`、`const {window: w} = x`）——
 *      这个仓库真的用 `window` 当数据键名；
 *   ③ `obj.fetch`（前面是 `.`）与 `myWindow`（标识符的一部分）。
 * ①是刻意保守的：宁可漏掉一次「同名遮蔽之后的真实读取」，也不误伤合法代码。
 * 残留缺口（都是偏严方向，当前仓库没有这种写法）：只通过**形参**引入的同名绑定、
 * 类成员名、标签名，排除不掉。
 */
function browserGlobalUses(code) {
  const locals = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
  const re = new RegExp(`(?<![.\\w$])(${BROWSER_GLOBAL_NAMES.join('|')})\\b`, 'g');
  const hits = [];
  for (const m of code.matchAll(re)) {
    if (locals.has(m[1])) continue;
    let before = '';
    for (let k = m.index - 1; k >= 0; k -= 1) { if (!/\s/.test(code[k])) { before = code[k]; break; } }
    const after = code.slice(m.index + m[1].length);
    if ((before === '{' || before === ',') && /^\s*:/.test(after)) continue;   // 对象键/解构重命名
    hits.push(m);
  }
  return hits;
}

/**
 * 剥掉注释与字符串字面量，只留下**代码**；换行数保持原样，所以报出来的行号对得上。
 *
 * 为什么不能直接拿全文正则扫：仓库里已经有三处「词在、但不是读 DOM」的写法，
 * 直接扫会误报——
 *   ① 注释：roco-experience.js 第 12 行就写着「这一层是纯函数：没有 DOM、没有 fetch」，
 *      game-adapter.js 第 18-19 行同理；
 *   ② 数据字符串：experience.js 第 159 行的 `'window-unfocused'` 是个**状态名**，
 *      src/game/content.js 里还有 JSON 数据 `"tactic:cleanse-window"`；
 *   ③ 属性名：`obj.fetch(…)` 里的 `fetch` 不是全局（由负向 lookbehind 排掉）。
 * 所以先剥注释、再剥字符串，最后在剩下的代码里按**标识符**扫。
 *
 * 两处刻意保留：
 *   · 模板字面量里 `${…}` 是**真的表达式**（`` `t=${document.title}` `` 确实读了 DOM），
 *     所以只丢模板的文本段，`${…}` 里的代码照扫；
 *   · 正则字面量整段丢掉。不处理 `[…]` 字符类与 `\/` 转义的话，experience.js 第 47 行的
 *     `/[&<>"']/g` 会被当成「一个字符串的开头」，把后面半行**真实代码**一起吃掉——
 *     那是静默失效，比误报更坏。`/` 是正则还是除号靠前一个非空白字符/关键字猜
 *     （`( , = : [ ! & | ? { } ; + - * % ~ ^ < >` 与 return/typeof/… 之后是正则）。
 *     这是启发式：零依赖就没法完全判准，所以下面留了「行数不变 + 剥后不能太短」两条自检。
 */
function stripCommentsAndStrings(src, {keepStrings = false} = {}) {
  const REGEX_PREFIX_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
    '+', '-', '*', '%', '~', '^', '<', '>']);
  const REGEX_PREFIX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'case', 'do', 'else', 'yield', 'await', 'throw']);
  const out = [];
  const keepLines = (text) => '\n'.repeat((text.match(/\n/g) || []).length);
  const skipSpaces = (from) => {
    let k = from;
    while (k >= 0 && /^\s+$/.test(out[k])) k -= 1;
    return k;
  };
  const stack = [{mode: 'code', braces: 0}];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top.mode === 'template') {                       // 模板字面量的文本段：丢掉，但保留换行
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; out.push(' '); continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({mode: 'code', braces: 1}); i += 2; out.push(' '); continue; }
      i += 1; continue;
    }
    if (c === '/' && src[i + 1] === '/') {               // 行注释
      const start = i;
      while (i < src.length && src[i] !== '\n') i += 1;
      out.push(' ' + keepLines(src.slice(start, i)));
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {               // 块注释
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out.push(' ' + keepLines(src.slice(start, i)));
      continue;
    }
    if (c === '"' || c === "'") {                        // 普通字符串
      const start = i;
      i += 1;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      // `keepStrings`：扫相对 import 那条规则要用它 —— **说明符本身就是字符串**，
      // 把字符串剥掉就等于把要查的东西一起丢掉。默认仍然是丢掉（DOM 那条规则要的是代码）。
      out.push(keepStrings ? src.slice(start, i) : ' ' + keepLines(src.slice(start, i)));
      continue;
    }
    if (c === '`') { stack.push({mode: 'template'}); i += 1; out.push(' '); continue; }
    if (c === '/') {                                     // 正则字面量 vs 除号
      const last = skipSpaces(out.length - 1);
      let word = '';
      for (let k = last; k >= 0 && word.length < 16; k -= 1) {
        if (/^[A-Za-z0-9_$]+$/.test(out[k])) word = out[k] + word; else break;
      }
      if (REGEX_PREFIX_CHARS.has(last < 0 ? '' : out[last]) || REGEX_PREFIX_WORDS.has(word)) {
        i += 1;
        let inClass = false;
        while (i < src.length) {
          const ch = src[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '\n') break;
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { i += 1; break; }
          i += 1;
        }
        while (i < src.length && /[dgimsuvy]/.test(src[i])) i += 1;
        out.push(' ');
        continue;
      }
      out.push(c); i += 1; continue;
    }
    if (c === '{' && stack.length > 1) top.braces += 1;
    if (c === '}' && stack.length > 1) {
      top.braces -= 1;
      if (top.braces === 0) { stack.pop(); i += 1; out.push(' '); continue; }
    }
    out.push(c); i += 1;
  }
  return out.join('');
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

test('结构契约：浏览器模块图里不许出现 node:*（静态 import）', () => {
  // 这条是第 24 轮那次事故的守卫。那次 `experience.js` 接到一个顶层
  // `import {readFileSync} from 'node:fs'` 的模块上，浏览器解不出 `node:*`，
  // 整条 import 链**静默**断掉：标题与按钮都在，但开不了局。
  // `test:unit` 全绿（Node 里 node:fs 存在），浏览器验收从 9/9 掉到 3/9。
  //
  // 这里把「不许在浏览器图里静态 import node:*」变成结构契约：
  // 未来任何人再引入一次，这里直接红，而不是等浏览器验收才发现。
  //
  // 允许**动态** import（`await import('node:fs')`）：它在浏览器里根本不会被执行，
  // 也不会让模块解析失败。所以只扫静态 import 语句。
  // 覆盖**每一个页面**的模块图，而不是只有主入口：
  // `/roco.html` 是另一条入口（第 22 轮那次事故就是它整页白屏）。
  const entries = [...new Set([ENTRY, ...[...serverBrowserModules()].filter((x) => x.endsWith('.js'))])];
  const offenders = [];
  const checked = new Set();
  for (const entry of entries) {
    for (const rel of browserModules(entry)) {
      if (checked.has(rel)) continue;
      checked.add(rel);
      let src;
      try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
        if (isNodeSpecifier(m[1])) {
          offenders.push(`${rel} 静态 import 了 ${m[1]}`);
        }
      }
    }
  }
  assert.ok(checked.size >= 8, `扫到的模块太少（${checked.size}），守卫可能失效`);
  assert.deepEqual(offenders, [],
    `浏览器模块图里出现了 Node 内置模块（会让页面静默开不了局）：\n${offenders.join('\n')}`);
});

test('反证：扫描逻辑真的能抓到静态 node:*（否则上面的守卫是空的）', () => {
  // 直接对扫描逻辑做对照：同一段代码，一个含违规、一个不含。
  const scan = (src) => [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter(isNodeSpecifier);
  assert.deepEqual(scan("import {readFileSync} from 'node:fs';\n"), ['node:fs'], '静态 node:fs 必须被抓到');
  assert.deepEqual(scan("import {join} from 'node:path';\n"), ['node:path']);
  assert.deepEqual(scan("import './x.js';\n"), [], '相对 import 不算违规');
  // 动态 import 是允许的：浏览器根本不会执行它，也不会解析失败
  assert.deepEqual(scan("const fs = await import('node:fs');\n"), [], '动态 import 不算违规');
  // 现在仓库里**已经**有一处动态 import node:fs（intervention-model.js），
  // 它必须不被抓——否则这次守卫会把正确写法判成违规。
  const live = readFileSync(join(ROOT, 'src/coach/intervention-model.js'), 'utf8');
  assert.deepEqual(scan(live), [], 'intervention-model.js 用的是动态 import，不该被判违规');
  assert.match(live, /await Promise\.all\(\[\s*import\('node:fs'\)/, '它应当仍然是动态 import');
});

test('结构契约：Coach 核心的静态 import 图到不了页面层，也不出现 node:*', () => {
  // 上面那条守卫只覆盖**浏览器模块图**（server.js 认为会被页面加载的那些模块）。
  // `src/coach/game-adapter.js` **不在**那份图里（全仓只有测试与脚本 import 它），
  // 所以「核心绑上 node:* 或者反向依赖页面层」这个方向此前完全没有判据。
  const graph = coreGraph();
  assert.ok(graph.size >= 10, `核心图只扫到 ${graph.size} 个模块，扫描逻辑可能坏了`);
  assert.ok([...graph].some((rel) => rel.startsWith(CORE_SCOPE_PREFIX)), '核心图里应当至少有 coach 模块');
  // 图必须是**闭包**：图上每个模块的相对依赖也在图上。
  // 少了这一条，「到不了页面层」有可能只是因为走得不深（守卫装作通过）。
  for (const rel of graph) {
    for (const spec of staticDependencies(readFileSync(join(ROOT, rel), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = resolveRelative(rel, spec);
      assert.ok(target, `${rel} 的依赖 ${spec} 解析不到真实文件——核心图有洞，守卫会漏`);
      assert.ok(graph.has(target), `${rel} 的依赖 ${spec} 不在核心图上——图没走到底，守卫会漏`);
    }
  }
  const offenders = [];
  for (const rel of graph) {
    for (const spec of staticDependencies(readFileSync(join(ROOT, rel), 'utf8'))) {
      if (isNodeSpecifier(spec)) offenders.push(`${rel} 静态依赖了 Node 内置模块 ${spec}`);
      const page = pageLayerDependency(rel, spec);
      if (page) offenders.push(`${rel} 静态依赖了页面层 ${page}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Coach 核心图里出现了页面层或 Node 依赖（核心只吃契约，能力由宿主显式注入）：\n${offenders.join('\n')}`);
});

test('反证：核心图这条判据不是空的（node:* / 页面层 / 动态 import 三种对照）', () => {
  assert.deepEqual(staticDependencies("import {readFileSync as f} from 'node:fs';\n"), ['node:fs']);
  assert.equal(isNodeSpecifier('node:fs'), true);
  assert.equal(isNodeSpecifier('fs'), true, '裸内置名同样算 Node 依赖');
  assert.equal(isNodeSpecifier('./x.js'), false);
  // 动态 import 不是依赖边：它不进浏览器 import 图，浏览器也不会执行它
  assert.deepEqual(staticDependencies("const fs = await import('node:fs');\n"), []);
  assert.deepEqual(staticDependencies("await Promise.all([\n  import('node:fs'),\n]);\n"), [],
    '行首的 import(…) 是动态 import，不是静态依赖');
  // 活证据：intervention-model.js 里真有一处**行首**的 import('node:fs')，它必须不被抓
  const live = readFileSync(join(ROOT, 'src/coach/intervention-model.js'), 'utf8');
  assert.match(live, /^\s*import\('node:fs'\)/m, '反证前提：那处行首的动态 import 还在');
  assert.deepEqual(staticDependencies(live).filter(isNodeSpecifier), [],
    'intervention-model.js 用的是动态 import，不该被判成依赖边');
  // `export … from` 也是依赖边，否则一条 re-export 就能把页面层偷偷接进核心。
  // 说明符刻意用变量拼出来：上面那条「全仓相对 import 都指向真实文件」的规则会扫
  // **这个测试文件自己的文本**——直写一条相对 import 会造出一个指向不存在文件的假
  // import（guard-selftest.mjs 的 browser-node-import 条目踩过同一个坑）。
  const reExportTarget = './page.js';
  assert.deepEqual(staticDependencies(`export {x} from '${reExportTarget}';\n`), [reExportTarget]);
  // 页面层判定看的是**解析后的路径**，所以 `'../client/roco.js'` 这种真实写法跑不掉。
  // （coach-advice.test.js 里那条同题检查只看说明符文本里有没有 `src/client`，这条写法它抓不到。）
  assert.equal(pageLayerDependency('src/coach/compare-model.js', '../client/roco.js'), 'src/client/roco.js');
  assert.equal(pageLayerDependency('src/coach/compare-model.js', '../game/engine.js'), null);
  // 换一个入口，图必须跟着变：否则 coreGraph 可能忽略了参数、永远返回同一份结果
  assert.ok(coreGraph(['src/client/app.js']).size > coreGraph().size,
    '从页面入口出发的核心图应当更大（入口参数没生效？）');
  // 「页面层只记录、不展开」不是装饰：`src/client/roco.js` **直接** import 了页面侧的
  // `src/coach/companion.js`——那是允许碰 DOM 的浏览器代码。不带旗时它会被拉进「核心」口径
  // （核心一旦违规伸进页面层，DOM 扫描的命中就会全是它的噪声）；带旗时它进不来。
  const viaPage = coreGraph(['src/client/roco.js']);
  assert.ok(viaPage.has('src/coach/companion.js'), '前提：页面入口确实会拉到页面侧的 coach 模块');
  assert.deepEqual([...coreGraph(['src/client/roco.js'], {descend: COACH_CORE_DESCEND})],
    ['src/client/roco.js'], '页面层只该被记录、不该被展开（否则 DOM 扫描口径会被污染）');
});

test('结构契约：核心图的 src/coach/** 不读浏览器全局（剥注释与字符串后按标识符扫）', () => {
  const scope = [...coreGraph(CORE_ENTRIES, {descend: COACH_CORE_DESCEND})]
    .filter((rel) => rel.startsWith(CORE_SCOPE_PREFIX));
  assert.ok(scope.length >= 8, `DOM 扫描范围只有 ${scope.length} 个文件，守卫可能失效`);
  const hits = [];
  let strippedTotal = 0;
  let sourceTotal = 0;
  for (const rel of scope) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const code = stripCommentsAndStrings(source);
    // 剥注释/字符串时**行数必须原样**，否则报出来的行号是假的
    assert.equal(code.split('\n').length, source.split('\n').length, `${rel} 剥注释后行数变了，剥壳逻辑坏了`);
    strippedTotal += code.length;
    sourceTotal += source.length;
    for (const m of browserGlobalUses(code)) {
      hits.push(`${rel}:${code.slice(0, m.index).split('\n').length} 使用了 ${m[1]}`);
    }
  }
  // 剥得太狠 = 把真实代码也吃掉了（守卫会因此静默失效），所以留一条下限
  assert.ok(strippedTotal / sourceTotal > 0.3,
    `剥注释/字符串后只剩 ${(strippedTotal / sourceTotal).toFixed(2)} 的代码，剥壳逻辑可能吃掉真实代码`);
  assert.deepEqual(hits, [],
    `Coach 核心读了浏览器全局（核心只消费契约，DOM 与全局由宿主显式注入）：\n${hits.join('\n')}`);
});

test('反证：浏览器全局这条判据不是空的（真使用会红、注释/字符串/属性名不会）', () => {
  const scan = (text) => browserGlobalUses(stripCommentsAndStrings(text)).map((m) => m[1]);
  // ① 清单里六个名字逐个正控：任何一个抓不到，这条守卫就是空的
  for (const name of BROWSER_GLOBAL_NAMES) {
    assert.deepEqual(scan(`const x = ${name};`), [name], `${name} 必须能被抓到`);
  }
  assert.deepEqual(scan('const t = document.title;'), ['document']);
  assert.deepEqual(scan('window.addEventListener("x", f);'), ['window']);
  assert.deepEqual(scan('await fetch("/api/roco/plan");'), ['fetch']);
  assert.deepEqual(scan('const ua = navigator.userAgent;'), ['navigator']);
  assert.deepEqual(scan("localStorage.getItem('k');"), ['localStorage']);
  assert.deepEqual(scan('const req = new XMLHttpRequest();'), ['XMLHttpRequest']);
  // ② 注释不算（否则 roco-experience.js 第 12 行那句「没有 DOM、没有 fetch」就会误报）
  assert.deepEqual(scan('// 这一层没有 DOM、没有 fetch\n'), []);
  assert.deepEqual(scan('/* document.hidden 由宿主判断 */\n'), []);
  // ③ 字符串不算：experience.js 真有一个叫 'window-unfocused' 的状态名
  assert.deepEqual(scan("const reason = 'window-unfocused';"), []);
  assert.deepEqual(scan("const url = 'http://h/p';"), [], '字符串里的 // 不是注释，不能把后半行吃掉');
  // ④ 但模板字面量里的 ${…} 是表达式，必须照抓
  assert.deepEqual(scan('const t = `标题=${document.title}`;'), ['document']);
  // ⑤ 属性名不算（obj.fetch 不是全局 fetch）
  assert.deepEqual(scan('obj.fetch(1);'), []);
  // ⑥ 正则字面量整段丢掉：experience.js 第 47 行真的有 /[&<>"']/g 这种写法，
  //    不处理字符类就会把一个字符串的开头认错、把半行真实代码吃掉（静默失效）
  assert.deepEqual(scan(`const safe=String(t).replace(/[&<>"']/g,c=>({'&':'&amp;'}[c]));`), []);
  assert.deepEqual(scan('const r = /window/.test(s);'), [], '正则里的词不算使用');
  assert.deepEqual(scan('const q = a/b/c;'), [], '除号不是正则，也不能吃掉后面的代码');
  // ⑦ 同名**局部变量**不算读全局——这不是假想的例外：companion.js 真的把时间窗口叫 `window`
  assert.deepEqual(scan('const window = rows.slice(-4); const series = window.map((r) => r.dealt);'), []);
  assert.deepEqual(scan('out.dry = {pet: p, window: run};'), [], '对象字面量的键不是读全局');
  assert.deepEqual(scan('const {window: w} = x;'), [], '解构重命名里的 window 是属性名');
  assert.deepEqual(scan('const t = flag ? window : null;'), ['window'], '三元里的 window 仍然是读全局');
  assert.deepEqual(scan('f(a, window);'), ['window'], '实参位置仍然是读全局');
  assert.deepEqual(scan('function f(){ const document = fakeDoc; return document.title; }'), [],
    '本文件自己声明过同名 → 整个文件都不算读全局（刻意偏保守：宁漏一次遮蔽后的读取，不误伤合法代码）');
  const companion = readFileSync(join(ROOT, 'src/coach/companion.js'), 'utf8');
  assert.match(companion, /const window=rows\.slice\(-4\)/,
    '反证前提：companion.js 里那个叫 window 的局部变量还在');
  assert.deepEqual(scan(companion), [],
    'companion.js 的 window 是局部变量（时间窗口）——照字面扫会当场误报');
  // ⑧ 活证据：核心图里最像违规的那个文件，剥完注释与字符串必须一干二净
  const experience = readFileSync(join(ROOT, 'src/coach/experience.js'), 'utf8');
  assert.match(experience, /'window-unfocused'/, '反证前提：那个状态名还在（否则上面对照失效）');
  assert.match(experience, /document\.hidden/, '反证前提：那句提到 document.hidden 的注释还在');
  assert.match(experience, /\/\[&<>"'\]\/g/, '反证前提：那个带引号的正则字面量还在');
  assert.deepEqual(scan(experience), [],
    "experience.js 里的 'window-unfocused' 是数据字符串、document.hidden 在注释里——都不是读 DOM");
});

test('结构契约：入口模块图里每个相对 import 都解析到真实文件', () => {
  const mods = browserModules(ENTRY);
  assert.ok(mods.size >= 8, `模块图应当有一定规模，实际 ${mods.size}`);
  for (const rel of mods) {
    assert.ok(existsSync(join(ROOT, rel)), `模块图里的 ${rel} 在磁盘上不存在`);
  }
});

/**
 * 要扫的 js/mjs 文件集合 = **已跟踪的 ∪ 还没 `git add` 的**（都不含被忽略的）。
 *
 * 为什么必须并上「未跟踪」这一份（第 65 轮实测到的一类空绿）：
 * `git ls-files` **只看已跟踪的文件**，于是开发期间新写的模块根本不在扫描集合里——
 * 「相对 import 指向真实文件」这条守卫对**新文件从来没生效过**，而门禁照样绿。
 * 活例子：`tests/evals/roco/mock-host/run.mjs` 里有一处 `intervention-model.js?browser-probe`，
 * 它**未跟踪时**扫描集合里没有它（绿），一提交进 HEAD 立刻变成红——
 * 也就是说这条守卫的判定结果取决于「文件提交没提交」，而不是「代码对不对」。
 * `--exclude-standard` 仍然尊重 `.gitignore`，所以数据快照里那些第三方 .js 不会被拖进来。
 */
function jsFiles() {
  const list = (args) => git(args).split('\n').filter(Boolean);
  return [...new Set([
    ...list(['ls-files', '*.js', '*.mjs']),
    ...list(['ls-files', '--others', '--exclude-standard', '*.js', '*.mjs']),
  ])];
}

/**
 * 逐文件核对相对 import 指到真实文件没有。返回坏掉的条目（`文件 -> 说明符`）。
 *
 * 单独抽成函数是为了让**反证**能直接调用规则本身，而不是抄一份实现（抄一份就会漂一份）。
 */
function scanRelativeImports(files) {
  const bad = [];
  // 三种写法都要认：① `from './x.js'`（含 `export … from`）；
  // ② **副作用式静态 import**：`import './x.js'`——它没有 `from`，第一批正则漏了它
  //   （第 65 轮用探针文件实测出来的第二个洞：这种 import 指向不存在的文件也不会红）；
  // ③ 动态 `import('./x.js')`（`?browser-probe` 那种）。
  // `m` 让 `^` 落在每一行行首，这样 `import` 只认行首那一处，不会把 `x.import` 之类算进来。
  const RELATIVE_IMPORT = /from\s+['"](\.[^'"]+)['"]|^[ \t]*import\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gm;
  for (const f of files) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    // **先剥注释、保留字符串**：说明符是字符串，不能剥；但注释里写一句
    // 「例如 `from './x.js'`」不该让这条规则红（第 65 轮自己踩到过：
    // 新加的说明注释里带了一个不存在的示例路径，规则当场把自己判成坏 import）。
    const code = stripCommentsAndStrings(src, {keepStrings: true});
    for (const m of code.matchAll(RELATIVE_IMPORT)) {
      // 说明符允许带查询串/哈希：Node 与浏览器都把 `./x.js?v=1` 解析到**同一个文件**。
      // `tests/evals/roco/mock-host/run.mjs` 就用 `intervention-model.js?browser-probe`
      // 强制重新加载一份模块（绕开模块缓存去做「浏览器里没有 process」的反证）。
      // 核对磁盘路径时必须先把 `?…`/`#…` 去掉，否则一个**合法**写法会被误判成
      // 「指向不存在的文件」——那是零误报原则下的假红（这条规则此前真的误报过）。
      const spec = (m[1] || m[2] || m[3]).split(/[?#]/)[0];
      if (!spec) continue;
      const target = resolve(dirname(join(ROOT, f)), spec);
      const ok = existsSync(target) || existsSync(`${target}.js`) || existsSync(`${target}.mjs`) || existsSync(join(target, 'index.js'));
      if (!ok) bad.push(`${f} -> ${spec}`);
    }
  }
  return bad;
}

test('结构契约：全仓 js/mjs 的相对 import 都指向真实文件', () => {
  const files = jsFiles();
  assert.ok(files.length > 100, `扫描集合太小（${files.length} 个文件）——选文件的逻辑是不是坏了？`);
  assert.deepEqual(scanRelativeImports(files), [], '有 import 指向不存在的文件（见下）');
});

test('反证：还没 `git add` 的新文件也必须被上面那条规则扫到', () => {
  // 这条反证抓的是「选择器」而不是「规则」：规则本身对，但**选不到新文件**时它永远绿。
  // 做法：造一个未跟踪的探针文件，里面写一处指向不存在文件的相对 import，
  // 然后拿**同一个** `jsFiles()` 去扫——探针必须出现在坏条目里。
  // 反证方向：把 `jsFiles()` 改回只取 `ls-files`（不并 `--others`），这条立刻红。
  const probeDir = 'tests/.tmp-structure-probe';
  const probe = `${probeDir}/probe.js`;
  mkdirSync(join(ROOT, probeDir), { recursive: true });
  writeFileSync(join(ROOT, probe), "import './definitely-not-a-real-file-xyz.js';\n");
  try {
    const files = jsFiles();
    assert.ok(files.includes(probe), `未跟踪的新文件必须进扫描集合，实际集合里没有 ${probe}`);
    const bad = scanRelativeImports(files);
    assert.ok(bad.some((row) => row.startsWith(probe)),
      `未跟踪的新文件里的坏 import 必须被扫出来，实际坏条目：${JSON.stringify(bad)}`);
  } finally {
    rmSync(join(ROOT, probeDir), { recursive: true, force: true });
  }
});

test('结构契约：每个 Node 测试文件都必须被某个 npm script 或自检登记表引用', () => {
  // 为什么要有这一条：「孤儿守卫不是守卫」。这个仓库里已经出现过至少五次同形状的事故——
  // 测试写好了、全绿、从来没人跑（`coach-advice.test.js` 14 项、`guard-selftest.test.js` 6 项、
  // `coach-positions.test.js` 10 个真实局面、`model-arm-identity`、`teacher-review`）。
  // 它们绿着，所以没人发现；等到某次改动把它们覆盖的东西弄坏，也没有任何东西会红。
  //
  // 判据（两条来源，都是**真的会去跑**的东西）：
  //   ① `package.json` 的任意 script 里出现这个相对路径（`test:unit` 是显式枚举的）；
  //   ② `scripts/roco/guard-selftest.mjs` 的登记表里出现这个路径（注入自检直接 `node --test` 它）。
  // **不认**文档或注释里的提及——那正是「写了但没跑」的来源。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const scriptText = Object.values(pkg.scripts || {}).join('\n');
  const registry = readFileSync(join(ROOT, 'scripts/roco/guard-selftest.mjs'), 'utf8');
  const isReferenced = (rel) => scriptText.includes(rel) || registry.includes(rel);
  const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(rel);
    return entry.name.endsWith('.test.js') ? [rel] : [];
  });
  const files = walk('tests');
  assert.ok(files.length > 30, `应当扫到几十个测试文件，实际 ${files.length} 个（扫描逻辑坏了？）`);
  const orphans = files.filter((rel) => !isReferenced(rel));
  assert.deepEqual(orphans, [],
    `这些测试文件没有被任何 npm script 或 guard-selftest 登记表跑到（绿着，但永远不会执行）：\n${orphans.join('\n')}`);
  // 反向验证：拿一个不存在的路径走同一个判定，必须被判成「没人跑」——
  // 否则上面那条断言可能只是因为 `isReferenced` 恒为真。
  assert.equal(isReferenced('tests/evals/__不存在__.test.js'), false,
    '判定函数对不存在的路径返回 true，说明它没有真的在比对路径');
  assert.equal(isReferenced('tests/evals/coach-advice.test.js'), true,
    '已知被 test:unit 引用的文件必须判成「有引用」');
});

test('结构契约：src/ tests/ tools/ 下没有会被忽略的源文件', () => {
  // 这条契约的本意是「别把源文件写进被 .gitignore 吞掉的位置」——
  // 例如误用 tmp/ 或 .models/ 的规则，导致文件永远不会被提交。
  //
  // 我第一版把它写成「必须已经被 git 跟踪」，会在**并发新增文件**时假报警：
  // 另一个 agent 刚建了 tests/xxx.test.js 还没 add，这条就红，而文件本身没问题。
  // 现在改成：用 git 自己的判定（尊重 .gitignore）列出「未被忽略、但还没被跟踪」
  // 的文件；这些是**待提交**的，不是错误；只要它们都在 src/tests/tools 里且
  // 不是产物目录，就算通过。真正要拦的是「被 gitignore 吞掉」。
  const untracked = git(['ls-files', '--others', '--exclude-standard',
                         'src', 'tests', 'tools']).split('\n').filter(Boolean);
  const tracked = new Set([...git(['ls-files']).split('\n'),
                           ...git(['diff', '--cached', '--name-only']).split('\n')]);
  // 会被忽略的：用 check-ignore 判定，不靠猜
  const ignoredInSource = untracked.filter((rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(ignoredInSource, [],
    `src/ tests/ tools/ 下有被 .gitignore 吞掉的源文件（它们永远不会被提交）：\n${ignoredInSource.join('\n')}`);
  // 待提交的文件必须是常规源码后缀，不是产物
  const suspicious = untracked.filter((rel) => /\.(log|tmp|bak|orig)$|\.DS_Store$/.test(rel));
  assert.deepEqual(suspicious, [],
    `src/ tests/ tools/ 下出现了疑似产物的文件：\n${suspicious.join('\n')}`);
  // 已跟踪集合非空（反向验证：这条测试确实在读 git）
  assert.ok(tracked.size > 10, '这条测试应当能读到 git 的跟踪列表');
});

test('结构契约：仓库顶层只允许约定俗成的目录与文件', () => {
  const allowedDirs = new Set(['src', 'tests', 'tools', 'scripts', 'docs', 'data', 'knowledge',
    'reports', 'report', 'output', 'checkpoints', 'training',
    // roco/ 是手游规则引擎（Python）。它单独成域是因为：
    //   ① 语言不同（Python，规则引擎；JS，教练与页面）；
    //   ② 实施书要求「Python roco_env 是手游规则唯一来源，Node 不得再实现一套」，
    //      目录边界让这条约束看得见；
    //   ③ 它有自己的 pyproject 与测试，不该混进 src/ 的模块图。
    'roco',
    // models/ 是**模型登记表**（models/registry.json），不是权重。
    // 权重在 .models/（被 .gitignore 忽略），两者刻意分开：
    //   ① 登记表要入库，权重不能入库；
    //   ② 校验脚本按登记表里的 SHA256 校验本机权重，路径写在登记表里。
    // 这条测试守住「models/ 里只有登记表」——见下面那条。
    'models']);
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

test('结构契约：models/ 里只有登记表，没有任何权重文件', () => {
  // 权重（safetensors/gguf/bin）一旦混进 models/ 就会被提交进仓库。
  // 这条测试是**唯一的**那道闸：目录在允许清单里，所以必须单独守住内容。
  const entries = readdirSync(join(ROOT, 'models'), {withFileTypes: true});
  const names = entries.map((e) => e.name);
  for (const name of names) {
    assert.ok(!/\.(safetensors|gguf|bin|pt|pth|onnx|npz|mlmodel|h5|ckpt)$/i.test(name),
      `models/ 里出现了权重文件：${name}（权重要放 .models/，那里被 gitignore）`);
  }
  assert.deepEqual(names.filter((n) => !n.startsWith('.')).sort(), ['registry.json'],
    'models/ 只允许 registry.json（模型登记表）');
  // 登记表必须自带来源与许可证字段，否则「这个权重是什么」无法追溯。
  const registry = JSON.parse(readFileSync(join(ROOT, 'models', 'registry.json'), 'utf8'));
  assert.ok(Array.isArray(registry.models) && registry.models.length, 'registry 必须有 models 段');
  for (const model of registry.models) {
    for (const field of ['model_id', 'revision', 'source', 'license', 'quantization']) {
      assert.ok(model[field], `${model.model_id || '条目'} 缺少 ${field}`);
    }
  }
});

test('结构契约：URL 空间与磁盘空间同构，页面短路径可用', async () => {
  const { createCoachServer } = await import('../../src/server/index.js');
  const server = createCoachServer({ semantic: false, fetchImpl: async () => { throw Error('测试环境不允许联网'); } });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    // ① 模块图里每个模块都必须取得到（这正是「白名单或路径拼接写错」的症状）
    const problems = [];
    for (const rel of serverBrowserModules()) {
      const r = await fetch(base + rel);
      if (r.status !== 200) problems.push(`${rel} -> HTTP ${r.status}`);
    }
    assert.deepEqual(problems, [], `从 HTTP 拿不到的浏览器模块：\n${problems.join('\n')}`);

    // ② 页面短路径是对外契约。roco.html 是演示页的短路径，同样要能开。
    for (const p of ['', 'index.html', 'connect.html', 'roco.html']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `页面路径 /${p} 应当可用，实际 ${r.status}`);
    }

    // ③ 每个 HTML 页面按**浏览器规则**解析出来的每个本地资源都必须能取到。
    // 这条是白屏的直接反证：服务器给了 HTML，但页面自己的脚本 404。
    for (const page of [...publicAssets].filter((a) => a.endsWith('.html'))) {
      const url = page === 'src/client/index.html' ? '' : page.replace(/^src\/client\//, '');
      const html = readFileSync(join(ROOT, page), 'utf8');
      for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        if (/^(https?:)?\/\//.test(spec) || spec.startsWith('data:') || spec.startsWith('#')) continue;
        if (!/\.(js|css)$/.test(spec)) continue;
        // 浏览器把相对路径解析到**页面 URL 的目录**上；
        // 页面短路径都在根上，所以相对路径实际落在 /（这正是 roco.html 那次踩的坑）。
        const resolved = spec.startsWith('/') ? spec : new URL(spec, base + url).pathname;
        const r = await fetch(base.replace(/\/$/, '') + resolved);
        assert.equal(r.status, 200, `${page} 引用 ${spec}，浏览器会请求 ${resolved}，实际 HTTP ${r.status}（页面会白屏）`);
      }
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

// ── 多页面的资源白名单（2026-09-21 加）────────────────────────────────────────
//
// 起因是一个**真实的白屏**：加了第二个页面 roco.html 之后，服务器确实把
// roco.html 加进了白名单，但它自己的入口脚本 /src/client/roco.js 返回 404，
// 页面一行 JS 都不执行。原因是那份模块图只从 app.js 出发，
// 而且我把 HTML 里的绝对路径 `/src/client/roco.js` 当相对路径解析了一次，
// 得到 `src/client/src/client/roco.js`。
//
// 单元测试当时全绿：它们查的是「磁盘上有没有这个文件」，查不出
// 「运行中的服务器会不会给这个 URL 返回 404」。所以这条契约改成
// **直接拿服务器导出的白名单来核对**，而不是各自算一遍。



test('结构契约：多页面白名单——每个 HTML 页面的本地入口都在白名单里', () => {
  const pages = [...publicAssets].filter((rel) => rel.endsWith('.html'));
  assert.ok(pages.length >= 3, `应当至少有 3 个页面（营地/连接/演示），实际 ${pages.length}`);
  for (const page of pages) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    const specs = moduleSpecifiers(html);
    assert.ok(specs.length > 0, `${page} 没有任何 module 脚本或 import，页面会是静的`);
    for (const spec of specs) {
      // 与 server.js 同一条规则：绝对路径与 URL 空间同构（仓库根 = URL 根），
      // 相对路径按所在文件解析。URL 里能出现的形式只有这两种。
      const rel = spec.startsWith('/') ? spec.slice(1) : relative(ROOT, resolve(ROOT, dirname(page), spec)).replace(/\\/g, '/');
      assert.ok(publicAssets.has(rel),
        `${page} 引用 ${spec}，但它不在服务器的资源白名单里（会返回 404、页面白屏）`);
      assert.ok(existsSync(join(ROOT, rel)), `${page} 引用 ${spec}，磁盘上没有 ${rel}`);
    }
  }
});

test('结构契约：每个页面的模块图闭包都在白名单里且都真实存在', () => {
  const graph = serverBrowserModules();
  const pages = [...publicAssets].filter((rel) => rel.endsWith('.html'));
  for (const page of pages) {
    assert.ok(graph.has(page), `模块图漏了页面 ${page}`);
  }
  for (const rel of graph) {
    assert.ok(existsSync(join(ROOT, rel)), `模块图里的 ${rel} 在磁盘上不存在`);
  }
  // 演示页那两个模块必须在图里：它们的缺失正是上面那次白屏
  for (const need of ['src/client/roco.js', 'src/coach/roco-experience.js']) {
    assert.ok(graph.has(need), `模块图里缺了 ${need}——它不会被服务器提供，页面会白屏`);
  }
});
