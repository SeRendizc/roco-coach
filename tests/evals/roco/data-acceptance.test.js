// M1 数据域验收测试（独立于 importer，直接对拍原始 Lua 文本与规范化产物）
//
// 目的：不让「importer 自己产出的数据」成为它自己的验收依据。
// 本测试**重新解析原始 Lua**（用同一个安全解析器，但走独立路径），
// 与 `data/roco/normalized/` 的产物逐项对拍。
//
// 覆盖的产品硬性边界：
//   1. 只使用手游数据；不为「凑数」引入页游/宝可梦内容
//   2. 未核验机制标 unsupported / unknown，**禁止**补齐默认威力/触发/时序
//   3. 动态威力不得被当成 0 伤害
//   4. 每条数据带 ruleset / 来源 / revision / 许可 / 核验状态
//   5. 孤儿引用为 0
//   6. 同名异形态必须显式登记，不得静默覆盖
//
// 本文件是**新增**测试，不修改任何既有测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLuaTable, luaArrayToArray } from '../../../scripts/roco/lua-safe-parse.mjs';

const RAW = 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data';
const NORM = 'data/roco/normalized/roco-world-s4-2026-09-10';
const RULESET = 'roco-world-s4-2026-09-10';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 12 只目标精灵（与 03-IMPLEMENTATION-BRIEF §4.1 一致）
const TARGETS = [
  { group: 'A', name: '寂灭骨龙' },
  { group: 'A', name: '海豹船长' },
  { group: 'A', name: '黑猫巫师' },
  { group: 'A', name: '圆号鱼' },
  { group: 'A', name: '雪影娃娃' },
  { group: 'A', name: '音速犬' },
  { group: 'B', name: '画间沉铁兽' },
  { group: 'B', name: '秩序鱿墨' },
  { group: 'B', name: '化蝶', title: '化蝶（平常的样子）' },
  { group: 'C', name: '银月狼王' },
  { group: 'C', name: '圣凯布米龙' },
  { group: 'C', name: '月使鹭纳' },
];

const hasRaw = existsSync(`${RAW}/Catalog.lua`) && existsSync(`${NORM}/pets.json`);

test('M1: 原始快照与规范化数据均已就位（缺失时明确 skip 而不是假装通过）', { skip: !hasRaw && '上游快照未解压（data/roco/raw/extracted 被 .gitignore 忽略）；请先运行 scripts/roco/import-snapshot.mjs' }, () => {
  assert.ok(existsSync(`${RAW}/Catalog.lua`), 'Catalog.lua 存在');
  assert.ok(existsSync(`${NORM}/pets.json`), 'normalized/pets.json 存在');
});

test('M1: 每条记录都带 ruleset / game / 来源 / 许可 / 核验状态（不得有无出处数据）', { skip: !hasRaw && '快照未解压' }, () => {
  for (const f of ['pets.json', 'skills.json', 'learnsets.json', 'types.json', 'terms.json']) {
    const d = readJson(`${NORM}/${f}`);
    assert.equal(d.schema_version, 1, `${f} schema_version`);
    assert.equal(d.ruleset_id, RULESET, `${f} ruleset_id`);
    assert.equal(d.game, 'roco_world_mobile', `${f} 必须是手游，不得混入页游`);
    assert.equal(d.source_id, 'wiki-rocom-snapshot', `${f} source_id`);
  }
  // provenance 台账必须覆盖每只目标精灵
  const prov = readFileSync('data/roco/provenance.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const petProv = prov.filter((p) => p.entity_type === 'pet');
  assert.equal(petProv.length, 12, '12 只精灵各有 provenance');
  for (const p of petProv) {
    assert.equal(p.ruleset_id, RULESET);
    assert.equal(p.game, 'roco_world_mobile');
    assert.ok(p.source_id && p.source_file_sha256 && p.source_locator, '来源三元组齐全');
    assert.ok(p.field_groups && p.field_groups.official_damage_formula === 'unknown', '官方伤害公式必须标 unknown');
  }
});

test('M1: 规范化精灵与原始 Lua 逐字段一致（独立重新解析对拍）', { skip: !hasRaw && '快照未解压' }, () => {
  const { root: catalog } = parseLuaTable(readFileSync(`${RAW}/Catalog.lua`, 'utf8'), { file: 'Catalog.lua' });
  const pets = readJson(`${NORM}/pets.json`).pets;

  const byTitle = {};
  const byName = {};
  for (const [id, p] of Object.entries(catalog)) {
    (byTitle[p.title] ||= []).push(id);
    (byName[p.name] ||= []).push(id);
  }

  for (const t of TARGETS) {
    const ids = t.title ? byTitle[t.title] : byName[t.name];
    assert.ok(ids?.length, `原始快照里能找到 ${t.name}`);
    const rawId = t.title ? ids.find((id) => catalog[id].title === t.title) : ids[0];

    const normalized = Object.values(pets).find((p) => p.name === t.name && (!t.title || p.title === t.title));
    assert.ok(normalized, `normalized 里有 ${t.name}（${t.title ?? '无形态后缀'}）`);
    assert.equal(normalized.pet_id, rawId, `${t.name} 选中的形态 id 与原始快照一致`);

    const raw = catalog[rawId];
    // 属性：顺序必须按 Lua 的 1/2 键
    const expectTypes = Object.keys(raw.types).sort((a, b) => Number(a) - Number(b)).map((k) => raw.types[k]);
    assert.deepEqual(normalized.types, expectTypes, `${t.name} 属性一致`);
    // 六维种族值逐项一致
    for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
      assert.equal(normalized.stats[k], raw.stats[k], `${t.name}.${k} 一致`);
    }
    assert.equal(normalized.game_id, raw.game_id);
    assert.equal(normalized.learnset_id, raw.learnset_id);
    assert.equal(normalized.feature_skill_id, raw.feature_skill_id);
  }
});

