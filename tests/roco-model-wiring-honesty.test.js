// 模型面板的**接线诚实性**判据（2026-09-25 建立；同日二次收口：把「名字被引用」与「真有调用路径」分开）。
//
// 为什么需要它：`localModelReport()`（`src/server/index.js`）里的 `connected` 只说明
// 「本地模型开关开着 + 权重目录存在」——**不说明有任何代码路径会调它**。实测（只读调研 + 主线程复核）：
//   · Qwen3.5-4B 的唯一调用点是 `src/coach/local-model.js`（`ROCO_LOCAL_MODEL=on|shadow` 时走它）；
//   · **Qwen3.8-27B 在全仓只有面板这一处 `stat`**，没有任何调用路径（训练由人类自己做，接口预留）。
// 人类口径是「27B 我自己训」⇒ 面板**不许**让人把它读成「27B 已可用」。
//
// 这条判据有三层，缺一层就会退化成「看起来在检查」：
//
//   ① **形状**：两个条目都必须带 `wired` + `wired_evidence`，且 4B=true / 27B=false（今天的实测事实）；
//
//   ② **两层判据**（`judge27bWiring`，纯函数：喂 `{path, source}` 列表，判什么就是什么）：
//      · 第一层「名字被引用」：提到 `ROCO_LOCAL_MODEL_27B_PATH` 的文件都记一笔。**允许**登记在
//        `NAME_ONLY_ALLOWLIST` 里的「名字来源 / 常量表 / 测试夹具 / 报表面板」，其余一律要求人复核（红）。
//        这一层保的是旧守卫的牙：任何**没登记**的名字引用都要人来判「这是文档还是接线」。
//      · 第二层「真有调用路径」：只有名字**以代码形态**出现（`env.NAME` / `env['NAME']`，
//        不是注释与字符串）**并且同文件出现推理入口**（`new LocalModel` / `createLocalPlan` /
//        `wrapWithLocalModel` / `createLocalProvider` / `model.generate` / `serve_mlx --model` …）
//        才算「给 27B 接了线」——这才是守卫真正要拦的东西。
//      两层的关系：**白名单只豁免「提到名字」，绝不豁免接线** —— 接线挂在白名单路径上照样红
//      （`allowlistViolations`）。服务端另外一条窄规则：27B 的名字只许住在报表面板
//      `localModelReport` 的正文里，跑到别的函数（例如 `new LocalModel` 的工厂）就是 `reporterLeaks` ⇒ 红。
//
//   ③ **必红反证**：把「真的给 27B 接了调用」的几种形态直接喂给**同一条**判据，必须报；
//      反向再钉住「纯名字引用（注释 / 字符串表 / 夹具 key）不算接线」，否则判据会退化成恒红。
//
// 为什么上一版口径必须换（ENV-001 的连带影响）：旧版是「全仓扫这个 env **字符串**的代码引用，
// 除面板与本文件外只要出现就算被接线并 fail」。ENV-001 之后这个名字被合法引用（常量表/新测试的
// 夹具 env 键/审计文档），旧口径立刻误报。误报不能靠「删守卫」或「通配 tests/**」解决：
// 前者丢掉牙，后者谁都能绕。所以换成上面的两层口径。
//
// 已知局限（写清楚，不假装完备）：
//   · 跨文件的间接流（A 文件读 env、B 文件拿 A 的值去 `new LocalModel`）静态扫不出来；
//     但 A 一旦出现就落进第一层「未登记引用」⇒ 仍然会红，逼人复核，不会静默放过。
//   · 掩码器不认识正则字面量里的引号（例如 `/['"]/`），极少见写法可能让它错位；
//     第一层「名字被引用」不经过掩码器，不受影响。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'src/server/index.js';
const SELF = 'tests/roco-model-wiring-honesty.test.js';
const NAME_27B = 'ROCO_LOCAL_MODEL_27B_PATH';

