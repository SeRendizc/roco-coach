/**
 * 门禁：**玩家可见文本**的四类硬判据 + 口径共用件的语义（task-33）。
 *
 * 判据从哪来：`reports/roco/product-execution/crosscut/player-text-audit.md`
 *   · 精度：≥3 位小数（审计里 `teacher.js:332` 那处 13 位浮点的同族）
 *   · 脏值：`null`/`undefined`/`NaN` 这类程序内部值进正文（审计 H1 实测命中过）
 *   · 内部 ID：`skill_\d{6}` / `pet_\d{6}` / `trait_\d{6}`
 *   · 内部术语：`state_version` 等字段名
 *
 * 语料是**真渲染**出来的（`reports/.../crosscut/player-text-corpus.mjs`，真引擎、进程内、不绑端口），
 * 不是 grep 源码 —— 审计的教训就是"运行期拼出来的句子 grep 不到"。
 *
 * 红样本自检（证明判据非恒真，默认关闭）：
 *   `ROCO_TEXT_GATE_INJECT=precision,nullish,internal-id,internal-term node --test tests/roco-player-text-gate.test.js`
 *   ⇒ 「语料干净」那条**必须红**（把假样本混进语料，判据就得报出来）。
 *
 * 跑法：`node --test tests/roco-player-text-gate.test.js`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_NUMBER_FALLBACK, PLAYER_UNITS, RETIRED_UNIT_WORDS, playerNumber, playerQuantity, unitFor,
} from '../src/coach/player-text.js';
import { collectCorpus } from '../reports/roco/product-execution/crosscut/player-text-corpus.mjs';

// ── 四类判据（导出：红/绿自检与后续扩面都复用同一份，不另写一套）────────────────
export const TEXT_GATE = [
  { id: 'precision', why: '≥3 位小数（长浮点）', re: /(?:^|[^\d.])(-?\d+\.\d{3,})(?!\d)/g },
  { id: 'nullish', why: '程序内部值字面', re: /\b(?:null|undefined|NaN|Infinity)\b|\[object Object\]/g },
  { id: 'internal-id', why: '内部 ID', re: /\b(?:skill|pet|trait)_\d{6}\b/g },
  { id: 'internal-term', why: '内部术语/字段名', re: /\b(?:state_version|match_id|rules_version|decision_id|event_seq|replace_queue|foe_max)\b/g },
  // 第 5 类（2026-10-01 task-36 加，Lead 批准）：退役单位词。
  // 词表唯一事实源 = `src/coach/player-text.js` 的 `PLAYER_UNITS`：血量类「血/血量」、能量类「能量」；
  // `HP`/`生命`/`豆` 一律不许再出现在玩家可见文本里。这一类以前只靠零散钉子
  // （`strategist.test.js` 的 `!豆`、`rules.test.js` 的单位断言）守，现在进闸门 ⇒ 以后自动发现。
  { id: 'retired-unit', why: '退役单位词（HP/生命/豆）', re: /\bHP\b|生命|豆/g },
];

/** 扫一段玩家可见文本；`classes` 可选，用来只跑某一类（非恒真自证要按类两向对照）。 */
export function scanPlayerText(text, { classes = TEXT_GATE.map((g) => g.id) } = {}) {
  const hits = [];
  for (const gate of TEXT_GATE) {
    if (!classes.includes(gate.id)) continue;
    for (const m of String(text).matchAll(gate.re)) hits.push({ cls: gate.id, why: gate.why, hit: m[0], text: String(text) });
  }
  return hits;
}
const describe = (hit) => `${hit.cls}（${hit.why}）命中「${hit.hit}」：${hit.text.slice(0, 80)}`;

