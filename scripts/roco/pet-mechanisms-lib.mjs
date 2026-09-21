// 精灵「机制首层」的构建与检查（纯逻辑，CLI 只做 I/O）。
//
// 为什么需要它：人类在真实试玩后直说——选宠卡片用「最狠一招 + 速度档」当特点**是模板，没意义**，
// 「看体系的吧」「基本属性单独拉出来」「证据不足就写机制资料待确认」。这不是排版问题：
// 之前页面上那句「特点」是**前端现编的一句话**，仓库里没有任何地方能核对它。
//
// 冻结数据里其实**有**可核对的机制文字：`pets.json` / `full-catalog.json` 每只精灵都有
// `feature_skill_id`，而 `skills.json` 里 824 条技能/特性**全部**带 `desc`
// （实测 622/622 都能解析到非空 desc）。所以「机制首层」不需要编：直接把那只精灵的
// 特性/招牌技能名字与**逐字**的 desc 摊到卡片第一层，并带上出处。
//
// 三条不许越过的线：
//   1. **逐字**：`feature.desc` 必须是冻结 `skills.json` 里那条 desc 的**原文子串**
//      （检查器按字符串比对，不按「像不像」）。任何润色、拼接、翻译都会让检查变红。
//   2. **不知道就说不知道**：解析不到 desc 时 `mechanism_line` 必须是
//      `MECHANISM_FALLBACK`（「机制资料待确认」），`feature.desc` 必须是 null，
//      **不许**回落到「速度档」这类替代句子，也不许补一个看起来合理的默认值。
//   3. **不显示没给的数**：威力（`power`）来源没给就 `power: null` + `power_status` 原文，
//      玩家层那句 `mechanism_line` **不写威力**——页面上的威力缺失是 fail closed 的老约定。

import {createHash} from 'node:crypto';
import {MECHANISM_FALLBACK, MECHANISM_LINE_MAX, MECHANISM_STATUSES} from '../../src/coach/pet-mechanisms.js';

// 句子与上限只在 `src/coach/pet-mechanisms.js` 定义一次：页面、接口、构建器用的是同一条。
export {MECHANISM_FALLBACK, MECHANISM_LINE_MAX, MECHANISM_STATUSES};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 机制首层文档的 schema 版本。 */
export const SCHEMA_VERSION = 1;

/**
 * 玩家层禁词：机制首层是给玩家看的，不许出现工程字段 / id / 裸 JSON。
 *
 * 与 `browser-box-acceptance.mjs` 的 `FORBIDDEN_PLAYER` 同源思路：那边的由来是「顺手把出处也印出来」，
 * 这边的由来是「顺手把 skill_000129 印在卡片上」。
 */
export const FORBIDDEN_IN_LINE = /pet_\d|skill_\d|learnset_|instance_|state_version|unknown_fields|provenance|source_scope|licence|[{}]|"\w+"\s*:/;

/** 把 desc 压成一行：只取第一句，去掉多余空白；超过上限就截断并加省略号。 */
export function toMechanismLine(name, desc) {
  const oneLine = String(desc).replace(/\s+/g, ' ').trim();
  const firstSentence = oneLine.split(/(?<=[。！？；])/)[0] || oneLine;
  const head = `特性「${name}」：${firstSentence}`;
  if (head.length <= MECHANISM_LINE_MAX) return head;
  return `${head.slice(0, MECHANISM_LINE_MAX - 1)}…`;
}

/**
 * 构建机制首层文档。
 *
 * @param {object} input
 * @param {object} input.catalog `full-catalog.json` 解析结果（含 `pets`）
 * @param {object} input.skills  `skills.json` 解析结果（含 `skills`）
 * @param {object} [input.pack]  `game-data-pack/v2/pack.json` 解析结果（取其 `tags_live.tags`）
 * @param {object} input.hashes  `{catalog, skills, pack}` 的 sha256 原文
 * @returns {object} 确定性文档（键序固定、无时间戳，可逐字节复核）
 */