// ── 第一层白名单：允许「只是提到这个名字」的地方 ────────────────────────────────
// 规则：每一条都必须写清**为什么它只是名字、不是调用路径**；而且第二层照样扫这些文件
// （白名单里的真接线会进 allowlistViolations）。没登记的引用一律红 —— 这就是守卫的牙。
const NAME_ONLY_ALLOWLIST = new Map([
  [SERVER, '报表面板本身：27B 的名字只作为 specs 表的 key 与证据文字（字符串字面量）出现，'
    + '正文只 stat 目录，没有任何推理入口拿到它。另有 reporterLeaks 一条窄规则：跑到 localModelReport 正文外就红。'],
  ['src/coach/local-model.js', '名字来源 / 常量表：4B 的 LOCAL_MODEL_PATH_ENV / LOCAL_MODEL_PATH_ALIASES 就登记在这里；'
    + '27B 的名字将来若也登记在这里，属于「名字来源」允许项（今天它还没出现）。它同时是 4B 的推理入口所在地，'
    + '所以第二层与反证都专门拿这条路径试过「白名单藏不住接线」。'],
  ['tests/roco-panel-model-env-key.test.js', 'ENV-001 的判据：把这个 env 键设成**不存在的目录**当测试夹具，'
    + '断言面板不许把 27B 读成可用。它只调 localModelReport 并读 JSON，不加载、不调用任何模型。'],
  [SELF, '本文件自己：判据常量、白名单与必红反证夹具里必然出现这个名字。扫描时跳过自己'
    + '（扫描器不能扫自己），但**谓词层不豁免** —— 反证里把真接线挂到本文件路径上，仍然必须报。'],
]);

