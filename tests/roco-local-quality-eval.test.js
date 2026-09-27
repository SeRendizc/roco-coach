/**
 * 判据：本地回答质量评测**本身**可信吗（人类 ⑤：「评测要能证伪，不许自欺」）。
 *
 * 这一份不看模型答得好不好，只看**评测**有没有牙：
 *   · 每条用例都有机器可判的要求；
 *   · 负对照（已知的烂回答）必须被同一套判据抓住；
 *   · 正对照必须通过（否则就是"一律拒绝"那种假的严）；
 *   · 留出：用例问句不在提示词/材料里（不然是拿训练题考自己）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CASES, BAD_ANSWERS, judgeAnswer, selfTest} from '../scripts/roco/eval-local-quality.mjs';

const modelSource = readFileSync(new URL('../src/coach/local-model.js', import.meta.url), 'utf8');

test('① 每条用例都必须有"必须出现"的要求（否则它判不了任何东西）', () => {
  assert.ok(CASES.length >= 10, `留出用例至少 10 条（实际 ${CASES.length}）`);
  for (const row of CASES) {
    assert.ok(row.id && row.family && row.ask, `用例要有 id/族/问句：${JSON.stringify(row).slice(0, 60)}`);
    assert.ok(Array.isArray(row.want) && row.want.length >= 1, `${row.id} 没有 want ⇒ 判据是空的`);
    assert.ok(Array.isArray(row.forbid) && row.forbid.length >= 1, `${row.id} 没有 forbid`);
  }
  const families = new Set(CASES.map((row) => row.family));
  assert.ok(families.size >= 5, `至少覆盖 5 个族（实际 ${families.size}：${[...families].join('、')}）`);
});

test('② 负对照必须被同一套判据抓住（判据不是空的）', () => {
  assert.ok(BAD_ANSWERS.length >= 4, '至少四条烂回答当负对照');
  assert.deepEqual(selfTest(), [], '负对照/正对照自检必须零问题');
  // 逐条再钉一遍：每条烂回答都要有**至少一个**理由，且理由说得清
  for (const bad of BAD_ANSWERS) {
    const verdict = judgeAnswer(CASES[0], bad.answer);
    assert.equal(verdict.ok, false, `「${bad.id}」（${bad.why}）必须被判不合格`);
    assert.ok(verdict.reasons.length >= 1 && verdict.reasons.every((row) => row.length > 2));
  }
});

test('③ 判据不是"一律拒绝"：合规且切题的回答必须通过', () => {
  const good = '这队缺个能扛伤害的坦克，先把前排补上再谈输出。';
  assert.equal(judgeAnswer(CASES[0], good).ok, true, '切题回答不该被误杀');
  // 另一族的正对照也要过（防止只有第一条能用）
  const order = CASES.find((row) => row.id === 'order');
  const ordered = '先上速度最快的那只压血线，坦克放第二位接伤害。';
  assert.equal(judgeAnswer(order, ordered).ok, true, `「出场顺序」这条也要能通过：${JSON.stringify(judgeAnswer(order, ordered))}`);
});

test('④ 留出：用例问句不许出现在提示词或材料里（拿训练题考自己不算评测）', () => {
  for (const row of CASES) {
    assert.ok(!modelSource.includes(row.ask), `「${row.ask}」出现在 local-model.js 里 ⇒ 不是留出用例`);
  }
});

test('⑤ 反过拟合：判据只写"必须满足什么"，不许写死某只精灵的标准答案', () => {
  for (const row of CASES) {
    for (const pattern of row.want) {
      const text = String(pattern);
      // 允许窄的枚举（性格名那种闭集），但不许出现整句答案式的长文本
      assert.ok(text.length <= 40, `${row.id} 的 want 太长，像是写死了答案：${text}`);
      assert.ok(!/。$/.test(text.replace(/\/$/, '')), `${row.id} 的 want 看起来是一整句答案：${text}`);
    }
  }
});

test('⑥ 混英文的回答必须被拒（判的是**正文**，不是被 JSON 包装过的字符串）', () => {
  const latin = '先看你 roster_total 里那几只。';
  for (const row of CASES.slice(0, 4)) {
    const verdict = judgeAnswer(row, latin);
    assert.equal(verdict.ok, false, `${row.id} 必须拒绝混英文的回答`);
    assert.ok(verdict.reasons.some((one) => one.includes('英文') || one.includes('不该有')),
      `要给出"哪一层判的"：${verdict.reasons}`);
  }
});
