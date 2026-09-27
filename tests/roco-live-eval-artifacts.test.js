// 金标评测脚本的**产物完整性**判据（2026-09-25，第 25 轮）。
//
// 为什么单独立一条：这一轮实测踩了两次"产物被写坏"，而它两次都让报告**看起来更好**：
//   ① `--only=c14,c16,…` 跑了 7 条，却照常覆盖整轮产物 ⇒ 另外 47 条变成空行（`text:''`），
//      `badAnswers` 于是成了空数组 —— **假的"全好了"**，要再烧一轮 token 才能恢复；
//   ② `--from-raw`（本意是"只做后处理"）其实只是原样重放：既不用当前守卫重算 validation，
//      也不按当前用例表刷新判据 —— 守卫改了口径在报告里看不出来，而 `expect.answer.must` 里
//      是**函数**，JSON 存下来变成 `[null]`，重放时一致率从 54/54 掉到 52/54（c45/c46 被报
//      `answer-missing:null`）。
// 这一条不看模型、不花钱：用 `--from-raw --only=c01` 真跑一次脚本，断言
//   ① 整轮产物**一个字节都没动**；② `-only` 产物真的写出来了；③ 脚本里有"按当前用例表刷新判据"
//      与"按 guardInputs 重算守卫"这两步（字符串级，因为那两步的效果只有在有模型答案时才看得见）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (p) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');

test('金标产物：`--only` 不许覆盖整轮产物，`--from-raw` 要用当前判据重算', () => {
  const full = 'reports/live-model-eval.json';
  const raw = 'reports/live-model-eval-raw.json';
  assert.ok(existsSync(join(ROOT, full)) && existsSync(join(ROOT, raw)),
    '整轮产物必须存在（先跑一次 node scripts/eval-live-s04.js）');
  const before = {full: sha(full), raw: sha(raw)};
  // 真跑一次 only + from-raw：不调模型（selected 为空），但会写 `-only` 产物。
  execFileSync(process.execPath,
    ['scripts/eval-live-s04.js', '--from-raw', '--only=c01', '--allow-unreviewed'],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, NODE_TEST_CONTEXT: undefined}});
  assert.equal(sha(full), before.full, '`--only` 之后整轮报告必须逐字节不变（否则又是一次"假的更好看"）');
  assert.equal(sha(raw), before.raw, '`--only` 之后整轮 raw 必须逐字节不变');
  assert.ok(existsSync(join(ROOT, 'reports/live-model-eval-only.json')),
    '`--only` 的产物要写到 -only 那份上（跑完得留下证据）');
  const only = JSON.parse(readFileSync(join(ROOT, 'reports/live-model-eval-only.json'), 'utf8'));
  assert.equal(only.metrics.casesExecuted, 1, '`-only` 报告里只该有那一条');
  assert.equal((JSON.parse(readFileSync(join(ROOT, full), 'utf8')).metrics.casesExecuted), 54,
    '整轮报告仍是 54 条（没有被裁剪）');
  // 反证：参数**两种写法都要收**（`--only=x` 与 `--only x`）—— 只认一种会让"以为过滤了、其实跑了整轮"
  const srcPaths = readFileSync(join(ROOT, 'scripts/eval-live-s04.js'), 'utf8');
  assert.match(srcPaths, /startsWith\(`\$\{name\}=`\)/, '`--flag=value` 形式必须被解析');
  // ③ 后处理两步必须在脚本里（字符串级；它们的效果要有模型答案才看得见）
  const src = readFileSync(join(ROOT, 'scripts/eval-live-s04.js'), 'utf8');
  assert.match(src, /判据按当前用例表刷新/, '`--from-raw` 必须按当前用例表刷新 expect（函数判据存不进 JSON）');
  assert.match(src, /checkGroundedAnswer\(\{text:g\.text/, '`--from-raw` 必须按 guardInputs 用当前守卫重算 validation');
  assert.match(src, /record\.guardInputs=/, '落盘时要把守卫重算的输入存进 raw');
});

// ── 工具选择的计数口径：**答案层改写回执不是工具调用**（2026-09-25，第 26 轮）────────────
//
// 实测（c11「对手后备还有谁？」）：这一轮模型一次工具都没调（金标 `calls:[0,1]` ⇒ 0 次算过），
// 但它的第一版正文被事实检查判红、触发了一次**答案层改写**，那条回执被塞进 `toolTrace`
// （`tool:null`）—— 于是"第一手工具"读成了 null ⇒ 判 `first tool null not in read_state/compare_actions`，
// 而它其实**根本没调工具**（该算 0 次、算过）。这一条把口径钉死：工具口径只看带工具名的条目。
test('工具选择口径：答案层改写回执（tool:null）不算工具调用', async () => {
  const {judgeToolSelection} = await import('../scripts/eval-tool-metrics.js');
  const correction = {id: 'tool:correction:1', tool: null, args: null,
    result: {error: 'checkGroundedAnswer', reasons: ['unsupported-number'], hint: '重写这一句'}};
  const real = {id: 'tool:1', tool: 'read_state', args: {}, result: {turn: 3}};
  // ① 只有改写回执 + 金标允许 0 次 ⇒ **算过**
  const ok0 = judgeToolSelection({id: 'x', calls: 1, toolTrace: [correction], expect: {calls: [0, 1], tools: ['read_state']}});
  assert.equal(ok0.correct, true, `0 次工具调用必须算过：${JSON.stringify(ok0)}`);
  // ② 只有改写回执 + 金标要求 ≥1 次 ⇒ 必须红在"没调工具"上（不是红在 null 上）
  const must1 = judgeToolSelection({id: 'x', calls: 1, toolTrace: [correction], expect: {calls: [1, 1], tools: ['read_state']}});
  assert.equal(must1.correct, false);
  assert.deepEqual(must1.reasons, ['expected a tool call, made none']);
  // ③ 改写回执在前、真回执在后 ⇒ 第一手读的是**真那个**
  const after = judgeToolSelection({id: 'x', calls: 1, toolTrace: [correction, real],
    expect: {calls: [1, 1], tools: ['read_state', 'compare_actions']}});
  assert.equal(after.correct, true, `第一手应当是 read_state：${JSON.stringify(after)}`);
});
