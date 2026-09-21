// 出处（evidence_ids）从引擎一路透到宿主可见层的钉子：**Node 映射层这一段**。
//
// 用法：`node --test tests/evals/roco/roster-evidence.test.js`
//
// 这一组钉的只有一件事：`rocoService.roster()` 会不会把引擎给的
// **精灵级 / 技能级出处**搬出来。之前它没有——`docs/roco/GAME-ADAPTER.md` §7
// 登记过这个缺口（roster 回执只有一条 roster 级 evidence，钉不到具体精灵/技能）。
//
// 纪律：这条判据必须**有必红方向**。所以每个正向用例旁边都有一条反证：
// 把 `evidence_ids` 从回执副本上剥掉，同一条判据（`rosterEvidenceProblems`）
// 必须报出问题。判据写成「包含 .json 就算过」那种样子，剥掉字段也照样绿。
//
// python3 不在就整组 **skip 并带原因**（与 `mock-host-integration.test.js` 同一写法），
// 不是假装通过。

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createRocoService} from '../../../src/server/roco-service.js';
import {RocoClient, RULESET_ID} from '../../../src/coach/roco-client.js';

const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? null : `python3 不可用（${PYTHON.error}）：roster 出处透传测试跳过`;
const T = (name, fn) => test(name, {skip: SKIP ?? false, timeout: 180000}, fn);

const log = (...args) => console.log('  ·', ...args);

/** 无参回执**必须照旧**有的键。加出处是加性变更，旧键一个不能少、语义不能变。 */
const LEGACY_TOP_KEYS = Object.freeze(['ok', 'count', 'usable_count', 'team_size', 'note', 'pets']);
/** `pets[]` 元素照旧有的键（新增 `evidence_ids` 之外的键必须还在）。 */
const LEGACY_PET_KEYS = Object.freeze(['pet_id', 'name', 'types', 'stats', 'pet_class', 'stage', 'moveset_size', 'moveset']);
/** `moveset[]` 元素照旧有的键。 */
const LEGACY_MOVE_KEYS = Object.freeze(['skill_id', 'name', 'element', 'category', 'energy', 'power', 'power_status', 'damage_class', 'desc', 'is_trait']);

/**
 * 逐只、逐招核对出处，返回问题清单（空数组 = 合格）。
 *
 * 抽成纯函数只有一个理由：**反证要能复用同一条判据**。
 * 每一条都要求精确相等，不是「看起来像」。
 */
