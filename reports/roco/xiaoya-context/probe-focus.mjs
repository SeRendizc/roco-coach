// 复核用的探针：把「页面那一栏」（`/api/roco/box?detail=`）当作焦点送进教练，问那三格。
//
// 用法：node reports/roco/xiaoya-context/probe-focus.mjs [base] [petId] [focusMode]
//   focusMode: on（默认，带 focusDetail）| off（修前形状：只带名单，focus=pets[0]）
import {buildContext, runCoach} from '../../../src/coach/runtime.js';
import {attachIndividualsToContext} from '../../../src/coach/individuals-context.js';
// 焦点快照的构造只有一份实现：页面那一份（`src/client/xiaoya.js` 的 `focusSnapshotFrom`）。
// 探针直接 import 它 —— 免得脚本里再抄一份、两边迟早漂。
import {focusSnapshotFrom} from '../../../src/client/xiaoya.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const PET = process.argv[3] ?? 'own-0004';
const MODE = process.argv[4] ?? 'on';

const boxRes = await fetch(`${BASE}/api/roco/box?kind=mine&limit=48`, {cache: 'no-store'});
const body = await boxRes.json();
const pets = (body?.player?.cards ?? []).map((card) => ({
  id: card.select ?? card.group ?? null,
  species_id: typeof card.group === 'string' && /^pet_\d{6}$/.test(card.group) ? card.group : null,
  name: card.name ?? null, types: Array.isArray(card.types) ? card.types : [],
  level: Number.isFinite(card.level) ? card.level : null,
  role: card.role_label ?? null, mechanism: card.mechanism?.line ?? null,
})).filter((pet) => pet.id && pet.name);
const profile = {pets, pool_summary: {total: body.player.total, source: 'owned'}};

const detailRes = await fetch(`${BASE}/api/roco/box?detail=${encodeURIComponent(PET)}`);
const detailBody = await detailRes.json();
const snapshot = focusSnapshotFrom(detailBody.player, {instanceId: PET, source: `?detail=${PET}`});
console.log('页面那一栏：', JSON.stringify({name: snapshot.name, nature: snapshot.nature,
  talent: snapshot.talent, tier: snapshot.talent_tier, skills: snapshot.skills.map((s) => s.name)}));

const questions = ['这只是什么性格？', '它带哪四个技能？', '这只的资质是多少？',
  `${snapshot.name}是什么性格？`, '这是哪一只？'];
const memory = {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []};
for (const question of questions) {
  const raw = buildContext(null, profile, MODE === 'on' ? PET : (pets[0]?.id ?? null), null, 'meadow', question);
  raw.coachAllowed = true;
  if (MODE === 'on') raw.focusDetail = {...snapshot, live: true};
  const context = attachIndividualsToContext(raw);
  const answer = await runCoach({message: question, role: 'auto', context, memory, conversation: []});
  console.log(`\n问：${question}\n答：${String(answer.text ?? '').slice(0, 600)}`);
  console.log(`（route=${answer.route ?? '?'} provider=${answer.provider ?? '?'} agentStop=${answer.agentStop ?? '-'} toolTrace=${(answer.toolTrace ?? []).length}）`);
}
