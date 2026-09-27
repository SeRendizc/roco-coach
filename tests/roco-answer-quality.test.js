// 答案质量的**系统性**判据（2026-09-25，第 27 轮）——钉在**已落盘的评测产物**上，不调模型。
//
// 为什么要有这一条：人类口径②是「**取消「不知道」式回话**——预测必须标明是预测并给出依据」。
// 在那之前，这条口径只靠三处零散力量守：`checkGroundedAnswer`（数字/引用）、`checkReceiptConsistency`
// （与回执冲突）、以及每条用例自己写的 `must`。**没有任何一条判据回答"这一批答案里还有没有
// 「我不知道」式回话"**。这一条补上：对两套产物（金标 54 条 + 手游 20 条）做一次全量扫描，
// 三类硬伤都必须为 0 —— 弃答式、逐字回声式、以及"有弃答词却没有任何依据"的混合体。
//
// 它是**读产物**的判据：产物不在就跳过（不假装验过），产物在就必须干净。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTS = [
  ['金标', 'reports/live-model-eval.json', 'question'],
  ['手游', 'reports/roco/mobile-coach-eval.json', 'question'],
];

/**
 * 弃答词：直接声称自己不知道/查不到/评不了的那一类说法。
 *
 * ⚠ 单看这些词会误伤**正确**的回答 —— 实测两条（都合格）：
 *   · c27「…记录里只有对手换上苔盾菇…**没有它受击的数据**。所以"被掉多少血"无法回答，
 *     这是推断（不是实测）…证据包该回合事件就这三条」（点名了缺的是哪一份证据 + 标注了口径）；
 *   · c35「…今天打得怎么样我这边**没有你的对战记录**，没法接。要不你说说今天用谁打的」（点名了来源 + 给了下一步）。
 * 所以判据是**两段式**：命中弃答词 **且** 既没给出处/边界（依据/来源/记录/证据/口径/未核验/回执）
 * 也没给下一步（你可以/要不/换一个）⇒ 才算"不知道式回话"。
 */
export const REFUSAL = /查不到|不知道|不清楚|评不了|没法评|无法回答|答不了|没有(?:可靠)?数据|我这边没有/;
export const BOUNDARY = /依据|来源|记录|证据|口径|未核验|回执|你可以|要不|换个说法|换一个|帮你复盘/;
export const bareRefusal = (text) => REFUSAL.test(String(text)) && !BOUNDARY.test(String(text));
/** 逐字回声：答案不长于问题 +10 字，且与问题有 ≥ max(8, 60% 问题长度) 的连续共享片段。 */
export function longestShared(question, answer) {
  const q = String(question ?? ''); const a = String(answer ?? '');
  let best = 0;
  for (let i = 0; i < q.length; i += 1) {
    for (let j = i + best + 1; j <= q.length; j += 1) {
      if (a.includes(q.slice(i, j))) best = j - i; else break;
    }
  }
  return best;
}
export function isEcho(question, answer) {
  const q = String(question ?? ''); const a = String(answer ?? '').trim();
  if (!q || !a) return false;
  return a.length <= q.length + 10 && longestShared(q, a) >= Math.max(8, Math.round(q.length * 0.6));
}

function loadRows(file, key) {
  if (!existsSync(join(ROOT, file))) return null;
  const doc = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  return (doc.rows ?? []).map((row) => ({id: row.id, q: row[key] ?? row.message ?? '', text: String(row.text ?? '')}));
}

test('答案质量：两套产物里都没有「不知道」式回话，也没有逐字回声', () => {
  let checked = 0;
  for (const [label, file, key] of PRODUCTS) {
    const rows = loadRows(file, key);
    if (!rows) { console.error(`[答案质量] ${label} 产物不在（${file}）⇒ 跳过这一套`); continue; }
    const bare = rows.filter((r) => r.text.trim() && bareRefusal(r.text));
    const echoes = rows.filter((r) => isEcho(r.q, r.text));
    assert.deepEqual(bare.map((r) => r.id), [],
      `${label}：不许有"我查不到/不知道"式回话（既没出处也没下一步）⇒ `
      + bare.map((r) => `${r.id}「${r.text.slice(0, 40)}」`).join(' '));
    assert.deepEqual(echoes.map((r) => r.id), [], `${label}：不许把玩家那句原样回声当成回答`);
    checked += rows.length;
    console.error(`[答案质量] ${label} ${rows.length} 条：无据弃答 ${bare.length} / 逐字回声 ${echoes.length}`);
  }
  assert.ok(checked >= 20, `至少要真的读过一套产物（读了 ${checked} 条）——产物不在时要如实跳过而不是假绿`);
});

