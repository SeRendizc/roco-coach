// 「官方 Bad Case」同族：**点名倍率/双属性的相性问句必须直接查引擎 type_multiplier**
// （2026-10-17 加）。
//
// 起因（真实链路实测）：在洛克对局上下文问
//   「电系打翠顶夫人（翼系+水系）是几倍伤害？」
// 旧政策判 `state-in-packet`（`policy-no-tool`）⇒ 一次相性工具都不调 ⇒ 真实模型只能答
// 「查不到，不能编」；可引擎/RAG/客户端三层都是 **3×（强力克制）**，且复现器可证。
// 根因：问句里既有**精灵名**（翠顶夫人）又有**括号双属性**，旧 `TYPE_PAIR_ASK` 只认
// 「A系打B系」，括号里的双属性完全没进解析。
//
// 本文件钉四件事：
//   ① 解析器能把「攻击属性 + 1..2 个防守属性」从问句里取出来（取不到就 null，不猜）；
//   ② 洛克对局上下文里这类问句的路由是 `query_rules / type-multiplier-ask`；
//   ③ `defaultArgsFor` 给出的参数就是 `{kind:'type_multiplier', attack_element, defender_types}`；
//   ④ 反证：不是倍率问句 / 单属性无倍率线索时**不许**被抢走（仍走旧的 type_row / 其它路由）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {policyFor, defaultArgsFor, typeMultiplierAsk} from '../src/coach/runtime.js';

// 洛克对局的裁剪形状（与服务端 roco_battle 校验同源；这里只用政策/参数，不跑引擎）
const rocoBattle = () => ({
  turn: 1, phase: 'battle', state_version: 0, battle_id: 's1-test',
  self: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 425, max_hp: 425, energy: 2, alive: true, types: ['龙系', '幽系']}],
  self_active: 0, self_energy_max: 6,
  foe: [{pet_id: 'pet_000225', name: '寂灭骨龙', hp: 425, max_hp: 425, energy: 2, alive: true, types: ['龙系', '幽系']}],
  legal: [{label: '龙血', kind: 'skill'}, {label: '换上第2位', kind: 'switch'}],
});
const rocoCtx = () => ({mode: 'camp', profile: {pets: [{id: 'pet_000225', name: '寂灭骨龙'}]}, roco_battle: rocoBattle()});
const campCtx = () => ({mode: 'camp', battle: null, profile: {pets: [{id: 'pet_000118', name: '音速犬', types: ['火系']}]}});

test('① 解析器：精灵名 + 括号双属性、双属性直写、带/不带「倍」线索', () => {
 const cases = [
  ['电系打翠顶夫人（翼系+水系）是几倍伤害？', {kind: 'type_multiplier', attack_element: '电系', defender_types: ['翼系', '水系']}],
  ['电系打翠顶夫人(翼系+水系)', {kind: 'type_multiplier', attack_element: '电系', defender_types: ['翼系', '水系']}],
  ['火系打虫系+草系是几倍', {kind: 'type_multiplier', attack_element: '火系', defender_types: ['虫系', '草系']}],
  ['电系打翼系 水系', null], // 空格不是分隔符（不许猜）
  ['水系打火系有优势吗？', null], // 单属性 + 无倍率线索 ⇒ 交给旧的 type_row 路径
  ['龙系克制哪些属性？', null], // 列清单问句
  ['现在该换谁？', null],
 ];
 for (const [message, want] of cases) {
  assert.deepEqual(typeMultiplierAsk(message), want, `「${message}」解析不对`);
 }
 // 「属性」归一成「系」
 assert.deepEqual(typeMultiplierAsk('火属性打虫系+草系几倍'), {kind: 'type_multiplier', attack_element: '火系', defender_types: ['虫系', '草系']});
});

test('② 路由：洛克对局里必须查 type_multiplier；营地/旧句式行为不变', () => {
 const ask = '电系打翠顶夫人（翼系+水系）是几倍伤害？';
 const p = policyFor(ask, rocoCtx());
 assert.equal(p.need, 'query_rules', `政策必须要求查引擎：${JSON.stringify(p)}`);
 assert.equal(p.reason, 'type-multiplier-ask');
 // 参数就从问句里取，且攻击方在前、防守方是双属性
 assert.deepEqual(defaultArgsFor('query_rules', rocoCtx(), ask),
  {kind: 'type_multiplier', attack_element: '电系', defender_types: ['翼系', '水系']});

 // 反证：同样的问句在**没有属性信息**时不许被抢走（改口问「它几倍」→ 解析 null）
 assert.equal(typeMultiplierAsk('它打它几倍？'), null);
 assert.notEqual(policyFor('它打它几倍？', rocoCtx()).reason, 'type-multiplier-ask');

 // 旧句式不受影响：单属性「A打B有优势吗」仍走 type_row（既有判据钉着）
 assert.equal(policyFor('水系打火系有优势吗？', campCtx()).reason, 'type-chart-ask');
 assert.deepEqual(defaultArgsFor('query_rules', campCtx(), '水系打火系有优势吗？'), {kind: 'type_row', type: '水系'});
 // 洛克对局里的「该换谁」仍走 simulate_branch
 assert.equal(policyFor('现在该换谁？', rocoCtx()).reason, 'roco-battle-advice');
 // 列清单问句仍走整张表
 assert.equal(policyFor('龙系克制哪些属性？', campCtx()).reason, 'type-chart-ask');
});

test('③ 反证（必红方向）：解析器对「没有属性/没有倍率线索」必须返回 null——否则政策会抢走别的问句', () => {
 for (const message of ['这回合怎么打？', '有哪些龙系精灵？', '音速犬有哪些技能？', '应对是什么意思？', '我想练一只抗龙系的伙伴']) {
  assert.equal(typeMultiplierAsk(message), null, `「${message}」不许被当成倍率问句`);
 }
 // 牙：真正带双属性的句子必须命中（否则上一条全是恒真）
 assert.ok(typeMultiplierAsk('电系打翼系+水系'), '带双属性的句子必须命中');
});
