/**
 * **训练侧与推理侧的 token 模板一致性**（Codex 4B 前置第 4 项）。
 *
 * Codex 原话：「验证训练/推理 `enable_thinking`、token 前缀及 `mask_prompt` 的答案区间一致；
 *   **不要只看字符串相似**，也不要无证据修改依赖库。」
 * 交接包自带的 `token_audit.py` 只打印一句「Train prefix default and serving enable_thinking=False
 * differ; inspect masking/template consistency before formal training」—— 那是**要核**，不是**核过**。
 *
 * ## 实测（`scripts/model/verify-template-consistency.py`，用真 tokenizer）
 *
 * | 侧 | 出处 | 传了什么 | prompt tokens |
 * |---|---|---|---|
 * | 训练 | `train_v9.sh` → `mlx_lm lora --config lora-v9.yaml` | **什么都没传** ⇒ 模板里 `enable_thinking` 未定义 | **99** |
 * | 服务 | `scripts/model/serve_mlx.py:108` | `request.get("enable_thinking", False)` ⇒ 默认 **False** | **101** |
 *
 * 模板（`.models/mlx/Qwen3.5-4B-4q-bit/chat_template.jinja:147-152`）两条分支拼出的前缀不同：
 * `enable_thinking is false` ⇒ `'<think>\n\n</think>\n\n'`；否则 ⇒ `'<think>\n'`。
 *
 * ⚠ **关键不只是"前缀不同"**：整串长度**相同（123）**，差的是**切分点** ——
 * `mask_prompt: true`（`lora-v9.yaml`）下，训练把 **24** 个 token 当答案，服务只把 **22** 个当答案。
 * 也就是：训练在**教模型生成**那 2 个 token（空的 think 块收尾），而**服务端会替它注入**。
 *
 * ## 这份判据怎么用
 *
 * · 结构钉（永远成立）：两侧的**设置**没变（服务默认 False、训练不传）—— 任一侧一改就红，逼人回来看；
 * · 分歧记录：把**实测数字**钉住。**对齐之后**数字会变 ⇒ 本判据红 ⇒ 应当把这段改成"已一致"并留档。
 *   ⚠ **在它红着的时候不许开始正式训练** —— 练出来的 prefix 与线上不一致。
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY = join(ROOT, '.venv-mlx', 'bin', 'python');
const SCRIPT = join(ROOT, 'scripts', 'model', 'verify-template-consistency.py');
const SERVE = join(ROOT, 'scripts', 'model', 'serve_mlx.py');
const TRAIN = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'codex-healthcheck', '4b-training-guide', 'train_v9.sh');
const YAML = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'codex-healthcheck', '4b-training-guide', 'lora-v9.yaml');

/** 实测记录的已知分歧（对齐之后这两个数会变，届时本判据红 ⇒ 应当改钉成"已一致"）。 */
const RECORDED = Object.freeze({
  train_prompt_tokens: 99,
  serve_prompt_tokens: 101,
  train_answer_span: 24,
  serve_answer_span: 22,
  full_tokens: 123,
  consistent: false,
});

test('结构钉：训练侧不传 enable_thinking、服务侧默认 false —— 任一侧一改就要人回来看', () => {
  const serve = readFileSync(SERVE, 'utf8');
  assert.match(serve, /enable_thinking\s*=\s*bool\(request\.get\("enable_thinking",\s*False\)\)/,
    'serve_mlx.py 的默认值变了 ⇒ 训练侧的 prefix 也要跟着重核（见本文件头）');
  const train = readFileSync(TRAIN, 'utf8');
  assert.doesNotMatch(train, /enable_thinking/,
    'train_v9.sh 里出现了 enable_thinking ⇒ 两侧设置已变，必须重核并改钉本判据');
  assert.match(readFileSync(YAML, 'utf8'), /mask_prompt:\s*true/,
    'lora-v9.yaml 不再是 mask_prompt: true ⇒ 答案区间的算法变了，本判据的前提失效');
});