export function rosterEvidenceProblems(out) {
  const problems = [];
  if (out?.ok !== true) {
    problems.push(`回执 ok!=true：${JSON.stringify(out?.error ?? null)}`);
    return problems;
  }
  const answer = Array.isArray(out.evidence_ids) ? out.evidence_ids : [];
  if (answer.length === 0) problems.push('顶层 evidence_ids 为空（Answer 级那条没有出口）');
  const ruleset = answer
    .map((id) => /^ev:([^:]+):roster#total=/.exec(String(id))?.[1] ?? null)
    .find(Boolean) ?? null;
  if (ruleset === null) {
    problems.push(`顶层 evidence_ids 形状不对（应为 ev:<ruleset>:roster#total=…）：${JSON.stringify(answer)}`);
  } else if (ruleset !== RULESET_ID) {
    problems.push(`顶层 evidence_ids 的 ruleset 是 ${ruleset}，应为 ${RULESET_ID}`);
  }
  const pets = Array.isArray(out.pets) ? out.pets : [];
  if (pets.length === 0) problems.push('回执里没有 pets');
  for (const pet of pets) {
    const wantPet = `ev:${ruleset}:pets.json#${pet.pet_id}`;
    if (!(Array.isArray(pet.evidence_ids) && pet.evidence_ids.length === 1 && pet.evidence_ids[0] === wantPet)) {
      problems.push(`${pet.pet_id} 的 evidence_ids=${JSON.stringify(pet.evidence_ids ?? null)}，应为 ["${wantPet}"]`);
    }
    for (const move of Array.isArray(pet.moveset) ? pet.moveset : []) {
      if (move.missing_in_skills_json === true) {
        // 孤儿技能：引擎说「skills.json 里没有这条」，出处只能是空数组
        if (!(Array.isArray(move.evidence_ids) && move.evidence_ids.length === 0)) {
          problems.push(`${pet.pet_id}/${move.skill_id} 是孤儿技能（引擎登记）却带了出处：${JSON.stringify(move.evidence_ids)}`);
        }
        continue;
      }
      const wantSkill = `ev:${ruleset}:skills.json#${move.skill_id}`;
      if (!(Array.isArray(move.evidence_ids) && move.evidence_ids.length === 1 && move.evidence_ids[0] === wantSkill)) {
        problems.push(`${pet.pet_id}/${move.skill_id} 的 evidence_ids=${JSON.stringify(move.evidence_ids ?? null)}，应为 ["${wantSkill}"]`);
      }
    }
  }
  return problems;
}

const withService = async (fn) => {
  const service = createRocoService();
  try {
    return await fn(service);
  } finally {
    await service.stop();
  }
};

T('无参回执：顶层带 roster 级出处，pets[] 逐只、moveset[] 逐招带自己的出处', async () => {
  await withService(async (service) => {
    const out = await service.roster();
    assert.equal(out.ok, true, `roster 失败：${out.error ?? '(无错误信息)'}`);

    // 加性变更的第一半：旧键一个不少。
    for (const key of LEGACY_TOP_KEYS) assert.ok(key in out, `无参回执少了旧键 ${key}`);
    assert.equal(typeof out.count, 'number');
    assert.equal(out.team_size, 3);
    assert.equal(out.pets.length, 48, `名单应当是全量 48 只，实际 ${out.pets.length}`);
    for (const key of LEGACY_PET_KEYS) assert.ok(key in out.pets[0], `pets[] 少了旧键 ${key}`);
    for (const key of LEGACY_MOVE_KEYS) assert.ok(key in out.pets[0].moveset[0], `moveset[] 少了旧键 ${key}`);

    // 加性变更的第二半：出处逐只、逐招核对。
    const problems = rosterEvidenceProblems(out);
    assert.deepEqual(problems, [], `出处核对不通过：\n${problems.join('\n')}`);

    // 全绿但一条都没核到也是假绿——钉住「核了几只、几招」。
    const moves = out.pets.reduce((n, p) => n + p.moveset.length, 0);
    assert.equal(moves, 192, '48 只 × 4 招 = 192 条技能级出处，逐条核过');
    log(`顶层 evidence_ids=${JSON.stringify(out.evidence_ids)}`);
    log(`抽样 ${out.pets[0].pet_id} 的出处=${JSON.stringify(out.pets[0].evidence_ids)}；`
      + `${out.pets[0].moveset[0].skill_id} 的出处=${JSON.stringify(out.pets[0].moveset[0].evidence_ids)}`);
  });
});

T('分页分支同样带出处（limit/offset），且分页账目没被挤掉', async () => {
  await withService(async (service) => {
    const out = await service.roster({limit: 2, offset: 0});
    assert.equal(out.ok, true, `分页 roster 失败：${out.error ?? '(无错误信息)'}`);
    assert.equal(out.pets.length, 2);
    assert.equal(out.total, 48);
    assert.equal(out.limit, 2);
    const problems = rosterEvidenceProblems(out);
    assert.deepEqual(problems, [], `分页分支出处核对不通过：\n${problems.join('\n')}`);
    assert.match(String(out.evidence_ids?.[0]), /:roster#total=48;offset=0;limit=2$/,
      `分页分支的 roster 级出处应钉住 limit=2，实际 ${JSON.stringify(out.evidence_ids)}`);
  });
});

T('反证：把 evidence_ids 剥掉之后，上面那条判据必须变红', async () => {
  await withService(async (service) => {
    const out = await service.roster({limit: 3, offset: 0});
    assert.equal(out.ok, true);
    // 先证明样本本身是绿的——否则「变红」说明不了任何事。
    assert.deepEqual(rosterEvidenceProblems(out), []);

    const stripTop = (copy) => { delete copy.evidence_ids; return copy; };
    const stripPets = (copy) => { for (const p of copy.pets) delete p.evidence_ids; return copy; };
    const stripMoves = (copy) => {
      for (const p of copy.pets) for (const m of p.moveset) delete m.evidence_ids;
      return copy;
    };
    const wrongPet = (copy) => {
      copy.pets[0].evidence_ids = [`ev:${RULESET_ID}:pets.json#${copy.pets[1].pet_id}`];
      return copy;
    };

    const cases = [
      ['顶层 evidence_ids 被丢掉', stripTop],
      ['pets[].evidence_ids 被丢掉（映射层回退成旧形状）', stripPets],
      ['moveset[].evidence_ids 被丢掉', stripMoves],
      ['出处钉到了别的精灵（形状对、内容错）', wrongPet],
    ];
    for (const [what, mutate] of cases) {
      const problems = rosterEvidenceProblems(mutate(structuredClone(out)));
      assert.ok(problems.length > 0, `${what}：判据仍然通过，这条判据是空的`);
      log(`反证「${what}」→ 判据报错：${problems[0]}`);
    }
  });
});

T('坏参数照旧 fail closed（加出处没有放松参数校验）', async () => {
  await withService(async (service) => {
    const bad = await service.roster({limit: 'abc'});
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    log(`?limit=abc → ${bad.error}`);
  });
});