// 红样本（假数据，只出现在判据里）+ 每类配一条**干净对照**（两向）
const FAKE = {
  precision: { bad: '评分差 0.30000000000000004（事前一回合的公开信息）', good: '评分差 0.3（事前一回合的公开信息）' },
  nullish: { bad: '伤害来自 engine.damage（不防御 null／防御 undefined）。', good: '这一招不造成伤害，不适用伤害估算。' },
  'internal-id': { bad: 'skill_000123 打在 pet_000007 身上。', good: '「齿轮扭矩」打在「潮甲龟」身上。' },
  'internal-term': { bad: 'state_version=7 时 match_id 变了。', good: '局面推进到第 7 步时换了一局。' },
  'retired-unit': { bad: '回复药×3（恢复 45 HP）；当时潮甲龟 4 血、4 豆。', good: '回复药×3（恢复 45 血）；当时潮甲龟 4 血、4 能量。' },
};

// ── ① 共用口径：playerNumber ────────────────────────────────────────────────
test('① playerNumber：整数原样、非整数 1 位、脏值写占位（与 show() 同口径）', () => {
  const 整数 = [[0, '0'], [930, '930'], [-0, '0'], [566, '566'], [-12, '-12'], ['12', '12'], [' 7 ', '7']];
  for (const [input, want] of 整数) assert.equal(playerNumber(input), want, `${JSON.stringify(input)} 应当原样输出整数`);
  const 小数 = [[0.1 + 0.2, '0.3'], [4255.526, '4255.5'], [930.0, '930'], [1.25, '1.3'], [0.05, '0.1'], [-2.34, '-2.3'], ['1.239', '1.2']];
  for (const [input, want] of 小数) assert.equal(playerNumber(input), want, `${JSON.stringify(input)} 应当保留 1 位小数`);
  const 脏值 = [null, undefined, NaN, Infinity, -Infinity, '', '   ', 'abc', {}, [], true, false, 1e16, 1e21, () => {}];
  for (const input of 脏值) {
    const out = playerNumber(input);
    assert.equal(out, PLAYER_NUMBER_FALLBACK, `${String(input)} 取不到数字 ⇒ 必须写占位而不是数字`);
    assert(!/null|undefined|NaN|Infinity|\[object/.test(out), `占位里不许出现程序内部值字面：${out}`);
  }
  // 反例：脏值一律不许被"转成数字"（`Number([])===0`、`Number(true)===1` 这类隐式转换都不接受）
  assert.notEqual(playerNumber([]), '0');
  assert.notEqual(playerNumber(true), '1');
  assert.equal(playerNumber(1.005), '1');            // 1 位口径的四舍五入结果如实钉住（Math.round(10.05)/10）
  assert.equal(playerNumber(0.0000001), '0');
});

// ── ② 共用口径：单位词表 ────────────────────────────────────────────────────
test('② 单位词表：血量叫「血」、能量叫「能量」；退役词不在词表里', () => {
  assert.equal(PLAYER_UNITS.hp, '血', '血量类统一叫「血」（审计：血 598 次 vs 生命 32 / HP 29）');
  assert.equal(PLAYER_UNITS.energy, '能量', '能量类统一叫「能量」（审计：能量 168 次 vs 豆 52）');
  const values = Object.values(PLAYER_UNITS);
  for (const retired of [...RETIRED_UNIT_WORDS.hp, ...RETIRED_UNIT_WORDS.energy]) {
    assert(!values.includes(retired), `退役写法「${retired}」不许出现在词表里`);
  }
  assert.equal(Object.isFrozen(PLAYER_UNITS), true, '词表要冻结：口径一旦定死就不许被就地改');
  assert.equal(unitFor('hp'), '血');
  assert.equal(unitFor('不存在'), null);
  assert.equal(unitFor('不存在', { fallback: '—' }), '—');
  assert.equal(playerQuantity(4, 'hp'), '4 血');
  assert.equal(playerQuantity(null, 'hp'), `${PLAYER_NUMBER_FALLBACK} 血`);
  assert.equal(playerQuantity(4, '不存在'), '4', '未知单位不猜，只出数字');
});

// ── ③ 语料本身要非空、跨生产者（否则"干净"是恒真的）────────────────────────
const corpus = await collectCorpus();
const INJECT = new Set((process.env.ROCO_TEXT_GATE_INJECT || '').split(',').map((s) => s.trim()).filter(Boolean));

test('③ 渲染语料有效：条数/生产者够多、没有渲染失败（防空语料恒真）', () => {
  assert.equal(corpus.failures.length, 0, `渲染器失败：${corpus.failures.map((f) => `${f.api}(${f.err})`).join(' | ')}`);
  assert(corpus.entries.length >= 40, `语料只有 ${corpus.entries.length} 条 ⇒ 门禁等于没查（阈值 40）`);
  const producers = new Set(corpus.entries.map((e) => e.file.split(':')[0]));
  assert(producers.size >= 4, `语料只覆盖 ${producers.size} 个生产者文件 ⇒ 扩面不足（阈值 4）：${[...producers].join(',')}`);
  assert(corpus.entries.every((e) => typeof e.text === 'string' && e.text.trim()), '语料里不许有空串条目');
});

// ── ④ 五类判据跑在真语料上 ─────────────────────────────────────────────────
test('④ 渲染语料里不许有：长浮点 / 脏值 / 内部 ID / 内部术语 / 退役单位词', () => {
  const injected = Object.entries(FAKE).filter(([cls]) => INJECT.has(cls)).map(([cls, v]) => ({ cls, ...v.bad ? { text: v.bad } : {} }));
  const all = [...corpus.entries, ...injected.map((x) => ({ file: `（注入样本:${x.cls}）`, api: 'injected', text: x.text }))];
  const hits = all.flatMap((e) => scanPlayerText(e.text).map((h) => `${e.api}@${e.file} ⇒ ${describe(h)}`));
  assert.deepEqual(hits, [], `玩家可见文本命中门禁 ${hits.length} 条：\n` + hits.slice(0, 12).join('\n'));
});

// ── ⑤ 非恒真自证：每类都要"坏样本必红、好样本不红"（不依赖环境变量）──────────
test('⑤ 非恒真自证：五类判据对坏样本必红、对好样本不红', () => {
  for (const gate of TEXT_GATE) {
    const { bad, good } = FAKE[gate.id];
    const badHits = scanPlayerText(bad, { classes: [gate.id] });
    assert(badHits.length >= 1, `判据 ${gate.id} 连坏样本都没抓到 ⇒ 它是恒真的：${bad}`);
    assert.equal(badHits[0].hit.length > 0, true, '命中要给出具体命中片段，便于排障');
    const goodHits = scanPlayerText(good, { classes: [gate.id] });
    assert.deepEqual(goodHits, [], `判据 ${gate.id} 把好样本也判红了 ⇒ 它是恒假的：${good} —— ${goodHits.map(describe).join('；')}`);
  }
});

// ── ⑥ 回归样本：审计 H1/H2 的原句必须仍在判据覆盖内（即使它们已修）──────────
test('⑥ 审计 H1/H2 的原句仍被判据抓到（历史样本不许"修完就从判据里消失"）', () => {
  const h1 = '伤害来自 engine.damage（不防御 null／防御 null），只按当前面板计算，不预测对手这一回合做什么。';
  const hits = scanPlayerText(h1, { classes: ['nullish'] });
  assert.equal(hits.length, 2, `H1 原句里两个 null 都要被抓到：${JSON.stringify(hits)}`);
  // H2（审计 §H2「同一事实三种叫法」）的三条原句，逐条钉住命中数：
  const h2 = [
    ['当时潮甲龟 4 血、4 豆，对面芽角鹿 44 血；你选了「潮汐重击」。', 1, '复盘里「4 豆」'],
    ['吸取实际伤害 40% 的生命', 1, 'engine.js 生息藤 desc 的「生命」'],
    ['回复药×3（恢复 45 HP）', 1, 'rules.js 道具行的「HP」'],
  ];
  for (const [text, want, label] of h2) {
    const got = scanPlayerText(text, { classes: ['retired-unit'] });
    assert.equal(got.length, want, `${label} 必须被退役词判据抓到：${JSON.stringify(got)}`);
  }
});
