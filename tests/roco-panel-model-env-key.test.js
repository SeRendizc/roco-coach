// 面板与运行时**必须读同一个变量名**（审计 ENV-001，S1）。
//
// 缺陷原文（审计实测）：面板 `src/server/index.js` 的 4B 条目宣传
//   `ROCO_LOCAL_MODEL_4B_PATH`
// 而运行时真正读的是
//   `ROCO_LOCAL_MODEL_PATH`（`src/coach/local-model.js` 的 LocalModel.modelPath）
// ⇒ 双向谎报：
//   (a) 按面板提示设 `..._4B_PATH` 的人，面板显示「已连」，但 ROCO_LOCAL_MODEL=on 时
//       LocalModel 仍回落到默认目录（preflight 报「权重目录不存在」）；
//   (b) 正确设 `..._MODEL_PATH` 的人，面板说「没设 ..._4B_PATH」且 connected:false。
//
// 这条判据有三层，缺一层就会退化成「看起来在检查」：
//   ① **名字同源**：面板源码不许再把 `'ROCO_LOCAL_MODEL_4B_PATH'` 当 specs 的 key，
//      必须从 `local-model.js` 的常量取名（改一处名字不会漏改另一处）；
//   ② **两态实测**（`localModelReport()`，即 `/api/models` 调用的那个函数）：
//      真名存在 + 旧名不存在 ⇒ 4B **已连**；反向（旧名存在）⇒ 也**已连**；
//      两个都不设 ⇒ 未连且 reason 点名真名；
//   ③ **运行时同源**：`localModelPathFromEnv()` 的取值就是 LocalModel 会用的那个路径 ——
//      面板报「已连」与引擎真能加载判的是同一份配置。
//
// 为什么在**子进程**里读 `localModelReport(process.env)` 而不是在测试进程里改 env：
// 改 `process.env` 会污染同进程的其它测试（`node --test` 里各文件可能共享进程）；
// 子进程给一份**干净**的环境，测的就是用户真的会碰到的那条路径 —— 本机真设过的
// `ROCO_LOCAL_MODEL_PATH` 不会悄悄改变测试前提。
// 为什么不起真实服务：本机 8765 上常常正跑着真的面板（实测就撞过一次），
// 端口占用会让判据变成「环境问题」而不是「代码问题」；`/api/models` 那一段的结构
// 由下面的 ① 钉住（它必须调用 `localModelReport()`），行为本身由 ② 直接量。
//
// 必红反证（2026-09-25 实测，原文见报告）：
//   · 把面板 4B 的读法改回**只读** `ROCO_LOCAL_MODEL_4B_PATH`（ENV-001 的原文）
//     ⇒ ② 的 A 态变红（真名存在而面板报 connected:false）；
//   · 把 `localModelPathFromEnv` 的别名兜底删掉 ⇒ ② 的 B 态变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {LOCAL_MODEL_PATH_ENV, LOCAL_MODEL_PATH_ALIASES, localModelPathFromEnv} from '../src/coach/local-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server', 'index.js');
const PANEL_SRC = readFileSync(SERVER, 'utf8');

/** 旧面板用过的名字（兼容别名）。空数组会让 ① 自己红，不会静默跳过。 */
const ALIAS = LOCAL_MODEL_PATH_ALIASES[0];

/**
 * 在**子进程**里用给定的环境调 `localModelReport()`（=`/api/models` 里那两个本地条目）。
 * `env` 是显式白名单：没列出的变量一律不继承。
 */