test('实测分歧：训练 prompt 99 / 服务 prompt 101，答案区间 24 vs 22（**这不是"字符串相似"，是真 tokenizer**）', (t) => {
  if (!existsSync(PY) || !existsSync(SCRIPT)) { t.skip('缺 .venv-mlx 或核验脚本'); return; }
  // ⚠ 核验脚本在"不一致"时**退出码 2**（那正是我们此刻要量的状态），而 `execFileSync` 遇非零会抛。
  //   ⇒ **接住异常读 stdout**：预期的坏状态不该让判据本身抛（本仓已经踩过同类坑两次）。
  let out = '';
  try {
    out = execFileSync(PY, [SCRIPT], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (error) {
    out = String(error.stdout ?? '');
  }
  assert.ok(out.length > 100, `核验脚本没给出可解析的输出（stdout ${out.length} 字节）`);
  const pick = (re) => Number(re.exec(out)?.[1]);
  const trainTok = pick(/训练（未传[^）]*）\s+prompt=\s*(\d+)/);
  const serveTok = pick(/服务（enable_thinking=False）\s+prompt=\s*(\d+)/);
  const spanMatch = /被 mask 的答案区间\*\*逐 token 相同\*\*：(\w+)（训练 (\d+) tok \/ 服务 (\d+) tok）/.exec(out);

  assert.equal(trainTok, RECORDED.train_prompt_tokens,
    `训练侧 prompt token 数变了（记录 ${RECORDED.train_prompt_tokens}，实测 ${trainTok}）—— 模板或样本变了，重核`);
  assert.equal(serveTok, RECORDED.serve_prompt_tokens,
    `服务侧 prompt token 数变了（记录 ${RECORDED.serve_prompt_tokens}，实测 ${serveTok}）`);
  assert.ok(spanMatch, `解析不到答案区间那行：\n${out.slice(-400)}`);
  assert.equal(spanMatch[1], 'False', '两侧答案区间一致了？那是好事 —— 但必须改钉本判据并留档');
  assert.equal(Number(spanMatch[2]), RECORDED.train_answer_span);
  assert.equal(Number(spanMatch[3]), RECORDED.serve_answer_span);

  // 硬结论：**在分歧解决之前不许开始正式训练**
  assert.equal(RECORDED.consistent, false,
    '这一条现在是**已知分歧**记录；对齐后把它改成 true 并把 RECORDED 换成一致后的数字');
});

test('反证：把服务侧默认值改回 True（与训练一致）⇒ 结构钉必须红', () => {
  // 直接验那条断言的核心条件：源码里必须是默认 False
  const serve = readFileSync(SERVE, 'utf8');
  const asIfChanged = serve.replace(/enable_thinking",\s*False/, 'enable_thinking", True');
  assert.notEqual(asIfChanged, serve, '替身没改到东西 ⇒ 反证脚本本身失效');
  assert.doesNotMatch(asIfChanged, /enable_thinking\s*=\s*bool\(request\.get\("enable_thinking",\s*False\)\)/,
    '把默认值改成 True 之后，结构钉的匹配必须不再成立（否则它抓不到这个改动）');
});

// ── 对齐方案（Codex 第 4 项的**可运行修法**，2026-09-29 阶段 3）──────────────────
//
// 上面那条钉的是**未对齐的事实**（训练 99 / 服务 101）。这一条钉**修法有效**：
// `scripts/model/train_v9_aligned.py` 在训练入口把 `apply_chat_template` 包一层，
// 默认补 `enable_thinking=False` —— **不改 mlx_lm 源码、不动主服务**。
//
// ⚠ **本判据不训练任何东西**，只做 token/mask 层面的独立验证（Codex 要求"独立 token/mask 验证"）。
test('对齐方案（包装档）：训练侧经包装后与服务侧**逐 token 相同**，且答案区间一致', (t) => {
  if (!existsSync(PY) || !existsSync(SCRIPT)) { t.skip('缺 .venv-mlx 或核验脚本'); return; }
  const wrapper = join(ROOT, 'scripts', 'model', 'train_v9_aligned.py');
  if (!existsSync(wrapper)) { t.skip('还没有对齐包装'); return; }
  let out = ''; let code = 0;
  try {
    out = execFileSync(PY, [SCRIPT, '--with-wrapper'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (error) { out = String(error.stdout ?? ''); code = Number(error.status ?? 1); }
  assert.equal(code, 0, `包装档没有对齐（退出码 ${code}）—— **不要开始正式训练**：\n${out.slice(-500)}`);
  assert.match(out, /与服务侧前缀\*\*逐 token 相同\*\*：True/);
  assert.match(out, /被 mask 的答案区间与服务侧相同：True/);
  assert.match(out, /训练侧已对齐到服务侧/);
});

test('反证：**不**加包装时仍然不一致（否则上面那条是假绿）', (t) => {
  if (!existsSync(PY) || !existsSync(SCRIPT)) { t.skip('缺 .venv-mlx 或核验脚本'); return; }
  let out = ''; let code = 0;
  try {
    out = execFileSync(PY, [SCRIPT], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (error) { out = String(error.stdout ?? ''); code = Number(error.status ?? 1); }
  assert.equal(code, 2, '不带包装时应当仍然是"不一致"（退出码 2）—— 否则说明对齐判据量错了东西');
  assert.match(out, /训练侧与服务侧 \*\*不一致\*\*/);
});