/** 把注释与字符串字面量的**内容**抹成空格（长度与换行不变）⇒ 只留代码，偏移量仍对得上。 */
function maskNonCode(source) {
  const chars = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      const from = i;
      while (i < source.length && source[i] !== '\n') i += 1;
      blank(from, i);
      continue;
    }
    if (c === '/' && d === '*') {
      const from = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, source.length);
      blank(from, i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const from = i;
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i = Math.min(i + 1, source.length);
      blank(from, i);
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

/** 推理入口：出现这些就说明「这个文件在起推理」。刻意保守（宁可多报，不可漏报）。 */
const INFERENCE_ENTRY = /new\s+LocalModel\s*\(|class\s+LocalModel\b|createLocalPlan\s*\(|wrapWithLocalModel\s*\(|createLocalProvider\s*\(|\bmodel\.generate\s*\(|\bhealthcheck\s*\(|serve_mlx|modelPath\s*:|--model\b/;
/**
 * 子进程式推理入口（2026-09-25 补）：**必须对原文匹配**。
 *
 * 为什么：上面那条是在 `maskNonCode()` **屏蔽字符串之后**的代码上跑的，而子进程接线的关键
 * 恰恰住在字符串里 —— `spawn(python, ['serve_mlx.py', '--model', p])` 里的 `serve_mlx.py`
 * 与 `--model` 都会被屏蔽掉 ⇒ **真这么接它认不出来**。这不是假想：本文件的必红反证
 * 「走推理子进程脚本」当场就红了（判据不够，不是反证写错）。
 *
 * 只在**跳过纯注释行**的原文上匹配：注释里提一句「--model 这种接法」不该判成接线
 * （该文件里就有大量这样的说明文字）。
 */
const INFERENCE_ENTRY_RAW = /\bserve_mlx\b|\bmlx_lm\b|\bllama_cpp\b|\bspawn\s*\(|\bexecFile\s*\(/;

/** 第二层：这个名字在这个文件里是不是**真的被接进了推理入口**。 */
function wiringOf(source) {
  const code = maskNonCode(source);
  const bare = new RegExp(`(?<![\\w$])${NAME_27B}(?![\\w$])`);
  const computed = new RegExp(`\\[\\s*['"\`]${NAME_27B}['"\`]\\s*\\]`).test(source);
  const codeUse = bare.test(code) ? `env.${NAME_27B}` : (computed ? `env['${NAME_27B}']` : null);
  const entry = INFERENCE_ENTRY.exec(code)
    ?? INFERENCE_ENTRY_RAW.exec(source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n'));
  const wired = Boolean(codeUse && entry);
  return {
    codeUse,
    entry: entry ? entry[0] : null,
    wired,
    why: wired
      ? `名字以代码形态出现（${codeUse}）+ 同文件有推理入口（${entry[0]}）`
      : (codeUse ? `名字以代码形态出现（${codeUse}），但没看到推理入口` : '只在名字层面出现（注释 / 字符串 / 常量表 / 夹具键）'),
  };
}

/** 服务端专条：27B 的名字只许住在报表面板 `localModelReport` 的正文里。 */
function namesOutsideReporter(source) {
  const hit = /export\s+function\s+localModelReport\s*\(/.exec(source);
  if (!hit) return [{line: 0, text: '找不到 localModelReport 的正文 —— 判据自己失效，按红处理'}];
  const open = source.indexOf('{', hit.index);
  if (open === -1) return [{line: 0, text: '找不到 localModelReport 的函数体'}];
  const masked = maskNonCode(source);
  let depth = 0;
  let end = -1;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [{line: 0, text: 'localModelReport 的函数体没有闭合'}];
  const lines = source.split('\n');
  const leaks = [];
  let from = 0;
  while (true) {
    const at = source.indexOf(NAME_27B, from);
    if (at === -1) break;
    from = at + NAME_27B.length;
    if (at < hit.index || at > end) {
      const line = source.slice(0, at).split('\n').length;
      leaks.push({line, text: String(lines[line - 1] || '').trim().slice(0, 100)});
    }
  }
  return leaks;
}

/**
 * 纯函数判据：`files` 是 `{path, source}` 列表，返回这一份输入里的接线结论。
 * 纯函数的意义：必红反证可以把「真的接了调用」的形态**直接喂进来**，不必真在仓里造文件。
 */
function judge27bWiring(files) {
  const verdict = {referenced: [], nameOnly: [], callPaths: [], unreviewed: [], allowlistViolations: [], reporterLeaks: []};
  for (const {path, source} of files) {
    if (!source.includes(NAME_27B)) continue;
    verdict.referenced.push(path);
    const wiring = wiringOf(source);
    const listed = NAME_ONLY_ALLOWLIST.has(path);
    if (wiring.wired) {
      verdict.callPaths.push({path, why: wiring.why});
      if (listed) verdict.allowlistViolations.push(path);
    } else if (listed) {
      verdict.nameOnly.push({path, reason: NAME_ONLY_ALLOWLIST.get(path)});
    } else {
      verdict.unreviewed.push(path);
    }
    if (path === SERVER) {
      for (const leak of namesOutsideReporter(source)) verdict.reporterLeaks.push({path, ...leak});
    }
  }
  const byPath = (a, b) => String(a.path ?? a).localeCompare(String(b.path ?? b));
  verdict.referenced.sort();
  verdict.unreviewed.sort();
  verdict.allowlistViolations.sort();
  verdict.callPaths.sort(byPath);
  verdict.nameOnly.sort(byPath);
  return verdict;
}

/** 全仓扫描（只扫源码与配置，不扫产物/文档；跳过判据自己，理由见白名单）。 */
function repoFiles() {
  const files = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (['node_modules', '.git', 'reports', 'tmp', '.v0.1-run', 'output'].includes(rel.split('/').pop())) return;
      for (const name of readdirSync(abs)) walk(rel ? `${rel}/${name}` : name);
      return;
    }
    // 文档（.md）里提到这个名字不是调用路径（`docs/roadmap/MODEL-ROUTING-PLAN.md` 就会提）；
    // .json 配置可能把权重目录喂给服务，保守扫进来。
    if (!/\.(js|mjs|cjs|json|py)$/.test(rel)) return;
    if (rel === SELF) return;
    try {
      const source = readFileSync(abs, 'utf8');
      if (source.includes(NAME_27B)) files.push({path: rel, source});
    } catch { /* 读不动就跳过 */ }
  };
  for (const dir of ['src', 'scripts', 'tests', 'tools', 'roco']) walk(dir);
  return files;
}

test('模型面板：必须如实标出「有没有接线」与证据，27B 不许被读成已可用', () => {
  const src = readFileSync(join(ROOT, SERVER), 'utf8');
  assert.match(src, /wired:\s*Boolean\(WIRED\[id\]\?\.wired\)/,
    '面板条目必须带 wired（有没有代码路径会调它）');
  assert.match(src, /wired_evidence/, '面板条目必须带 wired_evidence（证据在哪，别让人猜）');
  assert.match(src, /'local-qwen35-4b':\{wired:true/, '4B 今天是有调用路径的（src/coach/local-model.js）');
  // ── 2026-09-29 改钉（依据 README **R07**「移除 27B 在产品中的选项、连接按钮和无用占位/探测」）──
  // **旧断言原文留档**（改前逐字）：
  //   assert.match(src, /'local-qwen38-27b':\{wired:false/,
  //     '27B 今天没有调用路径 —— 面板必须写 false（人类口径：27B 他自己训、接口预留）');
  // 为什么改：那条钉的是「**报了就必须标 false**」；R07 之后连"报"都不该有了 ——
  // 它今天没有任何调用路径（服务端原注释逐字：「27B 在全仓只有下面这一处 stat，没有任何调用路径」），
  // 报出来只会在面板上多一行「未连」的**无用占位**。**判据意图没变**（没有任何调用路径的东西，
  // 不许被读成可用），而且**更严**：从"报了要诚实"升级为"**根本不许报**"。
  assert.doesNotMatch(src, /^\s*\[\s*'local-qwen38-27b'/m,
    '27B 不许再进 localModelReport 的 specs（R07：它就是"无用占位/探测"）');
  // 反证：把那一项加回去，上面这条必须红 —— 证明它不是"什么都过"。
  // ⚠ 反证的注入形式必须**让那一项落在行首**（本判据用的是 `^` 锚定的多行正则）——
  //   我第一版把它注入成 `const specs=[[...],[...]]` 一整行，行首是 `const`，于是反证自己失效。
  // ⚠ 注入要让**27B 那一项自己占一行**（`^` 锚定）—— 第一版我把它注在行内、把 4B 放行首，反证自己失效了。
  const injected = src.replace('const specs=[[',
      "const specs=[\n               ['local-qwen38-27b','x','y','k',false],\n               [");
  assert.match(injected, /^\s*\[\s*'local-qwen38-27b'/m,
    '反证：把 27B 加回 specs 时，新判据必须能认出来（否则这条判据是空的）');
  // 4B 仍然必须如实标 wired:true 且带证据（这一条**没动**）
  assert.match(src, /'local-qwen35-4b':\{wired:true/);
  assert.match(src, /wired_evidence/);
});

test('结构守卫：名字引用必须登记；真出现了 27B 的调用路径必须红，逼着同步改面板标签与证据', () => {
  const files = repoFiles();
  const verdict = judge27bWiring(files);
  const src = readFileSync(join(ROOT, SERVER), 'utf8');

  // 扫描器自己得是活的：至少看到**面板**与**一条判据**（否则「没发现」可能只是没扫到）。
  // 2026-09-25：原来写 `>= 3` 并注释"面板 + 两条判据"，但 `repoFiles()` **排除了本文件自己**
  // （SELF），所以那句期望**永远不可能成立**（实际只能扫到面板 + panel-env-key 判据 = 2）。
  // 修法不是放宽：把"面板必须在结果里"显式钉住，再要求至少还有一条判据 —— 比原来更难蒙混。
  // ── 2026-09-29 改钉（依据 README R07）── **旧断言原文留档**：
  //   assert.ok(verdict.referenced.includes(SERVER),
  //     `扫描结果里必须有面板文件 ${SERVER}，实际：${JSON.stringify(verdict.referenced)}`);
  // 为什么改：R07 之前那条要求"面板文件**必须**在 27B 名字引用列表里"（因为面板要如实标 false）；
  // R07 之后名字**不许**再出现在产品代码里，所以改成钉**反向**的事实：
  //   **`src/**` 里一个引用都不许有** —— 名字只允许留在 tests/（本文件与夹具）与历史注释里。
  // 判据意图没变（名字出现在产品代码里 = 接线嫌疑，必须有人复核），只是把基线从"面板里有"改成"产品里没有"。
  const srcRefs = verdict.referenced.filter((f) => String(f).startsWith('src/'));
  assert.deepEqual(srcRefs, [],
    `R07 之后 src/ 里不许再有 27B 的名字引用，实际：${JSON.stringify(srcRefs)}`);
  // ── 2026-09-29 改钉（R07）── **旧断言原文留档**：
  //   assert.ok(verdict.referenced.length >= 2,
  //     `除面板外至少还要扫到一条判据（SELF 被 repoFiles 排除，见上），实际：${JSON.stringify(verdict.referenced)}`);
  // 为什么改：那条的**意图是"扫描器还活着"**（否则"没发现引用"可能只是没扫到）。R07 之后
  // `src/` 里已经没有引用了，所以不能再用"面板在列表里"当存活证据；改成**要求至少扫到一条引用**
  // （今天扫到的是 name-only 白名单里的判据）—— 意图没变，基线跟着 R07 挪。
  assert.ok(verdict.referenced.length >= 1,
    `扫描器必须是活的（至少要扫到一条 27B 名字引用，今天在 tests/ 的 name-only 白名单里），实际：${JSON.stringify(verdict.referenced)}`);

  // 第一层的牙：没登记的名字引用一律要人复核。
  assert.deepEqual(verdict.unreviewed, [],
    `发现未登记的 27B 名字引用：${verdict.unreviewed.join('、')} —— 请复核它是「名字来源/文档/夹具」`
    + '（那就带理由加进 NAME_ONLY_ALLOWLIST）还是「调用路径」（那就把面板改成 wired:true、更新证据与本文件的口径）');

  // 白名单不是免死金牌：它只豁免「提到名字」，不豁免接线。
  assert.deepEqual(verdict.allowlistViolations, [],
    `白名单文件里出现了 27B 的调用路径：${verdict.allowlistViolations.join('、')} —— 白名单不许藏线，必须按接线处理`);

  // 服务端专条：名字跑到 localModelReport 正文外就是接线嫌疑。
  assert.deepEqual(verdict.reporterLeaks, [],
    `27B 的名字出现在 localModelReport 正文之外：${verdict.reporterLeaks.map((l) => `${l.path}:${l.line} ${l.text}`).join(' | ')}`);

  // 第二层的实测事实：今天仓里没有任何 27B 调用路径。
  assert.deepEqual(verdict.callPaths, [],
    `实测事实是「27B 没有调用路径」，但判据看到：${verdict.callPaths.map((c) => `${c.path}（${c.why}）`).join('；')}`
    + ' —— 真接了线就必须把面板 WIRED 改成 wired:true、更新 wired_evidence，并同步本文件的口径');

  // 面板与代码不许脱节（两个方向都不许撒谎）。
  // ── 2026-09-29 改钉（依据 README **R07**）── **旧断言原文留档**：
  //   const claimsWired = /'local-qwen38-27b':\{wired:true/.test(src);
  //   const claimsNotWired = /'local-qwen38-27b':\{wired:false/.test(src);
  //   assert.ok(claimsWired || claimsNotWired, '面板必须对 27B 的 wired 表态');
  //   assert.equal(claimsWired, verdict.callPaths.length > 0,
  //     '面板的 wired 必须等于代码事实：有调用路径就得写 true，没有就得写 false');
  // 为什么改：旧契约要求「面板**必须**对 27B 表态」；R07 之后没有调用路径的 27B
  // **根本不许进面板**（它正是"无用占位/探测"）。**判据的牙留在"脱节检测"上，而且更硬了**：
  //   · 真出现调用路径 ⇒ **必须**把条目加回来并写 `wired:true`（这一支与旧契约等价）；
  //   · 没有调用路径 ⇒ **两个 claim 都不许有**（旧契约允许写 false，新契约连 false 都不许）。
  const claimsWired = /'local-qwen38-27b':\{wired:true/.test(src);
  const claimsNotWired = /'local-qwen38-27b':\{wired:false/.test(src);
  if (verdict.callPaths.length > 0) {
    assert.ok(claimsWired,
      '真给 27B 接了调用路径时，面板必须把条目加回来并标 wired:true（并更新证据；恢复依据见文档 §132）');
  } else {
    assert.equal(claimsWired || claimsNotWired, false,
      'R07：没有调用路径的 27B 不许再出现在面板里（连 wired:false 那一行也不许留）');
  }
});

test('必红反证：真的给 27B 接了调用 ⇒ 同一条纯函数判据必须报（白名单也藏不住）', () => {
  const WIRING_SHAPES = [
    ['同一行直接喂权重路径', "import {LocalModel} from '../src/coach/local-model.js';\n"
      + `const model = new LocalModel({modelPath: process.env.${NAME_27B}});\n`],
    ['先取值、再接线（两步）', `const weights = process.env.${NAME_27B};\n`
      + "const model = new LocalModel({modelPath: weights});\n"],
    ["env['NAME'] 计算读法", `const model = new LocalModel({modelPath: process.env['${NAME_27B}']});\n`],
    ['喂给工具决策 provider', `const p = process.env.${NAME_27B};\n`
      + 'export const plan = createLocalPlan({model: {generate: () => p}});\n'],
    ['走推理子进程脚本', `const p = process.env.${NAME_27B};\n`
      + "spawn(python, ['serve_mlx.py', '--model', p]);\n"],
  ];
  for (const [label, source] of WIRING_SHAPES) {
    const path = `src/coach/zz-wired-${label.length}.js`;
    const verdict = judge27bWiring([{path, source}]);
    assert.deepEqual(verdict.callPaths.map((c) => c.path), [path],
      `反证「${label}」必须被判成 27B 的调用路径（判据不许恒绿）`);
    assert.ok(String(verdict.callPaths[0]?.why || '').includes(NAME_27B) || verdict.callPaths[0]?.why,
      `反证「${label}」必须给出理由：${JSON.stringify(verdict.callPaths)}`);
  }

  // 白名单路径上出现真接线：照样必须报，而且单独进 allowlistViolations。
  for (const listed of [SERVER, 'src/coach/local-model.js', 'tests/roco-panel-model-env-key.test.js', SELF]) {
    const verdict = judge27bWiring([{path: listed, source: WIRING_SHAPES[1][1]}]);
    assert.deepEqual(verdict.callPaths.map((c) => c.path), [listed],
      `白名单路径 ${listed} 上的真接线必须照样被判成调用路径`);
    assert.deepEqual(verdict.allowlistViolations, [listed],
      `白名单不许藏线：${listed} 必须进 allowlistViolations`);
  }
});

test('反向反证：名字只出现在注释/字符串表/夹具键 ⇒ 不算调用路径，但未登记仍要人复核', () => {
  const NAME_ONLY_SHAPES = [
    ['注释里提到', `// 27B 由人类自己训，接口预留 ${NAME_27B}\nexport const x = 1;\n`],
    ['字符串表里登记名字', `export const KEYS = ['${NAME_27B}'];\n`],
    ['测试夹具 key', `const env = {${NAME_27B}: '/tmp/absent-27b'};\n`],
  ];
  for (const [label, source] of NAME_ONLY_SHAPES) {
    const unlisted = judge27bWiring([{path: `scripts/zz-name-only-${label.length}.js`, source}]);
    assert.deepEqual(unlisted.callPaths, [], `反证「${label}」不该被判成调用路径（否则判据会恒红）`);
    assert.equal(unlisted.unreviewed.length, 1,
      `反证「${label}」：未登记的名字引用必须要求人复核（这是守卫的牙）`);
  }
  // 同一条名字引用，登记进白名单后不再要求复核，但结论仍然是「不是调用路径」。
  const listed = judge27bWiring([{path: SERVER, source: NAME_ONLY_SHAPES[0][1]}]);
  assert.deepEqual(listed.callPaths, [], '白名单里的纯名字引用仍然不是调用路径');
  assert.deepEqual(listed.unreviewed, [], '登记过的名字引用不再进 unreviewed');
  assert.deepEqual(listed.allowlistViolations, [], '没有接线就不该进 allowlistViolations');
});