function reportWithEnv(env) {
  const code = `import(${JSON.stringify(SERVER)}).then((m) => `
    + `console.log(JSON.stringify(m.localModelReport(process.env))));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {PATH: process.env.PATH, HOME: process.env.HOME, ROCO_LOCAL_MODEL: 'on', ...env},
  });
  const rows = JSON.parse(out);
  const entry = rows.find((m) => m.id === 'local-qwen35-4b');
  assert.ok(entry, `面板必须报出 4B 那一格，实际：${JSON.stringify(rows.map((m) => m.id))}`);
  return entry;
}

function tempBase(t) {
  // 为什么不用 `os.tmpdir()`：`reportWithEnv` 起的是**子进程**，它拿的是显式白名单
  // 环境（不含 TMPDIR），实测在 macOS 上 `/var/folders/...` 那种临时目录在子进程里
  // `statSync` 会失败 —— 判据会变成「子进程能不能看临时目录」，而不是「读哪个变量名」。
  // 仓里的 `tmp/` 两边都看得见，且本来就在 .gitignore 里。
  const base = mkdtempSync(join(ROOT, 'tmp', 'env-key-test-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  // 一个**真实存在**的权重目录：`mkdtempSync` 只建一层，子目录得自己建，
  // 否则 `statSync().isDirectory()` 判 false，测的就不是环境变量名而是「目录在不在」。
  const weights = join(base, 'weights');
  mkdirSync(weights);
  return {base, weights};
}

test('① 名字同源：面板的 4B key 来自 local-model.js 的常量，不许自己写字面量', () => {
  assert.equal(LOCAL_MODEL_PATH_ENV, 'ROCO_LOCAL_MODEL_PATH',
    '运行时读的真名就是这一个：改它必须同时改测试与文档');
  assert.ok(ALIAS, '必须登记至少一个兼容别名（旧面板用过 ROCO_LOCAL_MODEL_4B_PATH）');

  // specs 里 4B 那一行的 key 位置必须是 `LOCAL_MODEL_PATH_ENV` 这个标识符，
  // **不是** `'ROCO_LOCAL_MODEL_4B_PATH'` 这样的字面量（那正是缺陷原文）。
  assert.match(PANEL_SRC, /'local-qwen35-4b'[^\n]*LOCAL_MODEL_PATH_ENV/,
    '面板 4B 条目的 env key 必须取自 local-model.js 导出的 LOCAL_MODEL_PATH_ENV');
  assert.ok(!/'local-qwen35-4b'[^\n]*'ROCO_LOCAL_MODEL_4B_PATH'/.test(PANEL_SRC),
    "面板 4B 条目不许把旧名 'ROCO_LOCAL_MODEL_4B_PATH' 当 specs 的 key（ENV-001 的原文）");
  // 别名必须被**当成别名**用：面板要能把它报出来，而不是假装没这回事。
  assert.match(PANEL_SRC, /localModelPathFromEnv/, '面板必须走 local-model.js 的同一个读法');
  assert.match(PANEL_SRC, /env_key_is_alias/, '面板必须报出「这份配置来自别名还是真名」');
  // 结构接线：`/api/models` 必须真的用上面被测的那个函数（否则 ② 量的是死代码）。
  assert.match(PANEL_SRC, /\/api\/models'[\s\S]{0,400}localModelReport\(\)/,
    'GET /api/models 必须把 localModelReport() 展开进 models[]（② 量的就是这个函数）');
});

test('② 端到端 A 态：真名存在、旧名不存在 ⇒ 面板必须显示「已连」', (t) => {
  const {base, weights} = tempBase(t);
  const canonical = weights;
  const entry = reportWithEnv({
    [LOCAL_MODEL_PATH_ENV]: canonical,
    // 显式「没设旧名」：子进程环境里没有这个 key。
    ROCO_LOCAL_MODEL_27B_PATH: join(base, 'absent-27b'),
  });
  assert.equal(entry.connected, true,
    `真名 ${LOCAL_MODEL_PATH_ENV} 指向存在的目录时面板必须报已连，实际：${JSON.stringify(entry)}`);
  assert.equal(entry.model, canonical, '面板报出的目录必须就是运行时读到的那个');
  assert.equal(entry.env_key, LOCAL_MODEL_PATH_ENV, '面板必须说明生效的是真名');
  assert.equal(entry.env_key_is_alias, false, '真名生效时不许标成别名');
  assert.equal(entry.reason, '', '已连时不该有异常理由');
});

test('② 端到端 B 态：旧名存在、真名不存在 ⇒ 面板也必须显示「已连」，并注明是兼容别名', (t) => {
  const {base, weights} = tempBase(t);
  const legacy = weights;
  const entry = reportWithEnv({
    [ALIAS]: legacy,
    ROCO_LOCAL_MODEL_27B_PATH: join(base, 'absent-27b'),
  });
  assert.equal(entry.connected, true,
    `兼容别名 ${ALIAS} 指向存在的目录时面板必须报已连（否则旧配置用户会被判成「没设」），实际：${JSON.stringify(entry)}`);
  assert.equal(entry.model, legacy, '运行时与面板读的必须是同一份路径');
  assert.equal(entry.env_key, LOCAL_MODEL_PATH_ENV,
    '面板对外仍然只宣传真名（别名是兼容层，不是第二个正式开关）');
  assert.equal(entry.env_key_is_alias, true, '走别名时必须如实标出来，否则用户不知道自己在用旧名字');
  assert.match(String(entry.reason), /兼容别名/,
    `走别名时 reason 必须写清它从哪个名字读到，实际：${entry.reason}`);
});

test('② 端到端 C 态：真名优先 —— 两个都设时必须用真名那一份', (t) => {
  const {base, weights} = tempBase(t);
  const canonical = weights;
  const legacy = join(base, 'legacy-weights-should-lose');
  const entry = reportWithEnv({
    [LOCAL_MODEL_PATH_ENV]: canonical,
    [ALIAS]: legacy,
    ROCO_LOCAL_MODEL_27B_PATH: join(base, 'absent-27b'),
  });
  assert.equal(entry.model, canonical,
    `两个变量都设时必须用真名（运行时就是真名优先），实际：${JSON.stringify(entry)}`);
  assert.equal(entry.env_key_is_alias, false, '真名生效时不许标成别名');
});

test('② 端到端 D 态：两个名字都不设 ⇒ 必须「未连」，且 reason 点名真名', (t) => {
  const {base} = tempBase(t);
  const entry = reportWithEnv({ROCO_LOCAL_MODEL_27B_PATH: join(base, 'absent-27b')});
  assert.equal(entry.connected, false, `没设任何权重目录时必须未连，实际：${JSON.stringify(entry)}`);
  assert.match(String(entry.reason), new RegExp(LOCAL_MODEL_PATH_ENV),
    `未连时 reason 必须告诉用户设哪个变量（真名），实际：${entry.reason}`);
});

test('② 端到端 E 态：真名指向不存在的目录 ⇒ 未连，且理由不是「没设」', (t) => {
  const {base} = tempBase(t);
  const entry = reportWithEnv({
    [LOCAL_MODEL_PATH_ENV]: join(base, 'no-such-dir'),
    ROCO_LOCAL_MODEL_27B_PATH: join(base, 'absent-27b'),
  });
  assert.equal(entry.connected, false, `目录不存在时必须未连，实际：${JSON.stringify(entry)}`);
  assert.equal(entry.reason, '权重目录不存在', `理由必须区分「没设」与「目录不存在」，实际：${entry.reason}`);
});

test('③ 运行时同源：localModelPathFromEnv 的取值就是 LocalModel 会用的路径', () => {
  const canonical = '/tmp/roco-canonical-weights';
  const alias = '/tmp/roco-alias-weights';

  assert.deepEqual(localModelPathFromEnv({[LOCAL_MODEL_PATH_ENV]: canonical}),
    {value: canonical, source: LOCAL_MODEL_PATH_ENV});
  assert.deepEqual(localModelPathFromEnv({[ALIAS]: alias}),
    {value: alias, source: ALIAS});
  // 真名优先：两个都设时不许被别名顶掉（这正是「运行时按别名跑」的隐性风险）。
  assert.deepEqual(localModelPathFromEnv({[LOCAL_MODEL_PATH_ENV]: canonical, [ALIAS]: alias}),
    {value: canonical, source: LOCAL_MODEL_PATH_ENV});
  // 空串按「没设」：`ROCO_LOCAL_MODEL_PATH=` 不该把别名一起吃掉。
  assert.deepEqual(localModelPathFromEnv({[LOCAL_MODEL_PATH_ENV]: '   ', [ALIAS]: alias}),
    {value: alias, source: ALIAS});
  assert.deepEqual(localModelPathFromEnv({}), {value: null, source: null});

  // 反证：这份读法真的会被 LocalModel 用上（不是面板专用的第二个读法）。
  const src = readFileSync(join(ROOT, 'src', 'coach', 'local-model.js'), 'utf8');
  assert.match(src, /modelPath = localModelPathFromEnv\(process\.env\)\.value \|\| DEFAULT_MODEL_DIR/,
    'LocalModel 的 modelPath 必须走同一个读法 —— 否则面板与运行时又会各读各的');
});