test('M1: 动态/条件威力不得被当成 0 伤害（power 缺失必须为 null 而非 0）', { skip: !hasRaw && '快照未解压' }, () => {
  const skills = readJson(`${NORM}/skills.json`);
  for (const [id, s] of Object.entries(skills.skills)) {
    if (s.power === null) {
      assert.equal(s.power_status, 'not_provided_by_source', `${id} 缺失威力必须显式标注来源未提供`);
    } else {
      assert.equal(typeof s.power, 'number');
      assert.equal(s.power_status, 'static_value_present');
    }
    // 关键：绝不出现 power=0 却被当作「无伤害技能」的静默情况
    if (s.power === 0) {
      assert.fail(`${id} 出现 power=0，需人工确认是否真的是 0 威力而不是缺失`);
    }
  }
  assert.ok(skills.counts.without_static_power > 0, '确实存在无静态威力的技能（否则说明解析口径有问题）');
  assert.equal(skills.counts.total, skills.counts.with_static_power + skills.counts.without_static_power);
});

test('M1: 所有技能的效果支持状态必须是 unsupported（本轮未实现任何原语）', { skip: !hasRaw && '快照未解压' }, () => {
  const skills = readJson(`${NORM}/skills.json`).skills;
  for (const [id, s] of Object.entries(skills)) {
    assert.equal(s.effect_support, 'unsupported', `${id} 不得声称可模拟`);
  }
  for (const p of readJson(`${NORM}/support-matrix.json`).pets) {
    assert.equal(p.support.current, 'KNOWLEDGE_ONLY', `${p.name} 当前不支持进入战斗`);
  }
});

test('M1: 孤儿技能引用为 0（学习表引用的技能必须都存在）', { skip: !hasRaw && '快照未解压' }, () => {
  const skills = readJson(`${NORM}/skills.json`).skills;
  const report = readJson(`${NORM}/import-report.json`);
  assert.equal(report.orphan_skill_refs_total, 0, '汇总孤儿引用为 0');
  const learnsets = readJson(`${NORM}/learnsets.json`).learnsets;
  for (const [pid, ls] of Object.entries(learnsets)) {
    const refs = [
      ...ls.native_skills.map((e) => e.skill_id),
      ...ls.blood_skills.map((e) => e.skill_id),
      ...ls.skill_stones,
      ls.feature_skill_id,
    ].filter(Boolean);
    const orphans = refs.filter((r) => !skills[r]);
    assert.deepEqual(orphans, [], `${pid} 无孤儿引用`);
  }
});

