// P0-05 ④ 的复核：小芽答洛手问题时会不会引用**旧游戏那一套**
//（本仓练习局的烬尾狐/潮甲龟/林鹿 —— 2026-09-25 人类点名的那批老版宠物名）。
//
// 两条通路分开量（哪一条漏就报哪一条）：
//   ① 正常：手游盒子名单在手上（焦点也在）；
//   ② 断线：`/api/roco/box` 拿不到 ⇒ `loadMobileProfile` 返回 `{pets:[],unavailable:true}`，
//      页面**不允许**退回本机养成存档 `pet-coach-growth-v1`（那份是练习局夹具）——
//      这才是旧语料真正可能进来的那道缝。
//
// ⚠ 每个问题都有**硬超时**：本地教练有一族会去问 Python 规则服务，服务不在时会挂住
// （第一次跑这一份就是这么挂的）。超时如实记「超时」，不算通过也不算失败。
//
// 用法：node reports/roco/xiaoya-context/probe-legacy-corpus.mjs [base]
import {buildContext, runCoach} from '../../../src/coach/runtime.js';
import {attachIndividualsToContext} from '../../../src/coach/individuals-context.js';
import {loadProfile} from '../../../src/game/progression.js';
import {focusSnapshotFrom} from '../../../src/client/xiaoya.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const LEGACY = ['烬尾狐', '潮甲龟', '林鹿', '练习局'];
const TIMEOUT_MS = 12000;

const withTimeout = (promise, ms = TIMEOUT_MS) => Promise.race([
  promise, new Promise((resolve) => setTimeout(() => resolve({__timeout: true}), ms))]);

const mobile = await (await fetch(`${BASE}/api/roco/box?kind=mine&limit=48`)).json();
const mobileProfile = {
  pets: (mobile.player.cards ?? []).map((card) => ({id: card.select, species_id: card.group,
    name: card.name, types: card.types ?? [], level: card.level ?? null})),
  pool_summary: {total: mobile.player.total, source: 'owned'},
};
const detail = await (await fetch(`${BASE}/api/roco/box?detail=own-0004`)).json();
const snapshot = focusSnapshotFrom(detail.player, {instanceId: 'own-0004'});
const offlineProfile = {pets: [], pool_summary: {}, unavailable: true};   // 与 catch 分支逐字同形状
const mvp = (() => { try { return loadProfile(null); } catch { return {pets: {}}; } })();
console.log('本机练习局存档里的伙伴（**不许**出现在洛手话题的回答里）：', Object.keys(mvp.pets ?? {}).join('、') || '（空）');

const memory = {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []};
const QUESTIONS = ['我一共有多少只精灵？', '我有哪些精灵？', '烬尾狐是谁？', '这只该怎么培养？'];

for (const [scene, profile, focusDetail] of [
  ['① 手游名单 + 焦点（正常）', mobileProfile, {...snapshot, live: true}],
  ['② 断线（pets 为空、unavailable）', offlineProfile, null],
]) {
  console.log(`\n──── ${scene} ────`);
  for (const question of QUESTIONS) {
    const raw = buildContext(null, profile, focusDetail?.instance_id ?? profile.pets?.[0]?.id ?? null,
      null, 'meadow', question);
    raw.coachAllowed = true;
    if (focusDetail) raw.focusDetail = focusDetail;
    const context = attachIndividualsToContext(raw);
    const answer = await withTimeout(runCoach({message: question, role: 'auto', context, memory, conversation: []}));
    if (answer?.__timeout) { console.log(`问「${question}」→ ⏱ 超时（Python 规则服务没起来），如实记，不判成败`); continue; }
    const text = String(answer?.text ?? '');
    const hit = LEGACY.filter((name) => text.includes(name));
    console.log(`问「${question}」→ ${hit.length ? '⚠ 命中旧语料 ' + hit.join('、') : '干净'}｜${text.slice(0, 110)}`);
  }
}
// 上下文那一边也查一遍：**送进去的东西**里有没有练习局那几只（真正的污染向量）。
for (const [label, profile] of [['正常', mobileProfile], ['断线', offlineProfile]]) {
  const ctx = attachIndividualsToContext(buildContext(null, profile, null, null, 'meadow', '我有哪些精灵？'));
  const names = (ctx.profile.pets ?? []).map((pet) => pet.name);
  console.log(`\n上下文里的名单（${label}）：${names.length ? names.slice(0, 6).join('、') : '（空）'}`);
}
process.exit(0);
