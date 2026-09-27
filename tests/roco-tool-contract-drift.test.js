// **工具契约漂移**判据：教练侧声明的查询 kind 必须与引擎实际接受的一致。
//
// 为什么需要它：`query_rules` 的 `kind` 是一张**跨语言**的契约 ——
// 教练侧在 `src/coach/toolbox.js` 写死一张白名单（本地就拒掉非法 kind），引擎侧在
// `roco/src/roco_env/service.py` 的 `rules_query` 分派里另有一张表。两处各写一遍就会漂：
//   · 引擎加了 kind、教练没加 ⇒ **玩家用不到那个能力**，而且没有任何东西会红；
//   · 教练加了 kind、引擎没有 ⇒ 调用打到引擎拿 400，玩家看到的是"工具坏了"。
// 这一组把两张表**逐条比对**，并要求"教练没暴露的引擎 kind"必须写进**显式缺口清单**（可见地缺，而不是悄悄缺）。
//
// 用法：`node --test tests/roco-tool-contract-drift.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {validToolArgs} from '../src/coach/toolbox.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TOOLBOX_SRC = readFileSync(`${ROOT}src/coach/toolbox.js`, 'utf8');
const SERVICE_SRC = readFileSync(`${ROOT}roco/src/roco_env/service.py`, 'utf8');

/**
 * 引擎侧实际接受的 kind（从 `service.py` 的**分派文本**解析，不跑 Python）。
 * 解析三类写法：`kind == "x"`、`kind in ("x", "y")`、`elif kind in EFFECT_KINDS`（常量另取）。
 */
export function engineKindsFrom(source) {
  // ⚠️ 只在 `rules_query` 的**分派块**里解析：整个文件里还有别的 `kind == "magic"` / `"switch"`
  // （那是行动类的判定，不属于查询 kind），不切开就会误收。
  const start = source.indexOf('if kind in ("ruleset", "meta", "stats")');
  const end = source.indexOf('_bad_request(f"未知的查询 kind', start);
  const block = start >= 0 && end > start ? source.slice(start, end) : source;
  const kinds = new Set();
  for (const match of block.matchAll(/kind\s*==\s*"([a-z_]+)"/g)) kinds.add(match[1]);
  for (const match of block.matchAll(/kind\s+in\s+\(([^)]*)\)/g)) {
    for (const item of match[1].matchAll(/"([a-z_]+)"/g)) kinds.add(item[1]);
  }
  const effectSet = /EFFECT_KINDS\s*=\s*frozenset\(\{([^}]*)\}\)/.exec(source);
  if (effectSet) for (const item of effectSet[1].matchAll(/"([a-z_]+)"/g)) kinds.add(item[1]);
  return [...kinds].sort();
}

/** 教练侧声明的 kind（从 `toolbox.js` 的白名单常量解析）。 */
export function coachKindsFrom(source) {
  const match = /ROCO_QUERY_KINDS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, '在 toolbox.js 里找不到 ROCO_QUERY_KINDS');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

/**
 * **教练**没暴露给模型的引擎 kind —— 这是**已知缺口**，必须显式列出来。
 * 每一条都写清为什么：有的属于"引擎内部/调试用"，有的是"教练暂时没接"。
 */
export const UNDECLARED_ENGINE_KINDS = {
  meta: '规则配置的元信息（引擎内部/调试用；模型不需要）',
  stats: '统计口径（同上）',
  roster: '名单查询（教练侧走 evaluate_team / 阵容工作台，不走 query_rules）',
  power: 'EFFECT_KINDS 之一：按威力查（暂无教练问法）',
  damage: 'EFFECT_KINDS 之一：按伤害查（暂无教练问法）',
  mechanic: 'EFFECT_KINDS 之一：按机制查（暂无教练问法）',
  resolve: 'EFFECT_KINDS 之一：结算细节（暂无教练问法）',
};

test('① 教练声明的每个 kind 都必须被引擎接受（否则调用会打到 400）', () => {
  const engine = new Set(engineKindsFrom(SERVICE_SRC));
  const coach = coachKindsFrom(TOOLBOX_SRC);
  assert.ok(coach.length >= 8, `教练侧 kind 太少（${coach.length}）：白名单是不是被删了？`);
  const unknown = coach.filter((kind) => !engine.has(kind));
  assert.deepEqual(unknown, [],
    `教练声明了引擎不认的 kind：${JSON.stringify(unknown)}（引擎接受：${JSON.stringify([...engine].sort())}）`);
});

