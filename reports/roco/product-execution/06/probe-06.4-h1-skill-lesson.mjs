/**
 * H1 读数探针（D-31 同刀）：`skillLesson` 在「无威力技能」上拼出的**玩家可见原句**。
 *
 * 走真生产者：`src/coach/teacher.js` 的 `skillLesson(game, action)`；
 * 它在 `src/coach/experience.js:623-629` 被 dorm-lesson 那一支直接当 `text`/`evidence` 用，
 * 再经 `src/client/roco.js:3532`（`state.lastAdviceEvidence`）进提示展开区。
 *
 * 用法（仓库根）：node reports/roco/product-execution/06/probe-06.4-h1-skill-lesson.mjs
 */
import {createGame, legalActions, SKILLS} from '../../../../src/game/engine.js';
import {skillLesson} from '../../../../src/coach/teacher.js';

const game = createGame(17);
const rows = [];
for (const id of ['guard', 'focus', 'moss', 'clearwind', 'ember', 'crush']) {
  const action = {kind: 'skill', id};
  const packet = skillLesson(game, action);
  rows.push({
    id,
    name: SKILLS[id]?.name ?? null,
    power: SKILLS[id]?.power ?? null,
    text_head: (packet?.text ?? '').slice(0, 42),
    evidence_2: (packet?.evidence ?? [])[2] ?? null,
    dirty: /\bnull\b|\bundefined\b|\bNaN\b/.test(JSON.stringify(packet ?? {})),
  });
}
console.log(JSON.stringify({legal_n: legalActions(game).length, rows}, null, 1));