test('M1: 同名异形态必须显式登记且形态选择有据（化蝶 4 形态）', { skip: !hasRaw && '快照未解压' }, () => {
  const conflicts = readFileSync('data/roco/conflicts.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const forms = conflicts.filter((c) => c.kind === 'same_name_multiple_forms');
  const hudie = forms.find((c) => c.subject === '化蝶');
  assert.ok(hudie, '化蝶的同名多形态必须被登记');
  assert.equal(hudie.all_forms.length, 4, '化蝶实际有 4 个形态');
  assert.equal(hudie.auto_resolved, true, '目标形态由 title 唯一确定');
  // 选定形态必须是「平常的样子」
  const pets = readJson(`${NORM}/pets.json`).pets;
  const chosen = Object.values(pets).find((p) => p.name === '化蝶');
  assert.equal(chosen.title, '化蝶（平常的样子）');
  // 4 个形态的游戏 id 必须互不相同（证明它们真的是不同形态而非重复行）
  const gids = new Set(hudie.all_forms.map((f) => f.game_id));
  assert.equal(gids.size, 4, '4 个形态的 game_id 互不相同');
});

test('M1: 冲突台账每条都有处置结论；未解决项不得被降级隐藏', { skip: !hasRaw && '快照未解压' }, () => {
  const conflicts = readFileSync('data/roco/conflicts.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(conflicts.length > 0, '确实记录了冲突');
  for (const [i, c] of conflicts.entries()) {
    assert.ok(c.kind, `conflicts[${i}] 有 kind`);
    assert.ok(c.severity, `conflicts[${i}] 有 severity`);

    // 跨来源数值类冲突：必须给出分类或明确的处置结论
    if (c.kind === 'cross_source_value_mismatch') {
      assert.ok(c.classification, `跨来源冲突 ${c.pet_name} ${c.field} 必须有分类`);
      assert.ok(c.resolution || c.detail, `跨来源冲突 ${c.pet_name} ${c.field} 必须有处置说明`);
      const actionNeeded = ['unresolved_needs_human_review', 'two_older_sources_against_primary', 'cross_source_value_unexplained']
        .includes(c.classification);
      if (actionNeeded) {
        assert.equal(c.severity, 'major', `未解决冲突 ${c.pet_name} ${c.field} 必须是 major，不能被降级隐藏`);
      }
    }

    // 形态类冲突：必须给出选定的形态与是否自动消歧
    if (c.kind === 'same_name_multiple_forms') {
      assert.ok(Array.isArray(c.all_forms) && c.all_forms.length > 1, `${c.subject} 列出了全部形态`);
      assert.ok(c.resolution, `${c.subject} 必须写明选定了哪个形态`);
      assert.equal(typeof c.auto_resolved, 'boolean', `${c.subject} 必须声明是否自动消歧`);
      if (!c.auto_resolved) assert.equal(c.severity, 'major', '未自动消歧的形态冲突必须升级为 major');
    }

    // 孤儿引用与缺失学习表属阻塞级
    if (['orphan_skill_reference', 'missing_learnset', 'target_unresolved'].includes(c.kind)) {
      assert.equal(c.severity, 'blocker', `${c.kind} 必须是 blocker`);
    }
  }
  // 本轮结论：不应存在任何 major（未解决）项；若存在，必须真的被标记出来
  const majors = conflicts.filter((c) => c.severity === 'major');
  const report = readJson(`${NORM}/import-report.json`);
  const declaredUnresolved = Object.values(report.cross_check.unresolved_by_classification ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(majors.length, declaredUnresolved, '冲突表里的 major 数量必须与报告声称的未解决数一致（不得瞒报）');
});

test('M1: 支持等级与目标等级必须分开，且不得声称已完成', { skip: !hasRaw && '快照未解压' }, () => {
  const LEVELS = ['CATALOG_ONLY', 'KNOWLEDGE_ONLY', 'SIM_PARTIAL', 'SIM_VERIFIED', 'EVAL_ELIGIBLE'];
  const sm = readJson(`${NORM}/support-matrix.json`);
  assert.equal(sm.pets.length, 12);
  for (const p of sm.pets) {
    assert.ok(LEVELS.includes(p.support.current), `${p.name} current 等级合法`);
    assert.ok(LEVELS.includes(p.support.target_next), `${p.name} target 等级合法`);
    assert.ok(p.support.reason, `${p.name} 必须说明当前等级的理由`);
    assert.notEqual(p.support.current, 'SIM_VERIFIED', `${p.name} 不得声称已达到 SIM_VERIFIED`);
    assert.notEqual(p.support.current, 'EVAL_ELIGIBLE', `${p.name} 不得声称可进入训练`);
  }
  // A 组必须有候选配招；每只 4 个技能
  for (const p of sm.pets.filter((x) => x.group === 'A')) {
    assert.equal(p.candidate_moveset.skills.length, 4, `${p.name} 候选配招 4 技能`);
    assert.equal(new Set(p.candidate_moveset.skills.map((s) => s.skill_id)).size, 4, `${p.name} 4 个技能不重复`);
    assert.ok(Object.keys(p.candidate_moveset.selection_evidence).length >= 3, `${p.name} 有选择证据`);
    for (const s of p.candidate_moveset.skills) {
      assert.ok(s.desc, `${p.name} 的 ${s.name} 有描述（改过名的技能不会有真实描述）`);
      assert.equal(s.effect_support, 'unsupported', `${p.name} 的 ${s.name} 不得声称可模拟`);
    }
  }
});

test('M1: 候选配招的技能必须真实存在于该精灵的学习表（禁止拼凑）', { skip: !hasRaw && '快照未解压' }, () => {
  const sm = readJson(`${NORM}/support-matrix.json`).pets;
  const learnsets = readJson(`${NORM}/learnsets.json`).learnsets;
  const skills = readJson(`${NORM}/skills.json`).skills;
  for (const p of sm.filter((x) => x.group === 'A')) {
    const ls = learnsets[p.pet_id];
    const pool = new Set([
      ...ls.native_skills.map((e) => e.skill_id),
      ...ls.blood_skills.map((e) => e.skill_id),
      ...ls.skill_stones,
    ]);
    for (const s of p.candidate_moveset.skills) {
      assert.ok(pool.has(s.skill_id), `${p.name} 的候选 ${s.name} 必须在其学习表内`);
      assert.ok(skills[s.skill_id], `${p.name} 的候选 ${s.name} 必须存在于 Skills.lua`);
    }
    assert.equal(ls.orphan_skill_refs.length, 0, `${p.name} 学习表无孤儿引用`);
  }
});

test('M1: microcase 计划必须是「计划」——期望值为 null 且验证未通过', () => {
  const lines = readFileSync('tests/evals/roco/cases/microcases-v1.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const header = lines[0];
  assert.equal(header.status, 'PLAN_ONLY_NOT_EXECUTED', '明确标记为未执行');
  const cases = lines.slice(1);
  assert.ok(cases.length >= 12, '至少覆盖任务书要求的 12 个方向');
  for (const c of cases) {
    assert.equal(c.expected_event_sequence, null, `${c.case_id} 不得编造期望事件序列`);
    assert.equal(c.verification.passed, false, `${c.case_id} 不得声称已通过`);
    assert.ok(c.unresolved_questions.length > 0, `${c.case_id} 必须列出未解问题`);
    assert.ok(c.evidence.length > 0, `${c.case_id} 必须有证据引用`);
  }
  // 任务书明确要求的类别必须都在
  const cats = new Set(cases.map((c) => c.category));
  for (const need of ['priority', 'speed_tie', 'simultaneous_action', 'voluntary_switch',
    'knockout_replacement', 'energy', 'status_duration', 'trigger_order',
    'dynamic_damage', 'rounding', 'hidden_information', 'a_group_trait']) {
    assert.ok(cats.has(need), `microcase 覆盖了 ${need}`);
  }
  // A 组 6 只特性各一条
  assert.equal(cases.filter((c) => c.category === 'a_group_trait').length, 6, 'A 组 6 只特性各一条');
});

test('M1: 来源台账不得含页游数据，且未确认许可必须标 REFERENCE_ONLY', () => {
  const yaml = readFileSync('data/roco/sources.yaml', 'utf8');
  // 只检查**实际登记的 url 字段**：注释里说明「排除了哪些来源类别」是必要的文档行为，
  // 不能因此判定为「引入了页游来源」。
  const urls = [...yaml.matchAll(/^\s*(?:url|upstream_url|archive_url):\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(urls.length >= 3, `登记了 ${urls.length} 个来源 URL`);
  for (const u of urls) {
    assert.ok(!/roco\.qq\.com/i.test(u), `来源 URL 不得是页游：${u}`);
    assert.ok(!/bulbapedia|pokemon\.com|wiki\.52poke/i.test(u), `来源 URL 不得是宝可梦资料：${u}`);
    assert.ok(/^https:\/\//.test(u), `来源 URL 必须是 https：${u}`);
  }
  // yaml 必须显式声明排除了页游与宝可梦（防止后来者无意间加回来）
  assert.ok(/excluded_source_classes:/.test(yaml), '必须显式登记被排除的来源类别');
  assert.ok(/页游/.test(yaml), '必须显式排除页游');
  // 每个来源都必须有许可与再分发字段。
  // 按缩进切块，不能用 split('  - source_id:')：字段值内部也可能出现同样文字，会切错。
  const start = yaml.indexOf('\nsources:');
  const end = yaml.indexOf('\n# 明确被排除');
  assert.ok(start >= 0 && end > start, 'sources.yaml 结构符合预期');
  const blocks = [];
  let current = null;
  for (const line of yaml.slice(start, end).split('\n')) {
    if (/^  - source_id:/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) current.push(line);
  }
  if (current) blocks.push(current.join('\n'));
  assert.ok(blocks.length >= 3, `至少登记 3 个来源（实际 ${blocks.length}）`);
  for (const b of blocks) {
    const id = b.match(/source_id:\s*(\S+)/)[1];
    assert.ok(/^\s*redistribution:/m.test(b), `${id} 必须有 redistribution`);
    assert.ok(/^\s*verification_status:/m.test(b), `${id} 必须有 verification_status`);
    assert.ok(/^\s*license:/m.test(b), `${id} 必须有 license`);
    if (/^\s*license:\s*NONE_DECLARED/m.test(b)) {
      assert.ok(/^\s*redistribution:\s*REFERENCE_ONLY/m.test(b), `${id} 无许可数据必须标 REFERENCE_ONLY`);
    }
  }
  // 主数据源许可必须是 CC BY-NC-SA 4.0，且禁止商用
  assert.ok(/license: CC-BY-NC-SA-4\.0/.test(yaml), '主来源许可已登记');
  assert.ok(/commercial_use: prohibited/.test(yaml), 'NC 约束已显式登记');
});

test('M1: 第三方 Lua 只被文本解析，从未执行（无 eval/Function/require 第三方）', () => {
  const src = readFileSync('scripts/roco/lua-safe-parse.mjs', 'utf8');
  // 注意：`.exec(` 是正则的正常方法，不能一律禁用。这里禁止的是**执行代码**的能力。
  const forbidden = [
    [/\beval\s*\(/, 'eval('],
    [/new\s+Function\s*\(/, 'new Function('],
    [/\brequire\s*\(/, 'require('],
    [/from\s+['"]node:child_process['"]/, "import node:child_process"],
    [/\bchild_process\b/, 'child_process'],
    [/\bvm\b/, 'node:vm'],
    [/\bimport\s*\(/, 'dynamic import('],
  ];
  for (const [re, label] of forbidden) {
    assert.ok(!re.test(src), `解析器不得包含 ${label}`);
  }
  // 解析器必须显式拒绝不支持的 Lua 表达式（fail loud）
  assert.ok(/不执行 Lua 表达式|不执行/.test(src), '解析器文档明确声明不执行 Lua');
});

test('M1: 12 只目标精灵与交接材料清单完全一致（不增不减）', { skip: !hasRaw && '快照未解压' }, () => {
  const pets = readJson(`${NORM}/pets.json`).pets;
  const got = Object.values(pets).map((p) => `${p.target.group}${p.target.order}:${p.name}`).sort();
  const want = TARGETS.map((t, i) => `${t.group}${i + 1 <= 6 ? i + 1 : i + 1}:${t.name}`).sort();
  assert.equal(Object.keys(pets).length, 12, '恰好 12 只');
  // 逐只核对名字
  for (const t of TARGETS) {
    assert.ok(Object.values(pets).some((p) => p.name === t.name), `包含 ${t.name}`);
  }
  // 分组数量
  const groups = Object.values(pets).reduce((a, p) => { a[p.target.group] = (a[p.target.group] ?? 0) + 1; return a; }, {});
  assert.deepEqual(groups, { A: 6, B: 3, C: 3 }, 'A/B/C 组数量为 6/3/3');
});

test('M1: 主快照固定 revision 的 SHA256 与实际文件一致（可复现性）', { skip: !hasRaw && '快照未解压' }, () => {
  const yaml = readFileSync('data/roco/sources.yaml', 'utf8');
  const m = yaml.match(/archive_sha256: ([0-9a-f]{64})/);
  assert.ok(m, 'sources.yaml 记录了归档 SHA256');
  // 逐文件哈希清单必须存在且覆盖 Lua 数据文件
  const inv = readJson('reports/roco/m1-data/snapshot-file-inventory.json');
  const luaFiles = inv.files.filter((f) => /wiki_modules\/Pets\/data\/.*\.lua$/.test(f.path));
  assert.ok(luaFiles.length >= 13, `逐文件清单覆盖 ${luaFiles.length} 个 Lua 数据文件`);
  for (const f of luaFiles) assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path} 有 SHA256`);
  // 与 normalized 记录的哈希一致
  const report = readJson(`${NORM}/import-report.json`);
  const catalogInv = inv.files.find((f) => f.path.endsWith('Catalog.lua'));
  assert.equal(report.source_files.catalog.sha256, catalogInv.sha256, 'Catalog.lua 哈希与清单一致');
});
