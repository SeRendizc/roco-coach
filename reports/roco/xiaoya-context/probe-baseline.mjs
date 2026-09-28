// 复现 P0-05 的基线：完全按 `src/client/xiaoya.js` **现在的**拼法给教练送上下文，然后问「这只」。
//
// 为什么直接调 `runCoach` 而不是发 `/api/coach`：
//   · 演示服务当前 `configured:false`（`GET /api/bootstrap`），走的本来就是 `runCoach` 这一支；
//   · `/api/coach` 的入参是 `assembleContext()` 之后的**装配包**，不是裸 context ——
//     探针要复现的是「上下文里有没有我正在看的那一只」，在这一层调最贴近根因。
//   服务端在 `src/server/index.js:861` 会先过一遍 `attachIndividualsToContext`，这里照做。
//
// 用法：node reports/roco/xiaoya-context/probe-baseline.mjs [base] [petId]
import {buildContext, runCoach} from '../../../src/coach/runtime.js';
import {attachIndividualsToContext} from '../../../src/coach/individuals-context.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const FOCUS_PET = process.argv[3] ?? 'own-0004';

async function loadMobileProfile() {
  const response = await fetch(BASE + '/api/roco/box?kind=mine&limit=48', {cache: 'no-store'});
  const body = await response.json();
  const cards = Array.isArray(body?.player?.cards) ? body.player.cards : [];
  const pets = cards.map((card) => ({
    id: card.select ?? card.group ?? null,
    species_id: typeof card.group === 'string' && /^pet_\d{6}$/.test(card.group) ? card.group : null,
    name: card.name ?? null,
    types: Array.isArray(card.types) ? card.types : [],
    level: Number.isFinite(card.level) ? card.level : null,
    role: card.role_label ?? null,
    mechanism: card.mechanism?.line ?? null,
  })).filter((pet) => pet.id && pet.name);
  return {pets, pool_summary: {total: body.player.total, source: 'owned'}};
}

const profile = await loadMobileProfile();
console.log('名单前 3 只：', profile.pets.slice(0, 3).map((p) => `${p.id} ${p.name}`).join(' / '));
console.log('名单条数：', profile.pets.length, 'total=', profile.pool_summary.total);

// 页面上那一栏（盒子详情页读的就是这个接口）——用来判「回答是否与页面逐字一致」。
const page =
  (await (await fetch(`${BASE}/api/roco/box?detail=${FOCUS_PET}`)).json()).player;
const pageNature = (page.traits ?? []).find((t) => t.label === '性格')?.value ?? null;
const pageTalent = (page.traits ?? []).find((t) => t.label === '资质')?.value ?? null;
const pageSkills = (page.skills ?? []).map((s) => s.name);
console.log(`页面上那一栏（${FOCUS_PET} ${page.name}）：性格=${JSON.stringify(pageNature)} 资质=${JSON.stringify(pageTalent)} 四技能=${JSON.stringify(pageSkills)}`);

const memory = {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []};
const questions = ['这只是什么性格？', '它带哪四个技能？', `${page.name}是什么性格？`];
for (const question of questions) {
  // 与 xiaoya.js:236-238 逐字同一条：activeProfile = 手游档案；focus = pets[0].id。
  const focus = profile.pets[0]?.id ?? null;
  const raw = buildContext(null, profile, focus, null, 'meadow', question);
  raw.coachAllowed = true;
  const context = attachIndividualsToContext(raw);
  const answer = await runCoach({message: question, role: 'auto', context, memory, conversation: []});
  console.log('\n问：' + question);
  console.log('答：' + String(answer.text ?? '').slice(0, 500));
  console.log(`（focus=${focus}  route=${answer.route ?? '?'} provider=${answer.provider ?? '?'}）`);
}
