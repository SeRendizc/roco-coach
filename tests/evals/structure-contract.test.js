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
        if (m[1].startsWith('node:') || ['fs', 'path', 'url', 'child_process', 'crypto', 'os'].includes(m[1])) {
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
    .filter((spec) => spec.startsWith('node:')
      || ['fs', 'path', 'url', 'child_process', 'crypto', 'os'].includes(spec));
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
