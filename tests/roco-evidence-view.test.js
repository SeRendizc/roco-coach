/**
 * 「依据」栏：**原始出处 id 不许给玩家看**（`ev:` 那一类），人话依据照旧显示。
 *
 * 由来：Lead 的重点失败问句回归在回答文本里看到 `依据ev:roco-world-s4-2026-09-10:pets#…`，
 * 转给 `coach-context` 核实 → 结论是**默认可见文本干净**（三问正文里 0 个机器串），
 * 那些 id 只在**可展开的「依据」块**里。Lead 复核后拍板：id 也不该出现在那一块，
 * 于是给 `evidence-view.js` 的 `INTERNAL` 加了 `\bev:`。
 *
 * ⚠ 这一改**只滤 id、不动正文**：玩家读到的「（依据：游戏图鉴的相性表 火系 那一行，逐字抄录）」
 * 是回答 `text` 的一部分（`src/coach/runtime.js:1534`），而 `ev:` 来自**单独的** `evidence` 数组
 * （`receipt.evidence_ids`）—— 两者不是同一行。本判据把这个区别钉住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {playerEvidence, splitEvidence} from '../src/client/evidence-view.js';

test('原始出处 id（ev:…）归到 internal —— 玩家看不到', () => {
  const {shown, internal} = splitEvidence([
    'ev:roco-world-s4-2026-09-10:pets#pet_000225',
    '游戏图鉴的相性表，火系那一行',
  ]);
  assert.deepEqual(shown, ['游戏图鉴的相性表，火系那一行'], '人话那条要留下');
  assert.deepEqual(internal, ['ev:roco-world-s4-2026-09-10:pets#pet_000225'], 'id 那条要被滤掉');
});

test('只有 id、没有人话时 → 如实兜底，不把工程串端出去', () => {
  const out = playerEvidence(['ev:roco-world-s4-2026-09-10:pets#pet_000225']);
  assert.deepEqual(out, ['依据是引擎的数据与规则表。']);
  for (const line of out) assert.doesNotMatch(line, /ev:/);
});

test('反证：把 `\\bev:` 从正则里拿掉，id 就会漏给玩家 —— 这条判据必须抓得住', () => {
  // 直接验"id 行不该被判成 shown"这个核心条件（正则里必须有 \bev:）
  const {shown} = splitEvidence(['ev:roco-world-s4-2026-09-10:pets#pet_000225']);
  assert.equal(shown.length, 0, 'id 行进了 shown ⇒ 玩家会读到原始出处串');
  assert.ok(shown.every((l) => !/ev:/.test(l)));
});