export function buildMechanisms({catalog, skills, pack, hashes}) {
  if (!catalog || !Array.isArray(catalog.pets)) throw new Error('buildMechanisms：catalog.pets 缺失');
  if (!skills || !skills.skills || typeof skills.skills !== 'object') throw new Error('buildMechanisms：skills.skills 缺失');

  const tagById = new Map();
  const entities = pack?.sections?.distributable?.entities;
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (entity?.group !== 'battle_skill') continue;
      const raw = entity?.tags_live?.tags;
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const tags = raw.split(/[|,、/]/).map((part) => part.trim()).filter(Boolean);
      if (tags.length) tagById.set(entity.id, tags);
    }
  }

  const pets = {};
  const knownLimits = [];
  const statusCounts = {FROZEN_DESC: 0, MECHANISM_UNCONFIRMED: 0};
  let tagCovered = 0;
  let truncated = 0;

  for (const pet of catalog.pets) {
    const featureId = pet.feature_skill_id ?? null;
    const skill = featureId ? skills.skills[featureId] : null;
    const desc = typeof skill?.desc === 'string' && skill.desc.trim() ? skill.desc : null;

    const tags = new Map();
    for (const skillId of Array.isArray(pet.learnable_skills) ? pet.learnable_skills : []) {
      for (const tag of tagById.get(skillId) ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const mechanismTags = [...tags.entries()]
      .map(([tag, count]) => ({tag, skills: count}))
      .sort((a, b) => (b.skills - a.skills) || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
    if (mechanismTags.length) tagCovered += 1;

    const status = desc ? 'FROZEN_DESC' : 'MECHANISM_UNCONFIRMED';
    statusCounts[status] += 1;
    const line = desc ? toMechanismLine(skill.name ?? pet.name, desc) : MECHANISM_FALLBACK;
    if (desc && line.endsWith('…')) truncated += 1;

    const learnable = Array.isArray(pet.learnable_skills) ? pet.learnable_skills : [];
    // 数据里 `learnable_count` 与 `learnable_skills` 长度不一致（实测存在）——**不许**悄悄选一个当真，
    // 两个都记下来并进 known_limits。
    if (typeof pet.learnable_count === 'number' && pet.learnable_count !== learnable.length) {
      knownLimits.push({
        path: `pets.${pet.pet_id}.learnable_count`,
        declared: pet.learnable_count,
        listed: learnable.length,
        reason: '冻结数据里 learnable_count 与 learnable_skills 长度不一致；两个都保留，机制标签按 listed 计算',
      });
    }

    pets[pet.pet_id] = {
      pet_id: pet.pet_id,
      name: pet.name ?? null,
      types: Array.isArray(pet.types) ? [...pet.types] : [],
      pet_class: pet.class ?? null,
      stage: pet.stage ?? null,
      feature: {
        skill_id: featureId,
        name: skill?.name ?? null,
        category: skill?.category ?? null,
        element: skill?.element ?? null,
        energy: typeof skill?.energy === 'number' ? skill.energy : null,
        power: typeof skill?.power === 'number' ? skill.power : null,
        power_status: skill?.power_status ?? null,
        // 逐字原文；没有就是 null（fail closed），绝不润色。
        desc,
      },
      mechanism_status: status,
      mechanism_line: line,
      mechanism_tags: mechanismTags,
      learnable_skills_listed: learnable.length,
      learnable_count_declared: typeof pet.learnable_count === 'number' ? pet.learnable_count : null,
      // 效果原语未实现是冻结数据自己写的（`effect_support: unsupported`），如实带出来。
      unverified: [
        '技能/特性效果未实机核验（MC-E08 等 microcase 未录制）',
        'desc 文字来自冻结导入，触发条件与时序未验证',
      ],
    };
  }

  const petIds = Object.keys(pets).sort();
  return {
    schema_version: SCHEMA_VERSION,
    artifact: 'pet-mechanisms',
    ruleset_id: catalog.ruleset_id ?? skills.ruleset_id ?? null,
    generated_by: 'scripts/roco/build-pet-mechanisms.mjs',
    why: '选宠卡片首层的「机制」必须是可核对原文，不是前端模板句；本文件是那一层的唯一来源。',
    derived_from: {
      catalog: {path: 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', sha256: hashes.catalog},
      skills: {path: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json', sha256: hashes.skills},
      pack: pack ? {path: 'data/roco/game-data-pack/v2/pack.json', sha256: hashes.pack} : null,
    },
    summary: {
      pets: petIds.length,
      feature_resolved: statusCounts.FROZEN_DESC,
      unconfirmed: statusCounts.MECHANISM_UNCONFIRMED,
      with_tags: tagCovered,
      line_truncated: truncated,
      fallback_line: MECHANISM_FALLBACK,
      note: 'feature_resolved 是「冻结 skills.json 里那条 desc 非空」的只数，不是「效果已验证」。',
    },
    known_limits: knownLimits,
    pets,
  };
}

/**
 * 检查一份机制首层文档。
 *
 * 每条判据都配一条**必红方向**（见 `selftest()` 与 tests）：把构造好的违规样本喂给同一个
 * `checkMechanisms()`，必须报错。空转的检查比没有检查更糟。
 */
export function checkMechanisms(doc, {catalog, skills, hashes}) {
  const issues = [];
  const add = (rule, petId, detail) => issues.push({rule, evidence_id: petId, detail});
  if (!doc || typeof doc !== 'object') { add('document_shape', '-', '文档不是对象'); return {ok: false, issues}; }

  if (doc.schema_version !== SCHEMA_VERSION) add('schema_version', '-', `schema_version=${doc.schema_version}`);
  if (!doc.derived_from?.catalog?.sha256 || !doc.derived_from?.skills?.sha256) {
    add('derived_from', '-', '缺少 derived_from.catalog/skills 的 sha256');
  } else {
    if (hashes && doc.derived_from.catalog.sha256 !== hashes.catalog) {
      add('derived_from_stale', '-', `catalog sha256 与磁盘不符：doc=${doc.derived_from.catalog.sha256.slice(0, 12)} disk=${hashes.catalog.slice(0, 12)}`);
    }
    if (hashes && doc.derived_from.skills.sha256 !== hashes.skills) {
      add('derived_from_stale', '-', `skills sha256 与磁盘不符：doc=${doc.derived_from.skills.sha256.slice(0, 12)} disk=${hashes.skills.slice(0, 12)}`);
    }
  }

  const pets = doc.pets && typeof doc.pets === 'object' ? doc.pets : null;
  if (!pets) { add('pets_shape', '-', 'doc.pets 不是对象'); return {ok: false, issues}; }

  const catalogPets = Array.isArray(catalog?.pets) ? catalog.pets : null;
  if (!catalogPets) add('catalog_shape', '-', 'catalog.pets 缺失，无法核对覆盖');
  else {
    const want = catalogPets.map((pet) => pet.pet_id).sort();
    const got = Object.keys(pets).sort();
    if (want.length !== got.length) add('coverage_count', '-', `冻结目录 ${want.length} 只，文档 ${got.length} 只`);
    for (let i = 0; i < Math.max(want.length, got.length); i += 1) {
      if (want[i] !== got[i]) { add('coverage_ids', want[i] ?? got[i], `第 ${i} 位不一致：catalog=${want[i] ?? '(缺)'} doc=${got[i] ?? '(缺)'}`); break; }
    }
  }

  const frozenSkills = skills?.skills && typeof skills.skills === 'object' ? skills.skills : null;
  if (!frozenSkills) add('skills_shape', '-', 'skills.skills 缺失，无法核对 desc 是否逐字');

  let frozen = 0; let unconfirmed = 0; let tags = 0; let declaredMismatch = 0;
  for (const [petId, row] of Object.entries(pets)) {
    if (!MECHANISM_STATUSES.includes(row?.mechanism_status)) {
      add('mechanism_status', petId, `非法 mechanism_status=${JSON.stringify(row?.mechanism_status)}`);
      continue;
    }
    const desc = row.feature?.desc ?? null;
    if (row.mechanism_status === 'FROZEN_DESC') {
      frozen += 1;
      if (typeof desc !== 'string' || !desc.trim()) { add('frozen_without_desc', petId, 'FROZEN_DESC 但 feature.desc 为空'); continue; }
      const source = frozenSkills?.[row.feature.skill_id];
      if (!source) { add('feature_skill_missing', petId, `feature.skill_id=${row.feature.skill_id} 在冻结 skills.json 里不存在`); continue; }
      const sourceDesc = typeof source.desc === 'string' ? source.desc : '';
      if (!sourceDesc.includes(desc)) {
        // 这一条就是「不许润色」的机器判据：改写过的句子不再是原文子串。
        add('desc_not_verbatim', petId, `feature.desc 不是冻结 desc 的子串：doc=${JSON.stringify(desc.slice(0, 40))} frozen=${JSON.stringify(sourceDesc.slice(0, 40))}`);
      }
      if (row.feature.name !== (source.name ?? null)) add('feature_name_mismatch', petId, `feature.name=${JSON.stringify(row.feature.name)} 冻结=${JSON.stringify(source.name ?? null)}`);
      if (row.mechanism_line === MECHANISM_FALLBACK) add('line_is_fallback', petId, 'FROZEN_DESC 的机制行回落到了 fallback 文案');
    } else {
      unconfirmed += 1;
      if (desc !== null) add('unconfirmed_with_desc', petId, `MECHANISM_UNCONFIRMED 但 feature.desc=${JSON.stringify(desc)}`);
      if (row.mechanism_line !== MECHANISM_FALLBACK) add('unconfirmed_line', petId, `MECHANISM_UNCONFIRMED 的机制行必须是「${MECHANISM_FALLBACK}」，实际 ${JSON.stringify(row.mechanism_line)}`);
    }
    if (typeof row.mechanism_line !== 'string' || !row.mechanism_line.trim()) add('line_empty', petId, 'mechanism_line 为空');
    else {
      if (FORBIDDEN_IN_LINE.test(row.mechanism_line)) add('line_forbidden', petId, `机制行里出现工程字段：${JSON.stringify(row.mechanism_line)}`);
      if (row.mechanism_line.length > MECHANISM_LINE_MAX) add('line_too_long', petId, `机制行 ${row.mechanism_line.length} 字 > ${MECHANISM_LINE_MAX}`);
    }
    if (Array.isArray(row.mechanism_tags)) {
      tags += row.mechanism_tags.length ? 1 : 0;
      for (const entry of row.mechanism_tags) {
        if (!Number.isInteger(entry?.skills) || entry.skills < 1) add('tag_count', petId, `标签 ${JSON.stringify(entry)} 的 skills 不是正整数`);
      }
    } else add('tags_shape', petId, 'mechanism_tags 不是数组');
    if (row.learnable_count_declared !== null && row.learnable_count_declared !== row.learnable_skills_listed) declaredMismatch += 1;
  }

  if (doc.summary?.feature_resolved !== frozen) add('summary_feature_resolved', '-', `summary.feature_resolved=${doc.summary?.feature_resolved} 实际 ${frozen}`);
  if (doc.summary?.unconfirmed !== unconfirmed) add('summary_unconfirmed', '-', `summary.unconfirmed=${doc.summary?.unconfirmed} 实际 ${unconfirmed}`);
  if (doc.summary?.with_tags !== tags) add('summary_with_tags', '-', `summary.with_tags=${doc.summary?.with_tags} 实际 ${tags}`);
  const limits = Array.isArray(doc.known_limits) ? doc.known_limits.length : -1;
  if (limits !== declaredMismatch) add('known_limits_count', '-', `known_limits=${limits} 条，但 learnable_count 不一致的宠物有 ${declaredMismatch} 只（不一致必须登记，不许静默）`);

  return {ok: issues.length === 0, issues, summary: {pets: Object.keys(pets).length, frozen, unconfirmed, with_tags: tags}};
}

/** 自带用例：每条都拿一个**违规样本**过真判据，必须红。 */
export function selftest() {
  const catalog = {pets: [
    {pet_id: 'pet_000001', name: '喵喵', types: ['草系'], class: '猫咪类精灵', stage: 1, feature_skill_id: 'skill_000003', learnable_skills: ['skill_000246'], learnable_count: 1},
    {pet_id: 'pet_000002', name: '无描述兽', types: ['水系'], class: '水类精灵', stage: 1, feature_skill_id: null, learnable_skills: [], learnable_count: 0},
  ]};
  const skills = {skills: {
    skill_000003: {skill_id: 'skill_000003', name: '偏振', category: '特性', element: '无系别', energy: 0, power: null, power_status: 'not_provided_by_source', desc: '受到自己携带技能系别的攻击伤害-40%。'},
    skill_000246: {skill_id: 'skill_000246', name: '抓挠', category: '攻击', element: '普通系', energy: 1, power: 40, power_status: 'from_source', desc: '造成伤害。'},
  }};
  const hashes = {catalog: sha256('catalog'), skills: sha256('skills'), pack: sha256('pack')};
  const good = buildMechanisms({catalog, skills, pack: null, hashes});
  const cases = [];
  const probe = (name, mutate) => {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    const problems = checkMechanisms(doc, {catalog, skills, hashes});
    cases.push({name, want: 'ok=false', got: `${problems.ok ? 'ok=true' : `ok=false；命中 ${problems.issues.length} 条：${problems.issues[0].rule} ${problems.issues[0].detail}`}`, passed: problems.ok === false});
  };
  cases.push({name: '基线（未改坏）必须是绿', want: 'ok=true', got: checkMechanisms(good, {catalog, skills, hashes}).ok ? 'ok=true' : `ok=false：${JSON.stringify(checkMechanisms(good, {catalog, skills, hashes}).issues[0])}`, passed: checkMechanisms(good, {catalog, skills, hashes}).ok === true});
  probe('润色过的 desc（把 -40% 改成 40%）必须红', (doc) => { doc.pets.pet_000001.feature.desc = '受到攻击伤害40%。'; });
  probe('FROZEN_DESC 却把 desc 抹成 null 必须红', (doc) => { doc.pets.pet_000001.feature.desc = null; });
  probe('没有 desc 的精灵写成 FROZEN_DESC 必须红', (doc) => { doc.pets.pet_000002.mechanism_status = 'FROZEN_DESC'; doc.pets.pet_000002.feature.desc = '瞎编的机制'; });
  probe('MECHANISM_UNCONFIRMED 却给出机制行必须红', (doc) => { doc.pets.pet_000002.mechanism_line = '速度档 33，最狠一招抓挠'; });
  probe('机制行里塞 id 必须红', (doc) => { doc.pets.pet_000001.mechanism_line = '特性 skill_000003'; });
  probe('少一只精灵必须红', (doc) => { delete doc.pets.pet_000002; });
  probe('summary 与实际不符必须红', (doc) => { doc.summary.feature_resolved = 2; });
  probe('派生 sha256 与磁盘不符必须红', (doc) => { doc.derived_from.skills.sha256 = sha256('别的 skills'); });

  const failed = cases.filter((row) => !row.passed).length;
  return {ok: failed === 0, failed, cases};
}

export {sha256};