test('答案质量判据的牙：硬伤必须抓住、带出处的诚实边界不许误伤', () => {
  // ① 无据弃答：只有一句"不知道"，没有出处也没有下一步
  assert.ok(bareRefusal('这个我不知道。'));
  assert.ok(bareRefusal('小翼龙的招式表我查不到。'));
  assert.ok(bareRefusal('这一问我没法评。'));
  // ② 逐字回声（历史真例：「我还差多少训练点满级？」→「嗯，还差多少训练点满级。」）
  assert.ok(isEcho('我还差多少训练点满级？', '嗯，还差多少训练点满级。'));
  // ③ 带出处的诚实边界**不许**被误伤（这两条是金标里真实存在且合格的答案）
  assert.ok(!bareRefusal('第5回合你没被打掉血——记录里只有对手换上苔盾菇，你的溪刃獭打出36伤害，没有它受击的数据。'
    + '所以"被掉多少血"无法回答，这是推断（不是实测），把握高：证据包该回合事件就这三条。'));
  assert.ok(!bareRefusal('陪你聊聊可以，今天打得怎么样我这边没有你的对战记录，没法接。要不你说说今天用谁打的，我帮你复盘。'));
  // ④ 正常回答同样不许被误伤
  for (const [q, a] of [
    ['小翼龙的配招怎么选？', '小翼龙能学的招有13个：抓挠、鹰爪…配招方向我再帮你挑。'],
    ['能量上限是6对吧？', '对，能量上限就是 6 豆；每回合回 1 豆。来源：engine.js RULES.energy。'],
    ['明白了，辛苦了。', '收到，我在。'],
    ['我这套阵容有什么短板？', '这队 6 只：能打 8 个属性…其中 丢丢 一只就怕 6 个。这些是引擎算的结构特征，不是胜率。'],
  ]) {
    assert.ok(!bareRefusal(a), `不许误伤：${a}`);
    assert.ok(!isEcho(q, a), `不许误伤（正常回答引用了问题里的词）：${a}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 引用守卫与**语料真的会发的 id 形状**必须对齐（2026-09-25 第 48 轮）
// ─────────────────────────────────────────────────────────────────────────
//
// 为什么补这一条：`checkGroundedAnswer` 的引用白名单是一张**形状正则**，而语料在长
// （L3 相性 / L4 战术卡 / L5 术语…）。两张表一旦漂，两个方向的错都会出，而且都很难看：
//   · **形状没跟上** ⇒ 模型编一个 `term::9999` / `type_chart::不存在系` 也不会有牙（漏网）；
//   · **形状写成子串匹配** ⇒ `battle_skill::skill_000246` 被当成 `skill::…`，
//     明明交付过也判"没交付"，正确回答被降级（误伤）。
//
// 判据是**从索引自己派生**的（不许在判据里另抄一份前缀表）：
//   ① 索引里出现的每条 id **交付过 ⇒ 必须放行**；
//   ② 同一条 id **没交付 ⇒ 必须红**（把 id 里的编号改掉，模拟"编一个"）；
//   ③ shadow 模式（`ragCitations=false`）下，编造的卡片引用照样红（这条从不放宽）。
test('引用守卫对齐语料 id 形状：交付过放行、没交付必红（逐库派生）', async () => {
  const {loadCorpus, buildDocuments} = await import('../src/coach/rag-index.js');
  const {checkGroundedAnswer} = await import('../src/coach/runtime.js');
  const docs = buildDocuments(loadCorpus());
  // 每个前缀取一条样本（id 前缀 = 语料真的会发的形状）。
  const samples = new Map();
  for (const doc of docs) {
    const prefix = doc.id.includes('::') ? `${doc.id.split('::')[0]}::`
      : (/^[a-z]+:/.test(doc.id) ? `${doc.id.split(':')[0]}:` : '(bare)');
    if (!samples.has(prefix)) samples.set(prefix, doc.id);
  }
  samples.set('(bare)', 'EV-ENERGY-MAX');
  assert.ok(samples.size >= 10, `样本太少（${samples.size}），这条判据挡不住漂移`);
  const problems = [];
  for (const [prefix, id] of samples) {
    const delivered = checkGroundedAnswer({knowledge: [], evidence: [`${id} 的正文`],
      toolTrace: [{tool: 'search_rules', result: {results: [{id}]}}], text: `依据 ${id} 这一条。`},
    {ragCitations: true});
    if (!delivered.valid) problems.push(`${prefix} 交付过却判红：${JSON.stringify(delivered.reasons)}`);
    // 反证：把编号改掉 = 编一个（`term::3019` → `term::9013`；`pet::pet_000001` → `pet::pet_999999`）
    const fake = String(id).replace(/\d+/g, (digits) => String(Number(digits) + 7).padStart(digits.length, '0'));
    const fabricated = checkGroundedAnswer({knowledge: [], evidence: [], toolTrace: [],
      text: `依据 ${fake} 这一条。`}, {ragCitations: true});
    if (fabricated.valid) problems.push(`${prefix} 编造也放行：${fake}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('引用守卫：shadow 模式下编造的卡片引用照样红（这条从不放宽）', async () => {
  const {checkGroundedAnswer} = await import('../src/coach/runtime.js');
  const fabricated = checkGroundedAnswer({knowledge: [], evidence: [], toolTrace: [],
    text: '依据 tactic:does-not-exist 这一条。'});
  assert.equal(fabricated.valid, false);
  assert.ok(fabricated.reasons.some((row) => row.startsWith('unsupported-citation:tactic:')),
    JSON.stringify(fabricated.reasons));
  // 交付过（在 knowledge 里）就必须放行 —— 免得好卡片被误伤
  const delivered = checkGroundedAnswer({knowledge: [{id: 'tactic:priority'}], evidence: [], toolTrace: [],
    text: '依据 tactic:priority 这一条。'});
  assert.equal(delivered.valid, true, JSON.stringify(delivered.reasons));
});