test('② 引擎接受但教练没暴露的 kind，必须逐条登记在缺口清单里（可见地缺）', () => {
  const engine = engineKindsFrom(SERVICE_SRC);
  const coach = new Set(coachKindsFrom(TOOLBOX_SRC));
  const undeclared = engine.filter((kind) => !coach.has(kind)).sort();
  assert.deepEqual(undeclared, Object.keys(UNDECLARED_ENGINE_KINDS).sort(),
    '引擎有、教练没有的 kind 集合变了 —— 要么补接线，要么在 UNDECLARED_ENGINE_KINDS 里写明为什么');
  for (const [kind, why] of Object.entries(UNDECLARED_ENGINE_KINDS)) {
    assert.ok(why.length > 6, `${kind} 的缺口理由太短：没有理由的缺口等于没登记`);
  }
});

test('③ 反证：引擎加了一个 kind 而教练没跟 ⇒ 必须红', () => {
  const engine = engineKindsFrom(SERVICE_SRC);
  const coach = new Set(coachKindsFrom(TOOLBOX_SRC));
  const injected = [...engine, 'brand_new_kind'];
  const undeclared = injected.filter((kind) => !coach.has(kind)).sort();
  assert.notDeepEqual(undeclared, Object.keys(UNDECLARED_ENGINE_KINDS).sort(),
    '引擎侧凭空多一个 kind 却没登记 ⇒ 这条判据必须能发现');
  // 反向：教练多声明一个引擎不认的 kind ⇒ 也必须红
  const engineSet = new Set(engine);
  assert.ok(!engineSet.has('not_a_real_kind'), '前提：这个 kind 引擎确实不认');
  const coachWithFake = [...coach, 'not_a_real_kind'];
  assert.ok(coachWithFake.some((kind) => !engineSet.has(kind)),
    '教练多声明的 kind 必须能被 ① 抓到');
});

test('④ 行为面：本地就把非法 kind 拒掉（不发到引擎再拿 400）', () => {
  const coach = coachKindsFrom(TOOLBOX_SRC);
  for (const kind of coach) {
    const ok = validToolArgs('query_rules', kind === 'pet' ? {kind, pet_id: 'pet_000001', state_version: 0}
      : kind === 'skill' ? {kind, skill_id: 'skill_000001', state_version: 0}
        : kind === 'learnset' ? {kind, pet_id: 'pet_000001', state_version: 0}
          : kind === 'term' ? {kind, term_id: '1015', state_version: 0}
            : kind === 'type_row' ? {kind, type: '火系', state_version: 0}
              : kind === 'type_multiplier' ? {kind, attack_element: '火系', defender_types: ['草系'], state_version: 0}
              : kind === 'effect' ? {kind, skill_id: 'skill_000001', state_version: 0}
                // 策略读口按**名字**取（2026-09-25 加；目前只有 weather）
                : kind === 'policy' ? {kind, name: 'weather', state_version: 0}
                  // 按属性检索精灵（2026-09-25 加 P0-a）：至少给一个筛法
                  : kind === 'catalog' ? {kind, resist: '龙系', state_version: 0}
                    // 配招可学性（2026-09-25 加 P0-a）：一只精灵 + 一串技能
                    : kind === 'legality' ? {kind, name: '喵喵', skills: ['抓挠', '震击'], state_version: 0}
                    // 名单级相性汇总（2026-09-25 加）：必填一份 id 清单
                    : kind === 'weakness_summary' ? {kind, pet_ids: ['pet_000001', 'pet_000012'], state_version: 0}
                    : {kind, state_version: 0});
    assert.equal(ok, true, `合法 kind ${kind} 必须被放行（否则玩家用不到这个能力）`);
  }
  assert.equal(validToolArgs('query_rules', {kind: 'brand_new_kind', state_version: 0}), false,
    '非法 kind 必须在本地就被拒（不许发到引擎再拿 400）');
  assert.equal(validToolArgs('query_rules', {kind: 'roster', state_version: 0}), false,
    'roster 属于缺口清单里的 kind：本地也必须拒（它没接线，放行等于给玩家一个坏工具）');
});
