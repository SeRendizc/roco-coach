#!/usr/bin/env node
// ── RC-202：GameDataPackV2（统一索引包）生成器 ───────────────────────────────
//
// 为什么需要它（RC-201 §9 的第 1/2/3/4/5/7/8 条）：
//   RC-201 只交付了「对账」这一半。三份产物形状各异——
//     `full-catalog.json`（`pets[]`）、`skills.json`（`skills{}` 字典）、
//     `public-index.json`（三张页各自的 `entities[]`）——没有任何一份能把
//     「精灵 / 形态 / 战斗技能 / 特性」放进**同一个命名空间**并**逐条**说清
//     「这条来自哪个文件的哪一行、按什么许可、哪些字段永远拿不到」。
//
// 本脚本产出两份东西：
//   ① `data/roco/game-data-pack/v2/schema.json` —— 自描述 schema（契约）。
//      `record_kind` 词表用 RC-201 报告里那份（写进 enum）；
//      `contains` / `does_not_contain`、不可得字段允许清单、许可策略、
//      冲突分类、形态轴词表**全部由 schema 声明**，校验器读 schema 而不是抄常量。
//   ② `data/roco/game-data-pack/v2/pack.json` —— 索引包本体。
//
// 三条不许越过的线：
//   · **只做索引**。id / 名字 / 形态标记 / 标签 / provenance / licence_ref /
//     与冻结层的 pointer。冻结层的大块数值（种族值、学招表、效果文本、威力）
//     **一律不抄进来**——抄进来就会出现第三份事实源，随后三份各自漂移。
//     大字段只给 `refs`（artifact_path + pointer），值仍在冻结目录里。
//   · **逐实体 provenance**。冻结侧过去只有「层内统一」的 provenance
//     （每只都指向同一个快照 + 同一个 sha256），这里补到
//     `{source_id, artifact_path, artifact_sha256, pointer}` 的逐条粒度，
//     与公网侧（page + url + html_sha256 + selector）**同一套结构**。
//   · **拿不到就写 unknown**。冻结侧快照里没有的字段进 `unknown_fields`，
//     公网索引页没有的字段进契约级 `does_not_contain`；两者都由校验器
//     对着磁盘**重算**，标错方向（有值却标 unknown / 缺了却漏报）都判红。
//
// 冲突与就绪：冲突分 `IDENTITY_CONFLICT` / `VALUE_CONFLICT` /
// `GRANULARITY_CONFLICT` 三类，RC-201 的 4 条 `unresolved` 与 61 组同名不同 id
// 逐条落条；**只要还有未解决冲突，就绪判定不得为 ready**（不是警告，是拒绝）。
//
// 可复跑：包内**不含**挂钟时间戳（时间只来自输入的 snapshot_date / revision_date），
// 同输入两次运行逐字节相同。`--check` 只重建并逐字节比对磁盘产物。
//
// 用法：
//   node scripts/roco/build-game-data-pack.mjs             # 生成 schema.json + pack.json
//   node scripts/roco/build-game-data-pack.mjs --check     # 只校验：重建结果必须与磁盘逐字节相同
//   node scripts/roco/build-game-data-pack.mjs --selftest  # ≥6 条反证：把包改坏，自检必须抓住

import {createHash} from 'node:crypto';
// 第 9 项的判据要**读闸门的登记表本身**（而不是靠人声明）。
// `verify-release.mjs` 只在作为入口时才执行跑套件，导入它是安全的。
import {SUITES as RELEASE_GATE_SUITES} from './verify-release.mjs';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  FROZEN_DIR,
  RECORD_KIND_VOCABULARY,
  ROOT,
  buildFrozenRecords,
  buildLiveRecords,
  entityKey,
  latestLiveSnapshotPath,
} from './reconcile-catalog.mjs';
import {parseSources} from './verify-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PACK_DIR = join(ROOT, 'data', 'roco', 'game-data-pack', 'v2');
export const SCHEMA_PATH = join(PACK_DIR, 'schema.json');
export const PACK_PATH = join(PACK_DIR, 'pack.json');
export const READINESS_PATH = join(ROOT, 'reports', 'roco', 'reconciliation', 'game-data-pack-readiness.json');
export const RECONCILIATION_PATH = join(ROOT, 'reports', 'roco', 'reconciliation', 'catalog-reconciliation.json');
export const SOURCES_PATH = join(ROOT, 'data', 'roco', 'sources.yaml');
export const RULESET_DIR = join(ROOT, 'data', 'roco', 'rulesets');
export const EVIDENCE_LEDGER_PATH = join(ROOT, 'data', 'roco', 'evidence', 'rule-evidence-ledger.json');

export const PACK_VERSION = 'roco-game-data-pack/v2';
export const PACK_ID = 'roco-game-data-pack-v2';

/**
 * `record_kind` 词表 —— **逐字**取自 RC-201 报告 `record_kind_vocabulary`
 * 里被逐条产物真正使用的那四个（`skill_record` 是文件级总称，不进 enum）。
 */
export const RECORD_KIND_ENUM = ['pet_record', 'pet_form', 'battle_skill', 'trait_record'];

/** 比较组 → 该组允许的 record_kind（身份键沿用 RC-201 的 `group::id`）。 */
export const GROUP_RECORD_KINDS = {
  pet: ['pet_record', 'pet_form'],
  battle_skill: ['battle_skill'],
  trait: ['trait_record'],
};

export const SOURCE_SCOPES = ['frozen_l1', 'live_bwiki'];

/**
 * 永远不可得的字段允许清单。它不是「以后再补」，而是这一层**必须显式承认**的空白：
 *   · traits / skill_timing / panel_formula / season_strength —— 来自
 *     `full-catalog.json#coverage.unknown_by_field`（622/622 全部 unknown）；
 *   · release —— 冻结快照里有 1 条形态记录没有上线日期（pet_000532）；
 *   · power —— `skills.json` 里 466/824 条 `power_status=not_provided_by_source`
 *     （**不等于 0 伤害**）。
 */
export const UNKNOWN_FIELDS_ALLOWLIST = Object.freeze([
  'traits', 'skill_timing', 'panel_formula', 'season_strength', 'release', 'power',
]);

/** 公网索引页**根本不存在**的字段（导航页只有卡片 + id + 名字 + 标签）。 */
export const LIVE_INDEX_MISSING_FIELDS = Object.freeze([
  'stats', 'learnset', 'release', 'class', 'feature_skill_id',
  'power', 'energy', 'damage_class', 'desc',
]);

/** 形态轴词表。「其它」是**显式残差桶**，「UNMAPPED」是**拒绝猜**的出口。 */
export const FORM_AXES = Object.freeze(['BASE', 'LORD', 'REGIONAL', 'MUTATION', 'OTHER', 'UNMAPPED']);

/**
 * 形态轴判定规则表（两侧都能映射到同一根轴）。
 *
 * 判据只认**可核对的字符串证据**：冻结侧看 `title` 的括号后缀，
 * 公网侧看 `data-form` 的取值。任何一侧出现词表外的取值一律
 * `UNMAPPED` + 原因——**不兜底成 OTHER**，因为"没见过的标注"和
 * "已知的非首领非地区非突变形态"是两件事。
 */
export const FORM_AXIS_RULES = Object.freeze([
  {rule_id: 'frozen.title.plain', when: '冻结 title === name（无括号后缀）', axis: 'BASE'},
  {rule_id: 'frozen.title.mutation', when: '冻结 title 后缀含「突变」', axis: 'MUTATION'},
  {rule_id: 'frozen.title.lord', when: '冻结 title 后缀含「首领」', axis: 'LORD'},
  {rule_id: 'frozen.title.regional', when: '冻结 title 后缀含「地区」', axis: 'REGIONAL'},
  {rule_id: 'frozen.title.residual', when: '冻结 title 有括号后缀，但不是首领/地区/突变关键词', axis: 'OTHER'},
  {rule_id: 'live.form.main', when: '公网 data-form === main', axis: 'BASE'},
  {rule_id: 'live.form.lord', when: '公网 data-form 含 lord', axis: 'LORD'},
  {rule_id: 'live.form.regional', when: '公网 data-form 含 regional', axis: 'REGIONAL'},
  {rule_id: 'union.any_non_base', when: '任一来源标为非基础 ⇒ 取该轴（并集；两侧都非基础时取公网轴，另一个进 secondary_axes）', axis: '(来自证据)'},
  {rule_id: 'unknown.token', when: '任一来源出现词表外的形态标注', axis: 'UNMAPPED'},
]);

/** 冲突分类（RC-201 §9 第 4 条点名要求的三类）。 */
export const CONFLICT_CLASSES = Object.freeze({
  IDENTITY_CONFLICT: '同一名字对应不同 id（或同一 id 对应不同名字）：**身份**本身有歧义，按名字对齐会合并两个不同的东西。本轮样本：RC-201 的 4 条 unresolved + 61 组同组同名不同 id。',
  VALUE_CONFLICT: '同一 id 的**字段值**在两侧不一致。本轮**为 0** —— 这不是"没有差异"，是"没比过"：公网索引页没有种族值/学招表/效果文本，所以没有任何值可逐条比（见 field_coverage_matrix）。',
  GRANULARITY_CONFLICT: '两侧对"这条算不算一条独立记录"口径不同（形态粒度）。本轮样本：RC-201 的 34 条 convention_notes（冻结 pet_record vs 公网 pet_form）。',
});

export const CONFLICT_STATUSES = Object.freeze([
  'UNRESOLVED', 'RESOLVED_BY_POLICY', 'RESOLVED_BY_FORM_AXIS',
]);

/** 冲突的解决口径（可机读）。 */
export const CONFLICT_RESOLUTIONS = Object.freeze({
  IDENTITY_KEY_IS_GROUP_PLUS_ID: '身份 = 比较组 + id，名字不参与对齐；因此"同名不同 id"各自独立成条，不合并（RC-201 已按此判定）。',
  FORM_AXIS_UNION_TABLE: '形态标注取两侧**并集**（任一来源标为非基础即非基础），逐条落 form_axis.assignments；轴未知则 UNMAPPED。',
});

/** 允许标记为「可比」的字段白名单（**不许**出现任何值字段）。 */
export const COMPARABLE_FIELD_ALLOWLIST = Object.freeze(['id', 'name', 'number', 'type', 'element']);

/** RC-201 §9 的 9 项「从 draft → ready 还缺什么」。satisfied 由校验器逐项算出。 */
export const READINESS_ITEMS = Object.freeze([
  {id: 1, key: 'unified_schema', title: '统一 schema',
    missing: '三份不同形状的产物没有同一命名空间契约',
    done_when: '带版本号 / 字段级必填声明的 schema；record_kind 词表进 enum；同一份校验器同时校验冻结产物与派生快照',
    evaluator: 'mechanism', check: 'readiness.unified_schema'},
  {id: 2, key: 'licence_per_entity', title: '许可逐条落到实体',
    missing: '具体到某一条实体没有机器可读的许可字段',
    done_when: '每条带 licence_ref 且能解析到 sources.yaml；REFERENCE_ONLY 的来源不得进入可分发分节',
    evaluator: 'mechanism', check: 'readiness.licence_per_entity'},
  {id: 3, key: 'per_entity_provenance', title: '逐实体 provenance',
    missing: '冻结侧只有层内统一 provenance，与公网侧粒度不对等',
    done_when: '两侧都补到 {source_id, artifact_path, artifact_sha256, pointer} 的逐条粒度，且 sha256 与磁盘一致',
    evaluator: 'mechanism', check: 'readiness.per_entity_provenance'},
  {id: 4, key: 'conflict_policy', title: '冲突处理策略',
    missing: '只有 conflicts.jsonl 与「不合并、如实记」的纪律，没有可执行的仲裁规则',
    done_when: '写明 IDENTITY_CONFLICT / VALUE_CONFLICT / GRANULARITY_CONFLICT 的判定；冲突未解决时**拒绝**产出 ready',
    evaluator: 'mechanism', check: 'readiness.conflict_policy'},
  {id: 5, key: 'form_axis', title: '形态（pet_form）口径统一',
    missing: '两侧对「这条算不算形态」有 34 条标注不一致',
    done_when: '一份两侧都能映射到「基础/首领/地区/突变/其它」的对照表，34 条不一致逐条落表',
    evaluator: 'mechanism', check: 'readiness.form_axis'},
  {id: 6, key: 'field_level_coverage', title: '覆盖证明（不只是计数）',
    missing: '没有证明「同 id 的内容一致」——只比了名字、编号、属性标签；种族值、可学技能、效果文本都没比',
    done_when: '两份产物在字段级比一遍（带容差与「快照没有这个字段」的显式分支），逐字段给出覆盖率与冲突数',
    evaluator: 'static_false',
    reason: '字段级矩阵已产出（逐字段覆盖率 + 不可比分支），但**有实质价值的一致性证明仍不成立**：'
      + '种族值 / 学招表 / 效果文本 / 静态威力在公网索引页里**不存在**，逐条判据只能到 '
      + 'NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD。要真正做完，需要一份**数据导出**来源'
      + '（详情页或官方导出），本轮没有。因此此项按「能不能证明数值一致」判定为 false。'},
  {id: 7, key: 'version_freshness', title: '版本/新鲜度字段',
    missing: '公网快照与冻结 ruleset 之间没有显式绑定',
    done_when: '包带 ruleset_id + as_of；跨来源时间一致性有守卫（公网快照日期早于冻结 revision 日期 ⇒ STALE）',
    evaluator: 'mechanism', check: 'readiness.version_freshness'},
  {id: 8, key: 'unavailable_fields', title: '不可得字段的显式清单',
    missing: '没有契约级的「本包含什么、不含什么」',
    done_when: '包显式声明 contains / does_not_contain 与不可得字段允许清单，并在消费侧 fail closed',
    evaluator: 'mechanism', check: 'readiness.unavailable_fields'},
  {id: 9, key: 'reconciliation_in_release_gate', title: '对账自动化进闸门',
    missing: '本次是手工触发脚本',
    done_when: '把 fetch --check --offline + reconcile + 判据进 verify-release.mjs 的登记表',
    // **不再是 static_false**：主线程已经接线，判据改成「闸门登记表里真的存在这两条套件」。
    // 这一条比「人声明已接线」强：把套件从 SUITES 里删掉，这一项立刻变 false、状态退回 draft。
    evaluator: 'release_gate_registry',
    requires_suites: ['reconciliation', 'game-data-pack']},
]);

/**
 * 第 9 项的**纯判据**：闸门登记表里是否真的存在要求的套件。
 *
 * 抽成纯函数是为了让测试能直接反证（构造一份缺少 `game-data-pack` 的登记表 ⇒ 必须 false），
 * 而不是只断言「当前这份报告写着 true」。
 */
export function releaseGateSatisfied({suites = [], requires = []} = {}) {
  const ids = (suites ?? []).map((s) => (typeof s === 'string' ? s : s?.id));
  const missing = (requires ?? []).filter((w) => !ids.includes(w));
  return {satisfied: missing.length === 0, missing, present: (requires ?? []).filter((w) => ids.includes(w)), ids};
}

// ── 小工具 ────────────────────────────────────────────────────────────────

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function rel(path) {
  return relative(ROOT, path);
}

function fileInfo(path, sourceId) {
  const bytes = readFileSync(path);
  return {path: rel(path), sha256: sha256Bytes(bytes), bytes: bytes.length, source_id: sourceId};
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/** 括号后缀：`幽影树（突变的样子）` → `突变的样子`。没有后缀返回 null。 */
function titleSuffix(title) {
  const m = /[（(]([^（()）]*)[)）]\s*$/u.exec(String(title ?? ''));
  return m ? m[1] : null;
}

// ── 形态轴 ────────────────────────────────────────────────────────────────

/** 冻结侧：从 title 后缀推轴。**只看关键词**，其余进 OTHER（显式残差桶）。 */
export function formAxisFromFrozen(record) {
  if (!record || record.record_kind === undefined) return {axis: 'UNMAPPED', rule_ids: ['unknown.token'], reason: '冻结侧没有这条记录'};
  const isForm = record.attributes?.form_marker === 'frozen:title!=name';
  if (!isForm) return {axis: 'BASE', rule_ids: ['frozen.title.plain'], reason: null};
  const suffix = titleSuffix(record.title) ?? '';
  if (suffix.includes('突变')) return {axis: 'MUTATION', rule_ids: ['frozen.title.mutation'], reason: null};
  if (suffix.includes('首领')) return {axis: 'LORD', rule_ids: ['frozen.title.lord'], reason: null};
  if (suffix.includes('地区')) return {axis: 'REGIONAL', rule_ids: ['frozen.title.regional'], reason: null};
  return {
    axis: 'OTHER',
    rule_ids: ['frozen.title.residual'],
    reason: `冻结 title 后缀「${suffix}」不是首领/地区/突变关键词；归入其它（残差桶），不猜具体轴。`,
  };
}

/** 公网侧：从 `data-form` 推轴。词表外取值一律 UNMAPPED（fail closed）。 */
export function formAxisFromLive(record) {
  if (!record) return {axis: null, rule_ids: [], reason: null};
  const raw = record.attributes?.form;
  if (raw === undefined || raw === null || raw === '') {
    return {axis: 'UNMAPPED', rule_ids: ['unknown.token'], reason: '公网卡片没有 data-form 字段，无法判定形态轴。'};
  }
  const tokens = String(raw).split('|').map((t) => t.trim()).filter(Boolean);
  const known = new Set(['main', 'lord', 'regional']);
  const unknownTokens = tokens.filter((t) => !known.has(t));
  if (!tokens.length || unknownTokens.length) {
    return {
      axis: 'UNMAPPED',
      rule_ids: ['unknown.token'],
      reason: `公网 data-form 取值 ${JSON.stringify(raw)} 含词表外标记 ${JSON.stringify(unknownTokens)}；不猜，记 UNMAPPED。`,
    };
  }
  const axes = [];
  const rules = [];
  if (tokens.includes('lord')) { axes.push('LORD'); rules.push('live.form.lord'); }
  if (tokens.includes('regional')) { axes.push('REGIONAL'); rules.push('live.form.regional'); }
  if (tokens.includes('main')) { axes.push('BASE'); rules.push('live.form.main'); }
  const primary = axes.find((a) => a !== 'BASE') ?? 'BASE';
  return {axis: primary, all_axes: axes, rule_ids: rules, reason: null};
}

/** 并集规则：两侧合起来算一根轴 + 次要轴。 */
export function mergeFormAxis(frozenAxis, liveAxis) {
  const parts = [frozenAxis, liveAxis].filter(Boolean);
  const unmapped = parts.find((p) => p.axis === 'UNMAPPED');
  if (unmapped) {
    return {
      axis: 'UNMAPPED',
      secondary_axes: [],
      rule_ids: sortedUnique([...parts.flatMap((p) => p.rule_ids ?? []), 'unknown.token']),
      reasons: parts.map((p) => p.reason).filter(Boolean),
    };
  }
  const nonBase = parts.filter((p) => p.axis && p.axis !== 'BASE');
  if (!nonBase.length) {
    return {
      axis: 'BASE',
      secondary_axes: [],
      rule_ids: sortedUnique(parts.flatMap((p) => p.rule_ids ?? [])),
      reasons: [],
    };
  }
  const live = liveAxis && liveAxis.axis && liveAxis.axis !== 'BASE' ? liveAxis : null;
  const primary = live ? live : nonBase[0];
  const secondary = sortedUnique(nonBase
    .filter((p) => p.axis !== primary.axis)
    .flatMap((p) => (p.all_axes ?? [p.axis]).filter((a) => a && a !== primary.axis)));
  return {
    axis: primary.axis,
    secondary_axes: secondary,
    rule_ids: sortedUnique([...parts.flatMap((p) => p.rule_ids ?? []), 'union.any_non_base']),
    reasons: parts.map((p) => p.reason).filter(Boolean),
  };
}

// ── 输入 ──────────────────────────────────────────────────────────────────

export function loadPackInputs({livePath = null} = {}) {
  const catalogPath = join(FROZEN_DIR, 'full-catalog.json');
  const skillsPath = join(FROZEN_DIR, 'skills.json');
  const learnsetsPath = join(FROZEN_DIR, 'learnsets.json');
  for (const path of [catalogPath, skillsPath, learnsetsPath, SOURCES_PATH, RECONCILIATION_PATH]) {
    if (!existsSync(path)) throw new Error(`缺输入 ${rel(path)}：GameDataPackV2 不能在没有它的情况下生成`);
  }
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const skills = JSON.parse(readFileSync(skillsPath, 'utf8'));
  const learnsets = JSON.parse(readFileSync(learnsetsPath, 'utf8'));
  const reconciliation = JSON.parse(readFileSync(RECONCILIATION_PATH, 'utf8'));
  const sourcesText = readFileSync(SOURCES_PATH, 'utf8');
  const sources = parseSources(sourcesText);
  const target = livePath || latestLiveSnapshotPath();
  if (!target || !existsSync(target)) {
    throw new Error('缺公网快照 data/roco/live/<date>/public-index.json：先跑 node scripts/roco/fetch-live-snapshot.mjs');
  }
  const liveSnapshot = JSON.parse(readFileSync(target, 'utf8'));
  return {
    catalog, skills, learnsets, reconciliation, sources,
    catalogPath, skillsPath, learnsetsPath,
    liveSnapshot, livePath: target,
  };
}

/** ruleset 配置：从 data/roco/rulesets/*.json 里读，优先 `is_default: true`。 */
export function loadRulesetConfig() {
  const names = ['mobile-s4-candidate-v2.json', 'legacy-sim-v1.json']
    .filter((n) => existsSync(join(RULESET_DIR, n)));
  if (!names.length) throw new Error(`找不到任何 ruleset 配置：${rel(RULESET_DIR)}`);
  const configs = names.map((n) => JSON.parse(readFileSync(join(RULESET_DIR, n), 'utf8')));
  const chosen = configs.find((c) => c.is_default === true) ?? configs[0];
  const path = join(RULESET_DIR, names[configs.indexOf(chosen)]);
  return {config: chosen, path, all: configs.map((c, i) => ({id: c.ruleset_config_id, path: rel(join(RULESET_DIR, names[i])), is_default: c.is_default === true, status: c.status}))};
}

// ── schema ────────────────────────────────────────────────────────────────

/** 自描述 schema：JSON Schema（2020-12 子集）+ `x-roco-*` 契约级声明。 */
export function buildSchema() {
  const provenanceDef = {
    type: 'object',
    required: ['source_id', 'artifact_path', 'artifact_sha256', 'pointer'],
    additionalProperties: false,
    properties: {
      source_id: {type: 'string', pattern: '^[A-Za-z0-9._-]+$'},
      artifact_path: {type: 'string', pattern: '^[^/].+$'},
      artifact_sha256: {type: 'string', pattern: '^[0-9a-f]{64}$'},
      pointer: {type: 'string', pattern: '^[A-Za-z0-9_.[\\]-]+$'},
      source_scope: {type: 'string', enum: SOURCE_SCOPES},
      page: {type: 'string'},
      selector: {type: 'string'},
    },
  };
  const entityDef = {
    type: 'object',
    required: ['entity_key', 'id', 'group', 'record_kind', 'name', 'title', 'source_scope',
      'form_axis', 'tags', 'licence_ref', 'provenance', 'refs', 'unknown_fields'],
    additionalProperties: false,
    properties: {
      entity_key: {type: 'string', pattern: '^[a-z_]+::[A-Za-z0-9_]+$'},
      id: {type: 'string'},
      group: {type: 'string', enum: Object.keys(GROUP_RECORD_KINDS)},
      record_kind: {type: 'string', enum: RECORD_KIND_ENUM},
      record_kind_divergence: {type: 'object'},
      name: {type: 'string'},
      title: {type: ['string', 'null']},
      source_scope: {type: 'string', enum: SOURCE_SCOPES},
      form_axis: {
        type: 'object',
        required: ['axis', 'secondary_axes', 'rule_ids'],
        additionalProperties: false,
        properties: {
          axis: {type: 'string', enum: FORM_AXES},
          secondary_axes: {type: 'array', items: {type: 'string', enum: FORM_AXES}},
          rule_ids: {type: 'array', items: {type: 'string'}},
          divergence: {type: 'boolean'},
          reasons: {type: 'array', items: {type: 'string'}},
        },
      },
      tags: {type: 'object'},
      tags_live: {type: 'object'},
      licence_ref: {type: 'string', pattern: '^[A-Za-z0-9._-]+$'},
      provenance: {type: 'array', minItems: 1, items: {$ref: '#/$defs/provenance'}},
      refs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'artifact_path', 'pointer'],
          additionalProperties: false,
          properties: {
            field: {type: 'string'},
            artifact_path: {type: 'string'},
            pointer: {type: 'string'},
          },
        },
      },
      unknown_fields: {type: 'array', items: {type: 'string'}},
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PACK_VERSION}/schema.json`,
    title: 'GameDataPackV2',
    description: '《洛克王国：世界》手游 GameDataPackV2 —— 统一索引包契约。'
      + '本 schema 是**自描述**的：record_kind 词表、逐实体必填字段、许可与来源策略、'
      + '不可得字段允许清单、契约级 contains / does_not_contain 全部由本文件声明；'
      + '校验器读本文件，而不是把常量再抄一份到代码里。',
    schema_version: PACK_VERSION,
    type: 'object',
    required: ['schema_version', 'pack_id', 'metadata', 'ruleset_binding', 'freshness',
      'contract', 'unknown_fields_allowlist', 'unknown_fields_scope', 'artifacts',
      'source_registry', 'sections', 'conflicts', 'form_axis', 'field_coverage_matrix', 'readiness'],
    additionalProperties: false,
    properties: {
      schema_version: {type: 'string', const: PACK_VERSION},
      pack_id: {type: 'string', const: PACK_ID},
      metadata: {type: 'object'},
      ruleset_binding: {type: 'object'},
      freshness: {type: 'object'},
      contract: {
        type: 'object',
        required: ['contains', 'does_not_contain'],
        additionalProperties: false,
        properties: {
          contains: {type: 'array', minItems: 1, items: {type: 'object'}},
          does_not_contain: {type: 'array', minItems: 1, items: {type: 'object'}},
        },
      },
      unknown_fields_allowlist: {type: 'array', minItems: 1, items: {type: 'string'}},
      unknown_fields_scope: {type: 'object'},
      artifacts: {type: 'object'},
      source_registry: {type: 'array', minItems: 1, items: {type: 'object'}},
      sections: {
        type: 'object',
        required: ['distributable', 'reference_only'],
        additionalProperties: false,
        properties: {
          distributable: {
            type: 'object',
            required: ['definition', 'entities'],
            additionalProperties: false,
            properties: {
              definition: {type: 'string'},
              entities: {type: 'array', items: {$ref: '#/$defs/entity'}},
            },
          },
          reference_only: {
            type: 'object',
            required: ['definition', 'entities', 'note'],
            additionalProperties: false,
            properties: {
              definition: {type: 'string'},
              note: {type: 'string'},
              entities: {type: 'array', items: {$ref: '#/$defs/entity'}},
            },
          },
        },
      },
      conflicts: {
        type: 'object',
        required: ['classes', 'resolution_policy', 'total', 'unresolved', 'items'],
        additionalProperties: false,
        properties: {
          classes: {type: 'object'},
          resolution_policy: {type: 'object'},
          total: {type: 'integer', minimum: 0},
          unresolved: {type: 'integer', minimum: 0},
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['conflict_id', 'class', 'status', 'entity_keys', 'evidence', 'reason', 'source_ref'],
              additionalProperties: true,
              properties: {
                conflict_id: {type: 'string'},
                class: {type: 'string', enum: Object.keys(CONFLICT_CLASSES)},
                status: {type: 'string', enum: CONFLICT_STATUSES},
                resolution: {type: ['string', 'null']},
                entity_keys: {type: 'array', minItems: 1, items: {type: 'string'}},
                evidence: {type: 'array', minItems: 1, items: {type: 'object'}},
                reason: {type: 'string'},
                source_ref: {type: 'string'},
              },
            },
          },
        },
      },
      form_axis: {
        type: 'object',
        required: ['axes', 'rules', 'assignments', 'counts'],
        additionalProperties: false,
        properties: {
          axes: {type: 'array', minItems: 1, items: {type: 'object'}},
          rules: {type: 'array', minItems: 1, items: {type: 'object'}},
          assignments: {type: 'array', items: {type: 'object'}},
          counts: {type: 'object'},
        },
      },
      field_coverage_matrix: {
        type: 'object',
        required: ['rows', 'comparable_field_allowlist', 'verdict_vocabulary'],
        additionalProperties: false,
        properties: {
          rows: {type: 'array', minItems: 1, items: {type: 'object'}},
          comparable_field_allowlist: {type: 'array', items: {type: 'string'}},
          verdict_vocabulary: {type: 'object'},
        },
      },
      readiness: {
        type: 'object',
        required: ['game_data_pack_v2_status', 'conflict_gate', 'satisfied_count', 'total_items', 'items', 'blocking'],
        additionalProperties: false,
        properties: {
          game_data_pack_v2_status: {type: 'string', enum: ['draft', 'ready']},
          conflict_gate: {type: 'string'},
          satisfied_count: {type: 'integer', minimum: 0},
          total_items: {type: 'integer', minimum: 1},
          items: {type: 'array', minItems: 1, items: {type: 'object'}},
          blocking: {type: 'array', items: {type: 'object'}},
        },
      },
    },
    'x-roco-contract': {
      record_kind_enum: RECORD_KIND_ENUM,
      record_kind_vocabulary: RECORD_KIND_VOCABULARY,
      required_entity_fields: ['entity_key', 'record_kind', 'name', 'provenance', 'licence_ref', 'source_scope'],
      required_provenance_fields: ['source_id', 'artifact_path', 'artifact_sha256', 'pointer'],
      source_scope_enum: SOURCE_SCOPES,
      unknown_fields_allowlist: UNKNOWN_FIELDS_ALLOWLIST,
      unknown_fields_scope: unknownFieldsScope(),
      live_index_missing_fields: LIVE_INDEX_MISSING_FIELDS,
      comparable_field_allowlist: COMPARABLE_FIELD_ALLOWLIST,
      distribution_classes: {
        distributable: '逐条来源的 license/redistribution 都不是 REFERENCE_ONLY，可以随包分发（主快照 CC-BY-NC-SA-4.0 / 署名-非商业-相同方式共享，必须署名）。',
        reference_only: '至少一条逐条来源的 redistribution === REFERENCE_ONLY：**不得**进入任何可分发产物，只在本仓库内部核对。',
      },
      conflict_classes: CONFLICT_CLASSES,
      conflict_resolution: CONFLICT_RESOLUTIONS,
      form_axis_enum: FORM_AXES,
      form_axis_rules: FORM_AXIS_RULES,
      ruleset_binding_required: ['ruleset_id', 'ruleset_config_id', 'ruleset_config_path', 'as_of',
        'evidence_ledger_path', 'evidence_ledger_sha256', 'reconciliation_report_path', 'reconciliation_report_sha256'],
      ready_gate: 'game_data_pack_v2_status === "ready" 当且仅当 9 项全部 satisfied **且** conflicts.unresolved === 0 **且** freshness.status !== "STALE"。',
    },
    $defs: {provenance: provenanceDef, entity: entityDef},
  };
}

function unknownFieldsScope() {
  return {
    frozen_l1: {
      pet_record: ['traits', 'skill_timing', 'panel_formula', 'season_strength'],
      pet_form: ['traits', 'skill_timing', 'panel_formula', 'season_strength'],
      battle_skill: ['power'],
      trait_record: ['power'],
      conditional: {
        release: '该精灵在冻结快照里没有上线日期（实测 1 条：pet_000532）。',
      },
    },
    live_bwiki: {
      '*': [],
      note: '公网索引页是导航页，它缺失的字段是**契约级**的（见 contract.does_not_contain），不逐条进 unknown_fields。',
    },
  };
}

// ── 实体 ──────────────────────────────────────────────────────────────────

/**
 * 逐实体重算「不可得字段」——**从冻结产物本身推**，不抄它自己写的 unknown_fields。
 * 这样「有值却标 unknown」与「缺了却漏报」两个方向都能被校验器抓住。
 */
export function expectedUnknownFields({rawPet, rawSkill, recordKind}) {
  if (recordKind === 'battle_skill' || recordKind === 'trait_record') {
    return rawSkill && rawSkill.power === null ? ['power'] : [];
  }
  const unknown = ['traits', 'skill_timing', 'panel_formula', 'season_strength'];
  if (rawPet && (rawPet.release === null || rawPet.release === undefined)) unknown.unshift('release');
  if (rawPet && (rawPet.types === null || rawPet.types === undefined)) unknown.push('types');
  if (rawPet && (rawPet.stats === null || rawPet.stats === undefined)) unknown.push('stats');
  if (rawPet && (rawPet.learnable_skills === null || rawPet.learnable_skills === undefined)) unknown.push('learnset');
  return unknown;
}

function tagsForFrozenPet(raw) {
  const tags = {};
  if (raw.number !== undefined && raw.number !== null) tags.number = String(raw.number);
  if (Number.isInteger(raw.game_id)) tags.game_id = raw.game_id;
  if (raw.class !== undefined && raw.class !== null) tags.class = raw.class;
  if (Number.isInteger(raw.stage)) tags.stage = raw.stage;
  if (Array.isArray(raw.types)) tags.types = [...raw.types];
  return tags;
}

function tagsForFrozenSkill(raw) {
  const tags = {};
  if (Number.isInteger(raw.game_id)) tags.game_id = raw.game_id;
  if (raw.category !== undefined && raw.category !== null) tags.category = raw.category;
  if (raw.element !== undefined && raw.element !== null) tags.element = raw.element;
  if (raw.is_trait === true) tags.is_trait = true;
  return tags;
}

function tagsForLive(raw, pageKey) {
  const tags = {};
  for (const key of ['number', 'stage', 'form', 'season', 'type', 'element', 'category', 'tags']) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    tags[key] = value;
  }
  if (pageKey === 'trait-index') {
    if (raw.primary_type) tags.primary_type = raw.primary_type;
    if (raw.secondary_type) tags.secondary_type = raw.secondary_type;
  }
  return tags;
}

/** 冻结侧 refs：**只给指针，不抄值**。字段值缺失时进 unknown_fields，不进 refs。 */
function refsForFrozenPet(raw, pointerBase, catalogRel) {
  const refs = [];
  if (raw.stats) refs.push({field: 'stats', artifact_path: catalogRel, pointer: `${pointerBase}.stats`});
  if (Array.isArray(raw.learnable_skills) && raw.learnable_skills.length) {
    refs.push({field: 'learnable_skills', artifact_path: catalogRel, pointer: `${pointerBase}.learnable_skills`});
  }
  if (raw.release) refs.push({field: 'release', artifact_path: catalogRel, pointer: `${pointerBase}.release`});
  if (raw.feature_skill_id) {
    refs.push({field: 'feature_skill_id', artifact_path: catalogRel, pointer: `${pointerBase}.feature_skill_id`});
  }
  return refs;
}

function refsForFrozenSkill(raw, pointerBase, skillsRel) {
  const refs = [];
  if (raw.power !== null && raw.power !== undefined) refs.push({field: 'power', artifact_path: skillsRel, pointer: `${pointerBase}.power`});
  if (raw.energy !== null && raw.energy !== undefined) refs.push({field: 'energy', artifact_path: skillsRel, pointer: `${pointerBase}.energy`});
  if (raw.damage_class !== null && raw.damage_class !== undefined) refs.push({field: 'damage_class', artifact_path: skillsRel, pointer: `${pointerBase}.damage_class`});
  if (raw.desc !== null && raw.desc !== undefined) refs.push({field: 'desc', artifact_path: skillsRel, pointer: `${pointerBase}.desc`});
  if (raw.flavor !== null && raw.flavor !== undefined) refs.push({field: 'flavor', artifact_path: skillsRel, pointer: `${pointerBase}.flavor`});
  return refs;
}

// ── 冲突 ──────────────────────────────────────────────────────────────────

export function buildConflicts({reconciliation, reportSha, catalogSha, skillsSha, formAxisById, entityKeys}) {
  const items = [];
  const reportRef = (pointer) => ({
    kind: 'reconciliation_report',
    path: rel(RECONCILIATION_PATH),
    sha256: reportSha,
    pointer,
  });

  // ① RC-201 的 unresolved（4 条身份歧义）——**未解决**，挡住 ready。
  reconciliation.buckets.unresolved.forEach((entry, index) => {
    const secondary = entry.record_kind === 'pet_form' ? ['GRANULARITY_CONFLICT'] : [];
    const frozenSha = entry.evidence?.file?.includes('skills.json') ? skillsSha : catalogSha;
    const evidence = [reportRef(`buckets.unresolved[${index}]`)];
    if (entry.evidence?.file) {
      evidence.push({
        kind: 'frozen_file',
        path: entry.evidence.file,
        artifact_sha256: frozenSha,
        pointer: entry.evidence.pointer,
      });
    }
    for (const live of entry.evidence?.counterpart_ids ?? []) void live;
    const liveEvidence = (entry.evidence && entry.evidence.kind === 'web_page') ? entry.evidence : null;
    if (liveEvidence) {
      evidence.push({
        kind: 'live_page',
        page: liveEvidence.page,
        url: liveEvidence.url,
        html_sha256: liveEvidence.html_sha256,
        selector: liveEvidence.selector,
      });
    }
    items.push({
      conflict_id: `CF-UNRESOLVED-${String(index + 1).padStart(4, '0')}`,
      class: 'IDENTITY_CONFLICT',
      secondary_classes: secondary,
      status: 'UNRESOLVED',
      resolution: null,
      entity_keys: [entityKey(entry.group, entry.id)],
      counterpart_ids: entry.counterpart_ids ?? [],
      name: entry.name,
      ambiguity: entry.ambiguity ?? null,
      evidence,
      reason: entry.reason,
      source_ref: `catalog-reconciliation.json#buckets.unresolved[${index}]`,
    });
  });

  // ② 61 组同名不同 id —— 记录在案，按 id 对齐的**已裁定**策略处理，不是未解决。
  reconciliation.name_collision_diagnostics.groups.forEach((group, index) => {
    items.push({
      conflict_id: `CF-NAMECOLLISION-${String(index + 1).padStart(4, '0')}`,
      class: 'IDENTITY_CONFLICT',
      secondary_classes: [],
      status: 'RESOLVED_BY_POLICY',
      resolution: 'IDENTITY_KEY_IS_GROUP_PLUS_ID',
      entity_keys: group.ids.filter((id) => entityKeys.has(entityKey(group.group, id))).map((id) => entityKey(group.group, id)),
      name: group.normalized_name,
      ids: group.ids,
      evidence: [reportRef(`name_collision_diagnostics.groups[${index}]`)],
      reason: `公网侧同组内归一化同名但 id 不同的 ${group.count} 条。身份按 id 走，所以它们各自独立对齐；`
        + '这一段用来证明「按名字对齐会把不同形态并起来」，不是"已合并"。',
      source_ref: `catalog-reconciliation.json#name_collision_diagnostics.groups[${index}]`,
    });
  });

  // ③ 34 条形态口径不一致 —— 由形态轴对照表逐条裁定。
  reconciliation.convention_notes.items.forEach((note, index) => {
    const axis = formAxisById.get(note.id) ?? null;
    const resolved = axis !== null && axis !== undefined && axis !== 'UNMAPPED';
    items.push({
      conflict_id: `CF-FORM-${String(index + 1).padStart(4, '0')}`,
      class: 'GRANULARITY_CONFLICT',
      secondary_classes: [],
      status: resolved ? 'RESOLVED_BY_FORM_AXIS' : 'UNRESOLVED',
      resolution: resolved ? 'FORM_AXIS_UNION_TABLE' : null,
      entity_keys: [entityKey('pet', note.id)],
      name: note.name,
      frozen_kind: note.frozen_kind,
      live_kind: note.live_kind,
      form_axis: axis,
      evidence: [reportRef(`convention_notes.items[${index}]`)],
      reason: resolved
        ? `两侧形态标注不同（冻结 ${note.frozen_kind} / 公网 ${note.live_kind}）；按 form_axis 并集规则裁定为 ${axis}。`
        : `两侧形态标注不同，且形态轴无法映射（UNMAPPED）：${note.note}`,
      source_ref: `catalog-reconciliation.json#convention_notes.items[${index}]`,
    });
  });

  return {
    classes: CONFLICT_CLASSES,
    resolution_policy: CONFLICT_RESOLUTIONS,
    total: items.length,
    unresolved: items.filter((i) => i.status === 'UNRESOLVED').length,
    items,
  };
}

// ── 字段级覆盖矩阵 ────────────────────────────────────────────────────────

const VERDICT_VOCABULARY = {
  COMPARABLE_PUBLIC_INDEX_HAS_FIELD: '两侧都有该字段，且逐条可对齐（同 id 的实体在两侧都存在）。',
  NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD: '公网索引页**根本没有**这个字段（它是导航页，不是数据导出）。',
  NOT_COMPARABLE_REPRESENTATION_MISMATCH: '两侧都有该字段，但表示/覆盖率不同（类型、空值口径），逐条相等不成立。',
  NOT_COMPARABLE_GRANULARITY_MISMATCH: '两侧粒度不同（例：冻结把物攻/魔攻合并成「攻击」，公网分成两个值）。',
  NOT_COMPARABLE_FROZEN_PLACEHOLDER: '冻结侧该字段是占位值（例：245 条特性的 element 全是「无系别」）。',
  NOT_COMPARABLE_NO_FROZEN_COUNTERPART: '公网侧有、冻结侧没有对应字段。',
};

const stripSuffix = (v) => String(v ?? '').replace(/系/g, '');

/** 字段级矩阵的字段清单（**手写规格、自动取值**，数字必须从真实数据算出来）。 */
const COVERAGE_SPECS = [
  {group: 'pet', field: 'id', frozen: (p) => p.pet_id, live: (l) => l.id, compare: (a, b) => a === b,
    reason: '身份字段：两侧都逐条给 id。'},
  {group: 'pet', field: 'name', frozen: (p) => p.name, live: (l) => l.name, compare: (a, b) => a === b,
    reason: '名字逐条可比（但名字**不参与身份**，见 conflicts）。'},
  {group: 'pet', field: 'number', frozen: (p) => p.number, live: (l) => l.number, compare: (a, b) => String(a) === String(b),
    reason: '图鉴编号逐条可比（两侧都是字符串）。'},
  {group: 'pet', field: 'type', frozen: (p) => (p.types ?? []).join('|'), live: (l) => l.type ?? '', compare: (a, b) => stripSuffix(a) === stripSuffix(b),
    normalization: '剥掉「系」字后按 | 拼接比较（冻结「光系|草系」vs 公网「光|草」）。',
    reason: '属性标签逐条可比（这是「能比的四个字段」之一）。'},
  {group: 'pet', field: 'stage', frozen: (p) => p.stage, live: (l) => l.stage, compare: (a, b) => String(a) === String(b),
    reason: '两侧都有，但冻结是整数分级、公网是字符串且 64/621 条为空串 —— 表示与覆盖率不同，逐条相等不成立（**没有**把它当可比）。'},
  {group: 'pet', field: 'form_marker', frozen: (p) => (p.title !== p.name ? 'form' : 'base'), live: (l) => (l.form && l.form !== 'main' ? 'form' : 'base'),
    compare: (a, b) => a === b,
    reason: '两侧对「这条算不算形态」口径不同（RC-201 的 34 条 convention_notes）；差异已逐条落 conflicts 与 form_axis，**不**计入可比字段。'},
  {group: 'pet', field: 'class', frozen: (p) => p.class, live: () => undefined, compare: () => false,
    reason: '公网索引页没有「类」（猫咪类精灵等）。'},
  {group: 'pet', field: 'stats', frozen: (p) => p.stats, live: () => undefined, compare: () => false,
    reason: '公网索引页没有种族值。'},
  {group: 'pet', field: 'learnset', frozen: (p) => p.learnable_skills, live: () => undefined, compare: () => false,
    reason: '公网索引页没有可学技能表。'},
  {group: 'pet', field: 'release', frozen: (p) => p.release, live: () => undefined, compare: () => false,
    reason: '公网索引页没有上线日期/版本。'},
  {group: 'pet', field: 'feature_skill_id', frozen: (p) => p.feature_skill_id, live: () => undefined, compare: () => false,
    reason: '公网索引页没有特性技能 id。'},
  {group: 'battle_skill', field: 'id', frozen: (s) => s.skill_id, live: (l) => l.id, compare: (a, b) => a === b,
    reason: '身份字段：两侧都逐条给 id。'},
  {group: 'battle_skill', field: 'name', frozen: (s) => s.name, live: (l) => l.name, compare: (a, b) => a === b,
    reason: '名字逐条可比（名字不参与身份）。'},
  {group: 'battle_skill', field: 'element', frozen: (s) => s.element, live: (l) => l.element, compare: (a, b) => stripSuffix(a) === stripSuffix(b),
    normalization: '剥掉「系」字（冻结「普通系」vs 公网「普通」）。',
    reason: '属性标签逐条可比。'},
  {group: 'battle_skill', field: 'category', frozen: (s) => s.category, live: (l) => l.category, compare: (a, b) => a === b,
    reason: '两侧粒度不同：冻结把物攻/魔攻合并成「攻击」，公网分成「物攻」「魔攻」；字面相等只有 221/579，**不**当可比字段。'},
  {group: 'battle_skill', field: 'power', frozen: (s) => s.power, live: () => undefined, compare: () => false,
    reason: '公网索引页没有静态威力。'},
  {group: 'battle_skill', field: 'energy', frozen: (s) => s.energy, live: () => undefined, compare: () => false,
    reason: '公网索引页没有能量消耗。'},
  {group: 'battle_skill', field: 'damage_class', frozen: (s) => s.damage_class, live: () => undefined, compare: () => false,
    reason: '公网索引页没有伤害类别。'},
  {group: 'battle_skill', field: 'desc', frozen: (s) => s.desc, live: () => undefined, compare: () => false,
    reason: '公网索引页没有效果文本。'},
  {group: 'battle_skill', field: 'tags', frozen: () => undefined, live: (l) => l.tags, compare: () => false,
    reason: '公网侧有「回能」这类标签，冻结侧没有对应字段。'},
  {group: 'trait', field: 'id', frozen: (s) => s.skill_id, live: (l) => l.id, compare: (a, b) => a === b,
    reason: '身份字段：两侧都逐条给 id。'},
  {group: 'trait', field: 'name', frozen: (s) => s.name, live: (l) => l.name, compare: (a, b) => a === b,
    reason: '名字逐条可比（名字不参与身份）。'},
  {group: 'trait', field: 'element', frozen: (s) => s.element, live: (l) => l.element, compare: (a, b) => stripSuffix(a) === stripSuffix(b),
    reason: '冻结侧 245 条特性的 element **全是「无系别」占位值**，公网侧给的是真实属性（光/草|光…）；冻结是占位值，不能当可比字段。'},
  {group: 'trait', field: 'primary_type', frozen: () => undefined, live: (l) => [l.primary_type, l.secondary_type].filter(Boolean).join('|'), compare: () => false,
    reason: '公网侧有 primary_type/secondary_type，冻结侧没有对应字段。'},
];

function comparableFieldOf(spec, verdict) {
  return verdict === 'COMPARABLE_PUBLIC_INDEX_HAS_FIELD' ? spec.field : null;
}

export function buildFieldCoverage({pets, skills, livePages}) {
  const pageOf = (key) => livePages.find((p) => p.key === key);
  const liveByGroup = {
    pet: pageOf('pet-index'),
    battle_skill: pageOf('skill-index'),
    trait: pageOf('trait-index'),
  };
  const rows = [];
  for (const spec of COVERAGE_SPECS) {
    const group = spec.group;
    const livePage = liveByGroup[group];
    const liveList = livePage?.status === 'ok' ? livePage.entities : [];
    const liveById = new Map(liveList.map((e) => [e.id, e]));
    let frozenPresent = 0;
    let livePresent = 0;
    let equal = 0;
    let unequal = 0;
    const unequalExamples = [];
    let matched = 0;
    for (const raw of pets && group === 'pet' ? Object.values(pets) : []) {
      const l = liveById.get(raw.pet_id);
      if (!l) continue;
      matched += 1;
      const a = spec.frozen(raw);
      const b = spec.live(l);
      if (a !== undefined && a !== null) frozenPresent += 1;
      if (b !== undefined && b !== null && b !== '') livePresent += 1;
      if (spec.compare(a, b)) equal += 1;
      else { unequal += 1; if (unequalExamples.length < 5) unequalExamples.push({entity_key: entityKey(group, raw.pet_id), frozen: summarize(a), live: summarize(b)}); }
    }
    if (group !== 'pet') {
      for (const raw of Object.values(skills ?? {})) {
        const l = liveById.get(raw.skill_id);
        if (!l) continue;
        matched += 1;
        const a = spec.frozen(raw);
        const b = spec.live(l);
        if (a !== undefined && a !== null) frozenPresent += 1;
        if (b !== undefined && b !== null && b !== '') livePresent += 1;
        if (spec.compare(a, b)) equal += 1;
        else { unequal += 1; if (unequalExamples.length < 5) unequalExamples.push({entity_key: entityKey(group, raw.skill_id), frozen: summarize(a), live: summarize(b)}); }
      }
    }
    const liveHasField = livePresent > 0;
    const frozenHasField = frozenPresent > 0;
    let verdict;
    if (!liveHasField) verdict = 'NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD';
    else if (!frozenHasField) verdict = 'NOT_COMPARABLE_NO_FROZEN_COUNTERPART';
    else if (group === 'trait' && spec.field === 'element') verdict = 'NOT_COMPARABLE_FROZEN_PLACEHOLDER';
    else if (spec.field === 'form_marker') verdict = 'NOT_COMPARABLE_REPRESENTATION_MISMATCH';
    else if (spec.field === 'category' || spec.field === 'stage') {
      verdict = spec.field === 'stage' ? 'NOT_COMPARABLE_REPRESENTATION_MISMATCH' : 'NOT_COMPARABLE_GRANULARITY_MISMATCH';
    } else if (equal === matched && matched > 0) verdict = 'COMPARABLE_PUBLIC_INDEX_HAS_FIELD';
    else verdict = 'NOT_COMPARABLE_REPRESENTATION_MISMATCH';
    rows.push({
      group,
      field: spec.field,
      matched_entities: matched,
      frozen_present: frozenPresent,
      live_present: livePresent,
      equal,
      unequal,
      unequal_examples: unequalExamples,
      verdict,
      comparable: verdict === 'COMPARABLE_PUBLIC_INDEX_HAS_FIELD',
      normalization: spec.normalization ?? null,
      reason: spec.reason,
    });
  }
  return {
    rows,
    comparable_field_allowlist: COMPARABLE_FIELD_ALLOWLIST,
    verdict_vocabulary: VERDICT_VOCABULARY,
    note: '本矩阵只证明「哪些字段能比」。能比的只有 id / 名字 / 编号 / 属性标签；'
      + '种族值、学招表、效果文本、威力**不可比**，因为公网索引页没有这些字段——'
      + '不是「数值一致」。',
  };
}

function summarize(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === 'object') return 'object';
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// ── 构建 pack ─────────────────────────────────────────────────────────────

export function buildPack({livePath = null} = {}) {
  const inputs = loadPackInputs({livePath});
  const {catalog, skills, learnsets, reconciliation, sources, liveSnapshot} = inputs;

  const catalogRel = rel(inputs.catalogPath);
  const skillsRel = rel(inputs.skillsPath);
  const learnsetsRel = rel(inputs.learnsetsPath);
  const liveRel = rel(inputs.livePath);
  const sourcesRel = rel(SOURCES_PATH);
  const reportRel = rel(RECONCILIATION_PATH);

  const catalogSha = sha256File(inputs.catalogPath);
  const skillsSha = sha256File(inputs.skillsPath);
  const learnsetsSha = sha256File(inputs.learnsetsPath);
  const liveSha = sha256File(inputs.livePath);
  const reportSha = sha256File(RECONCILIATION_PATH);
  const sourcesSha = sha256File(SOURCES_PATH);
  const ledgerSha = sha256File(EVIDENCE_LEDGER_PATH);
  const schemaText = `${JSON.stringify(buildSchema(), null, 1)}\n`;
  const schemaSha = sha256Bytes(Buffer.from(schemaText, 'utf8'));

  const liveSnapshotDate = liveSnapshot.snapshot_date;
  const liveSourceId = `wiki-nrc-live-index-${liveSnapshotDate}`;
  const frozenRevisionDate = (sources.find((s) => s.source_id === 'wiki-rocom-snapshot') || {}).revision_date ?? null;

  const frozenRecords = buildFrozenRecords({
    catalog, skills, catalogPath: inputs.catalogPath, skillsPath: inputs.skillsPath,
  });
  const liveRecords = buildLiveRecords(liveSnapshot);

  // ── 公网指针：`result.pages[<pi>].entities[<ei>]`（可在 public-index.json 里逐条解析）
  const pageIndex = new Map(liveSnapshot.result.pages.map((p, i) => [p.key, i]));
  const htmlSha = Object.fromEntries(Object.entries(liveSnapshot.metadata.pages ?? {}).map(([k, v]) => [k, v.sha256 ?? null]));

  const liveByKey = new Map(liveRecords.map((r) => [entityKey(r.group, r.id), r]));
  const frozenByIds = new Map(frozenRecords.map((r) => [entityKey(r.group, r.id), r]));

  const petsById = new Map(catalog.pets.map((p, index) => [p.pet_id, {raw: p, index}]));
  const skillsById = new Map(Object.entries(skills.skills));

  // ── 实体：并集（group + id 为一个逻辑实体），两侧证据进同一条 provenance[]
  const entities = [];
  const formAssignments = [];
  const formAxisById = new Map();
  const divergenceIds = [];

  for (const frozen of frozenRecords) {
    const key = entityKey(frozen.group, frozen.id);
    const live = liveByKey.get(key) ?? null;
    const group = frozen.group;

    const frozenAxis = group === 'pet' ? formAxisFromFrozen(frozen) : null;
    const liveAxis = group === 'pet' ? formAxisFromLive(live) : null;
    const merged = group === 'pet'
      ? mergeFormAxis(frozenAxis, liveAxis)
      : {axis: 'BASE', secondary_axes: [], rule_ids: ['not_applicable'], reasons: []};
    const divergence = Boolean(group === 'pet' && frozenAxis && liveAxis
      && (frozenAxis.axis === 'BASE') !== (liveAxis.axis === 'BASE'));
    if (divergence) divergenceIds.push(frozen.id);
    formAxisById.set(frozen.id, merged.axis);

    const provenance = [];
    let tags;
    let tagsLive = null;
    let refs;
    let unknownFields;
    let title;

    if (group === 'pet') {
      const found = petsById.get(frozen.id);
      const raw = found?.raw ?? null;
      const pointerBase = `pets[${found?.index ?? -1}]`;
      title = raw?.title ?? frozen.title ?? frozen.name;
      tags = tagsForFrozenPet(raw ?? {});
      refs = refsForFrozenPet(raw ?? {}, pointerBase, catalogRel);
      unknownFields = expectedUnknownFields({rawPet: raw, recordKind: frozen.record_kind});
      provenance.push({
        source_id: 'wiki-rocom-snapshot',
        source_scope: 'frozen_l1',
        artifact_path: catalogRel,
        artifact_sha256: catalogSha,
        pointer: pointerBase,
      });
    } else {
      const raw = skillsById.get(frozen.id) ?? null;
      const pointerBase = `skills.${frozen.id}`;
      title = frozen.name;
      tags = tagsForFrozenSkill(raw ?? {});
      refs = refsForFrozenSkill(raw ?? {}, pointerBase, skillsRel);
      unknownFields = expectedUnknownFields({rawSkill: raw, recordKind: frozen.record_kind});
      provenance.push({
        source_id: 'wiki-rocom-snapshot',
        source_scope: 'frozen_l1',
        artifact_path: skillsRel,
        artifact_sha256: skillsSha,
        pointer: pointerBase,
      });
    }

    if (live) {
      const pi = pageIndex.get(live.evidence.page);
      provenance.push({
        source_id: liveSourceId,
        source_scope: 'live_bwiki',
        artifact_path: liveRel,
        artifact_sha256: liveSha,
        pointer: `result.pages[${pi}].entities[${live.evidence.index}]`,
        page: live.evidence.page,
        selector: live.evidence.selector,
      });
      const liveTags = tagsForLive(liveSnapshot.result.pages[pi].entities[live.evidence.index], live.evidence.page);
      // 两侧标签**分开存**：同名键（element / category）口径不同，合并写会静默丢掉一侧。
      tagsLive = liveTags;
    }

    if (group === 'pet' && merged.axis !== 'BASE') {
      formAssignments.push({
        entity_key: key,
        axis: merged.axis,
        secondary_axes: merged.secondary_axes,
        rule_ids: merged.rule_ids,
        divergence,
        evidence: {
          frozen_title: title,
          frozen_form_marker: frozen.attributes.form_marker,
          frozen_record_kind: frozen.record_kind,
          live_form: live?.attributes.form ?? null,
          live_record_kind: live?.record_kind ?? null,
        },
        reasons: merged.reasons,
      });
    }
    if (group === 'pet' && divergence && merged.axis === 'BASE') {
      // 不可能：divergence 的定义就是两侧基础/非基础判定不同 ⇒ 并集必为非基础。
      throw new Error(`${key} 形态分歧但并集轴为 BASE：形态轴规则表有问题`);
    }

    const entity = {
      entity_key: key,
      id: frozen.id,
      group,
      record_kind: frozen.record_kind,
      name: frozen.name,
      title,
      source_scope: 'frozen_l1',
      form_axis: {
        axis: merged.axis,
        secondary_axes: merged.secondary_axes,
        rule_ids: merged.rule_ids,
        ...(divergence ? {divergence: true} : {}),
        ...(merged.reasons.length ? {reasons: merged.reasons} : {}),
      },
      tags,
      ...(tagsLive ? {tags_live: tagsLive} : {}),
      licence_ref: 'wiki-rocom-snapshot',
      provenance,
      refs,
      unknown_fields: unknownFields,
    };
    if (live && live.record_kind !== frozen.record_kind) {
      entity.record_kind_divergence = {[`${live.source_scope}`]: live.record_kind};
    }
    entities.push(entity);
  }

  // 公网独有实体：本轮为 0。真出现了就**拒绝**——那是新的对账事实，必须先重跑对账。
  const liveOnly = liveRecords.filter((r) => !frozenByIds.has(entityKey(r.group, r.id)));
  if (liveOnly.length) {
    throw new Error(`公网独有实体 ${liveOnly.length} 条（例：${liveOnly[0].id}），但 RC-201 报告 only_in_live=0：`
      + '先重跑 node scripts/roco/reconcile-catalog.mjs，再重建本包');
  }

  entities.sort((a, b) => a.entity_key.localeCompare(b.entity_key));
  formAssignments.sort((a, b) => a.entity_key.localeCompare(b.entity_key));

  // ── RC-201 交叉核对（fail closed：对不上就不许出包）
  const expectedOnlyInFrozen = new Set(reconciliation.buckets.only_in_frozen.map((e) => entityKey(e.group, e.id)));
  const actualOnlyInFrozen = new Set(entities.filter((e) => e.provenance.length === 1).map((e) => e.entity_key));
  const mismatch = symmetricDifference(expectedOnlyInFrozen, actualOnlyInFrozen);
  if (mismatch.length) {
    throw new Error(`「只有冻结侧证据」的实体与 RC-201 only_in_frozen 对不上：${mismatch.join(', ')}`
      + '——先重跑对账，不要手工调包');
  }
  const expectedDivergence = new Set(reconciliation.convention_notes.items.map((n) => n.id));
  const divergenceMismatch = symmetricDifference(expectedDivergence, new Set(divergenceIds));
  if (divergenceMismatch.length) {
    throw new Error(`形态标注分歧与 RC-201 convention_notes 对不上：${divergenceMismatch.join(', ')}`);
  }

  // ── 来源台账（逐条许可）
  const registry = sources.map((source) => ({
    source_id: source.source_id,
    role: source.role ?? null,
    registered_in_sources_yaml: true,
    licence_ref: source.source_id,
    license: source.license ?? null,
    redistribution: source.redistribution ?? null,
    license_evidence: source.license_evidence ?? null,
    revision: source.revision ?? null,
    entity_count: entities.filter((e) => e.provenance.some((p) => p.source_id === source.source_id)).length,
  }));
  registry.push({
    source_id: liveSourceId,
    role: 'public_index_snapshot',
    registered_in_sources_yaml: false,
    licence_ref: 'wiki-rocom-snapshot',
    licence_basis: (liveSnapshot.metadata.licence ?? {}).basis ?? null,
    license: liveSnapshot.metadata.licence?.license ?? null,
    redistribution: liveSnapshot.metadata.licence?.redistribution ?? null,
    license_evidence: liveSnapshot.metadata.licence?.license_evidence ?? null,
    revision: `sha256:${liveSha}`,
    snapshot_date: liveSnapshotDate,
    entity_count: entities.filter((e) => e.provenance.some((p) => p.source_id === liveSourceId)).length,
    note: 'RC-201 §10.8 **建议**的来源条目，本轮没有写进 data/roco/sources.yaml'
      + '（新增来源会弄红 tests/evals/provenance.test.js 里「sources 节应当是 4 条」的判据，那个文件不在本任务可改清单里）。'
      + '许可字段**搬运自** wiki-rocom-snapshot：抓的是同一站点，本仓库没有在站点页面上独立取证。',
  });

  const sectionOf = (entity) => {
    const redistributions = entity.provenance.map((p) => {
      const entry = registry.find((r) => r.source_id === p.source_id);
      return entry?.redistribution ?? null;
    });
    return redistributions.includes('REFERENCE_ONLY') ? 'reference_only' : 'distributable';
  };
  const bySection = {distributable: [], reference_only: []};
  for (const entity of entities) bySection[sectionOf(entity)].push(entity);

  const coverage = buildFieldCoverage({pets: catalog.pets, skills: skills.skills, livePages: liveSnapshot.result.pages});

  // ── 契约
  const lacksFieldRows = coverage.rows.filter((r) => r.verdict === 'NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD');
  const contract = {
    contains: [
      {what: '精灵索引（基础形态与形态分支）', detail: 'entity_key / record_kind / 名字 / 标题 / 图鉴编号 / game_id / 属性标签 / 类 / stage / 形态轴'},
      {what: '战斗技能与特性的索引', detail: 'id / 名字 / category / element / game_id（数值一律只给 refs）'},
      {what: '公网索引侧逐条证据', detail: 'page + url + html_sha256 + selector（选择器逐条落，url 与 html_sha256 在 artifacts 里）'},
      {what: '逐实体 provenance', detail: '{source_id, artifact_path, artifact_sha256, pointer}，冻结与公网两侧同一结构'},
      {what: '指针 refs', detail: '大字段（种族值 / 学招表 / 效果文本 / 威力 / 能量 / 伤害类别）只给 artifact_path + pointer，值仍在冻结目录'},
      {what: '冲突台账与形态轴对照表', detail: 'IDENTITY/VALUE/GRANULARITY 三类，逐条带 RC-201 证据指针'},
      {what: '字段级覆盖矩阵与机器可读就绪判定', detail: '逐字段覆盖率 + 不可比原因 + ready 闸门'},
    ],
    does_not_contain: [
      {what: '精灵种族值 / 面板值', fields: ['stats'], scope: 'live_bwiki', why: '公网索引页没有该字段；本包只给 refs 指回 data/roco/normalized/**/full-catalog.json'},
      {what: '可学技能表（learnset 明细）', fields: ['learnset'], scope: 'live_bwiki', why: '公网索引页没有该字段；明细在 learnsets.json 与 full-catalog.json，本包只给 pointer'},
      {what: '技能静态威力', fields: ['power'], scope: 'live_bwiki', why: '公网索引页没有该字段；且冻结侧 466/824 条 power 本身 not_provided_by_source（不等于 0 伤害）'},
      {what: '技能能量消耗', fields: ['energy'], scope: 'live_bwiki', why: '公网索引页没有该字段'},
      {what: '伤害类别（物攻/魔攻/防御/状态）', fields: ['damage_class'], scope: 'live_bwiki', why: '公网索引页没有该字段（公网只有合并口径的 category）'},
      {what: '技能/特性效果文本', fields: ['desc'], scope: 'live_bwiki', why: '公网索引页没有该字段'},
      {what: '上线日期 / 版本号', fields: ['release'], scope: 'live_bwiki', why: '公网索引页没有该字段'},
      {what: '类（猫咪类精灵等）', fields: ['class'], scope: 'live_bwiki', why: '公网索引页没有该字段'},
      {what: '特性技能 id', fields: ['feature_skill_id'], scope: 'live_bwiki', why: '公网索引页没有该字段'},
      {what: '原始 HTML 与 Lua 快照本体', fields: [], scope: 'all', why: '本包只登记 artifact_path + sha256，不复制内容；raw HTML 落在被 gitignore 的 raw/extracted/ 下（fetched_content_committed_to_git=false）'},
      {what: '官方一手数值', fields: [], scope: 'all', why: '全部来源是社区归档与公开 WIKI 页面；**不得**声称与官方一致'},
      {what: 'REFERENCE_ONLY 来源的逐条内容', fields: [], scope: 'all', why: 'nrc-ai-sqlite 与 rocom-data-lineups 的逐条内容不进入本包（entity_count=0）'},
      {what: '特性效果、技能时序、面板换算、版本强势度', fields: ['traits', 'skill_timing', 'panel_formula', 'season_strength'], scope: 'all', why: '来源里不存在，逐条列进 unknown_fields'},
    ],
  };

  const rulesetConfig = loadRulesetConfig();
  const rulesetBinding = {
    ruleset_id: catalog.ruleset_id,
    ruleset_label: (sources.find((s) => s.source_id === 'wiki-rocom-snapshot') || {}).notes ? 'S4「月涌狂想」赛季' : null,
    ruleset_config_id: rulesetConfig.config.ruleset_config_id,
    ruleset_config_path: rel(rulesetConfig.path),
    ruleset_config_sha256: sha256File(rulesetConfig.path),
    ruleset_config_is_default: rulesetConfig.config.is_default === true,
    ruleset_configs_available: rulesetConfig.all,
    as_of: liveSnapshotDate,
    frozen_revision: (sources.find((s) => s.source_id === 'wiki-rocom-snapshot') || {}).revision ?? null,
    frozen_revision_date: frozenRevisionDate,
    evidence_ledger_path: rel(EVIDENCE_LEDGER_PATH),
    evidence_ledger_sha256: ledgerSha,
    reconciliation_report_path: reportRel,
    reconciliation_report_sha256: reportSha,
    sources_path: sourcesRel,
    sources_sha256: sourcesSha,
    note: '数据层（L1 图鉴）不依赖战斗规则；这条绑定声明的是「消费这些数值时该按哪套 ruleset 配置模拟」，'
      + '以及本包所依据的对账报告/证据台账的**指纹**（换一份报告，指纹就变）。',
  };

  // ── 新鲜度守卫：公网快照日期早于冻结 revision 日期 ⇒ STALE
  const liveDate = String(liveSnapshotDate);
  const frozenDate = String(frozenRevisionDate ?? '').slice(0, 10);
  const fresh = Boolean(frozenDate) && liveDate >= frozenDate;
  const freshness = {
    as_of: liveSnapshotDate,
    frozen_revision_date: frozenRevisionDate,
    live_snapshot_date: liveSnapshotDate,
    status: fresh ? 'FRESH' : 'STALE',
    rule: '公网快照日期 >= 冻结 revision 日期（都取日期部分）⇒ FRESH；否则 STALE。',
    guard: {left: liveDate, right: frozenDate, op: '>=', pass: fresh},
    stale_blocks_ready: true,
  };

  const conflicts = buildConflicts({
    reconciliation, reportSha, catalogSha, skillsSha,
    formAxisById,
    entityKeys: new Set(entities.map((e) => e.entity_key)),
  });

  const formAxisCounts = Object.fromEntries(FORM_AXES.map((axis) => [axis, 0]));
  for (const entity of entities) {
    if (entity.group !== 'pet') continue;
    formAxisCounts[entity.form_axis.axis] += 1;
  }

  const pack = {
    schema_version: PACK_VERSION,
    pack_id: PACK_ID,
    metadata: {
      generated_by: 'scripts/roco/build-game-data-pack.mjs',
      determinism: '包内**不含**挂钟时间戳；时间信息只来自输入的 live_snapshot_date / frozen_revision_date。'
        + '同输入两次运行逐字节相同：node scripts/roco/build-game-data-pack.mjs --check',
      index_only: '本包只做索引：id / 名字 / 形态标记 / 标签 / provenance / licence_ref / pointer。'
        + '冻结层的大块数值**不抄进来**，值仍在 data/roco/normalized/** 里。',
      inputs: {
        frozen_dir: rel(FROZEN_DIR),
        frozen_ruleset_id: catalog.ruleset_id,
        live_snapshot: liveRel,
        reconciliation_report: reportRel,
        sources_yaml: sourcesRel,
        ruleset_config: rel(rulesetConfig.path),
      },
      entity_counts: {
        total: entities.length,
        by_record_kind: countBy(entities, (e) => e.record_kind),
        by_group: countBy(entities, (e) => e.group),
        by_source_scope: countBy(entities.flatMap((e) => e.provenance), (p) => p.source_scope),
        with_live_provenance: entities.filter((e) => e.provenance.length > 1).length,
        frozen_only: entities.filter((e) => e.provenance.length === 1).length,
        by_section: {distributable: bySection.distributable.length, reference_only: bySection.reference_only.length},
      },
      bytes_note: 'pack.json 的字节数写在 reports/roco/reconciliation/game-data-pack-readiness.json 里（写进包内会自指）。',
    },
    ruleset_binding: rulesetBinding,
    freshness,
    contract,
    unknown_fields_allowlist: [...UNKNOWN_FIELDS_ALLOWLIST],
    unknown_fields_scope: unknownFieldsScope(),
    artifacts: {
      [catalogRel]: {sha256: catalogSha, bytes: readFileSync(inputs.catalogPath).length, source_id: 'wiki-rocom-snapshot'},
      [skillsRel]: {sha256: skillsSha, bytes: readFileSync(inputs.skillsPath).length, source_id: 'wiki-rocom-snapshot'},
      [learnsetsRel]: {sha256: learnsetsSha, bytes: readFileSync(inputs.learnsetsPath).length, source_id: 'wiki-rocom-snapshot'},
      [liveRel]: {sha256: liveSha, bytes: readFileSync(inputs.livePath).length, source_id: liveSourceId,
        snapshot_date: liveSnapshotDate, pages: Object.fromEntries(Object.entries(liveSnapshot.metadata.pages ?? {}).map(([key, meta]) => [key, {
          url: meta.url, html_sha256: htmlSha[key], html_path: meta.html_path, http_status: meta.http_status,
        }]))},
      [reportRel]: {sha256: reportSha, bytes: readFileSync(RECONCILIATION_PATH).length, source_id: 'wiki-rocom-snapshot'},
      [sourcesRel]: {sha256: sourcesSha, bytes: readFileSync(SOURCES_PATH).length, source_id: null},
      [rel(rulesetConfig.path)]: {sha256: sha256File(rulesetConfig.path), bytes: readFileSync(rulesetConfig.path).length, source_id: rulesetConfig.config.source_id ?? null},
      [rel(EVIDENCE_LEDGER_PATH)]: {sha256: ledgerSha, bytes: readFileSync(EVIDENCE_LEDGER_PATH).length, source_id: null},
      [`${PACK_VERSION}/schema.json`]: {sha256: schemaSha, bytes: Buffer.byteLength(schemaText), source_id: null, note: '本包契约（自描述 schema）。'},
    },
    source_registry: registry,
    sections: {
      distributable: {
        definition: (buildSchema()['x-roco-contract'].distribution_classes).distributable,
        entities: bySection.distributable,
      },
      reference_only: {
        definition: (buildSchema()['x-roco-contract'].distribution_classes).reference_only,
        note: bySection.reference_only.length
          ? '这些实体的至少一条逐条来源是 REFERENCE_ONLY。'
          : '当前 **0 条**：两个 REFERENCE_ONLY 来源（nrc-ai-sqlite / rocom-data-lineups）没有任何逐条实体进入本包。'
            + '这不是省略，是事实——它们的用途是交叉核验（data/roco/conflicts.jsonl），其数值不进 normalized/。'
            + '校验器对「REFERENCE_ONLY 混进 distributable」判红（--selftest 有注入反证）。',
        entities: bySection.reference_only,
      },
    },
    conflicts,
    form_axis: {
      axes: FORM_AXES.map((axis) => ({axis, label: {BASE: '基础', LORD: '首领', REGIONAL: '地区', MUTATION: '突变', OTHER: '其它', UNMAPPED: '无法映射'}[axis]})),
      rules: FORM_AXIS_RULES,
      assignments: formAssignments,
      counts: formAxisCounts,
      notes: '只统计精灵（pet）实体；其它 record_kind 的形态轴为 not_applicable。'
        + 'RC-201 的 34 条 convention_notes 全部落表（divergence=true）；'
        + 'UNMAPPED 条数即「拒绝猜」的条数，每条都带原因。'
        + `本轮 OTHER=${formAxisCounts.OTHER}、UNMAPPED=${formAxisCounts.UNMAPPED}：`
        + '冻结侧所有带括号后缀的形态记录，公网侧都标了非 main 的 data-form，所以残差桶没有命中；'
        + 'UNMAPPED 为 0 是因为两侧取值都在词表内（遇到词表外的 data-form 会 UNMAPPED，--selftest 有注入反证）。',
    },
    field_coverage_matrix: coverage,
    readiness: null, // 下面填
  };

  const readiness = computeReadiness({
    pack,
    schema: buildSchema(),
    unresolvedConflicts: conflicts.unresolved,
    freshnessStatus: freshness.status,
  });
  pack.readiness = readiness;
  return pack;
}

function countBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function symmetricDifference(a, b) {
  const out = [];
  for (const value of a) if (!b.has(value)) out.push(value);
  for (const value of b) if (!a.has(value)) out.push(value);
  return out.sort();
}

// ── 机器可读就绪判定 ──────────────────────────────────────────────────────

/**
 * §9 的 9 项 → 机器可读判定。
 *
 * `mechanism` 项的 satisfied 由**包自己的内容**推出来（同一份判据在被校验器重算，
 * 声明与重算不一致就判红）；`static_false` 项是**如实承认没做完**，
 * 不由数据推出（否则就成了"只要生成了产物就算做完"）。
 */
export function computeReadiness({pack, schema, unresolvedConflicts, freshnessStatus}) {
  const entities = [...pack.sections.distributable.entities, ...pack.sections.reference_only.entities];
  const scopes = new Set(entities.flatMap((e) => e.provenance.map((p) => p.source_scope)));
  const provenanceEntries = entities.flatMap((e) => e.provenance);
  const conflictsByClass = {};
  for (const item of pack.conflicts.items) conflictsByClass[item.class] = (conflictsByClass[item.class] ?? 0) + 1;

  const evidenceFor = (key) => {
    switch (key) {
      case 'readiness.unified_schema':
        return {
          satisfied: schema['x-roco-contract'].record_kind_enum.length === 4
            && scopes.has('frozen_l1') && scopes.has('live_bwiki')
            && ['entity_key', 'record_kind', 'name', 'provenance', 'licence_ref', 'source_scope']
              .every((f) => schema['x-roco-contract'].required_entity_fields.includes(f)),
          facts: {
            check: 'schema.x-roco-contract.record_kind_enum / required_entity_fields / source_scope_enum',
            file: 'data/roco/game-data-pack/v2/schema.json',
            actual: `record_kind_enum=${JSON.stringify(schema['x-roco-contract'].record_kind_enum)}；`
              + `required_entity_fields=${JSON.stringify(schema['x-roco-contract'].required_entity_fields)}；`
              + `实体 ${entities.length} 条（scope=${[...scopes].sort().join('/')}），由**同一份**校验器检查`,
          },
        };
      case 'readiness.licence_per_entity':
        return {
          satisfied: entities.every((e) => typeof e.licence_ref === 'string' && e.licence_ref.length > 0)
            && pack.source_registry.every((r) => typeof r.redistribution === 'string')
            && pack.sections.distributable.entities.length + pack.sections.reference_only.entities.length === entities.length,
          facts: {
            check: 'entity.licence_ref + source_registry.redistribution + 分节归属',
            file: 'data/roco/game-data-pack/v2/pack.json',
            actual: `带 licence_ref 的实体 ${entities.filter((e) => e.licence_ref).length}/${entities.length}；`
              + `distributable=${pack.sections.distributable.entities.length}，reference_only=${pack.sections.reference_only.entities.length}；`
              + `来源登记 ${pack.source_registry.length} 条（REFERENCE_ONLY ${pack.source_registry.filter((r) => r.redistribution === 'REFERENCE_ONLY').length} 条）`,
          },
        };
      case 'readiness.per_entity_provenance':
        return {
          satisfied: provenanceEntries.length > 0
            && provenanceEntries.every((p) => p.source_id && p.artifact_path && /^[0-9a-f]{64}$/.test(p.artifact_sha256) && p.pointer)
            && entities.some((e) => e.provenance.some((p) => p.source_scope === 'frozen_l1'))
            && entities.some((e) => e.provenance.some((p) => p.source_scope === 'live_bwiki')),
          facts: {
            check: '逐实体 provenance 的四个必填字段 + 两侧粒度对等',
            file: 'data/roco/game-data-pack/v2/pack.json',
            actual: `provenance 条目 ${provenanceEntries.length} 条（frozen_l1 ${provenanceEntries.filter((p) => p.source_scope === 'frozen_l1').length} / `
              + `live_bwiki ${provenanceEntries.filter((p) => p.source_scope === 'live_bwiki').length}）；`
              + `artifact_sha256 与磁盘的一致性由 verify-game-data-pack.mjs 逐条核对`,
          },
        };
      case 'readiness.conflict_policy':
        return {
          satisfied: Object.keys(pack.conflicts.classes).length === 3
            && pack.conflicts.total === pack.conflicts.items.length
            && pack.conflicts.unresolved === pack.conflicts.items.filter((i) => i.status === 'UNRESOLVED').length
            && pack.conflicts.items.every((i) => i.evidence?.length && i.reason),
          facts: {
            check: 'conflicts.classes / total / unresolved / 逐条证据',
            file: 'data/roco/game-data-pack/v2/pack.json#conflicts',
            actual: `分类=${JSON.stringify({
              IDENTITY_CONFLICT: conflictsByClass.IDENTITY_CONFLICT ?? 0,
              VALUE_CONFLICT: conflictsByClass.VALUE_CONFLICT ?? 0,
              GRANULARITY_CONFLICT: conflictsByClass.GRANULARITY_CONFLICT ?? 0,
            })}；total=${pack.conflicts.total}，unresolved=${pack.conflicts.unresolved}；`
              + `未解决 ⇒ 就绪判定必须是 draft（当前 status=${pack.readiness?.game_data_pack_v2_status ?? '(自引用)'}）`,
          },
        };
      case 'readiness.form_axis':
        return {
          satisfied: pack.form_axis.assignments.length === entities.filter((e) => e.group === 'pet' && e.form_axis.axis !== 'BASE').length
            && pack.form_axis.assignments.filter((a) => a.divergence).length
              === pack.conflicts.items.filter((i) => i.class === 'GRANULARITY_CONFLICT').length,
          facts: {
            check: 'form_axis.assignments 覆盖所有非基础精灵 + divergence 条数与 GRANULARITY_CONFLICT 条数一致',
            file: 'data/roco/game-data-pack/v2/pack.json#form_axis',
            actual: `assignments=${pack.form_axis.assignments.length}；counts=${JSON.stringify(pack.form_axis.counts)}；`
              + `divergence=${pack.form_axis.assignments.filter((a) => a.divergence).length}`,
          },
        };
      case 'readiness.version_freshness':
        return {
          satisfied: Boolean(pack.ruleset_binding.ruleset_id && pack.ruleset_binding.ruleset_config_id
            && pack.ruleset_binding.as_of && pack.ruleset_binding.evidence_ledger_sha256
            && pack.ruleset_binding.reconciliation_report_sha256)
            && ['FRESH', 'STALE'].includes(pack.freshness.status),
          facts: {
            check: 'ruleset_binding 必填 + freshness 守卫',
            file: 'data/roco/game-data-pack/v2/pack.json#ruleset_binding',
            actual: `ruleset_id=${pack.ruleset_binding.ruleset_id}；ruleset_config_id=${pack.ruleset_binding.ruleset_config_id}；`
              + `as_of=${pack.ruleset_binding.as_of}；freshness=${pack.freshness.status}（${pack.freshness.guard.left} >= ${pack.freshness.guard.right}）`,
          },
        };
      case 'readiness.unavailable_fields':
        return {
          satisfied: pack.contract.contains.length > 0 && pack.contract.does_not_contain.length > 0
            && pack.unknown_fields_allowlist.length > 0
            && entities.every((e) => e.unknown_fields.every((f) => pack.unknown_fields_allowlist.includes(f))),
          facts: {
            check: 'contract.contains / does_not_contain / unknown_fields 允许清单',
            file: 'data/roco/game-data-pack/v2/pack.json#contract',
            actual: `contains=${pack.contract.contains.length} 条；does_not_contain=${pack.contract.does_not_contain.length} 条；`
              + `unknown_fields_allowlist=${JSON.stringify(pack.unknown_fields_allowlist)}`,
          },
        };
      default:
        return {satisfied: false, facts: {check: key, file: null, actual: '未实现'}};
    }
  };

  const items = READINESS_ITEMS.map((def) => {
    if (def.evaluator === 'release_gate_registry') {
      const wanted = def.requires_suites ?? [];
      const {satisfied, missing, present, ids} = releaseGateSatisfied({suites: RELEASE_GATE_SUITES, requires: wanted});
      return {
        id: def.id, key: def.key, title: def.title,
        satisfied,
        owner: missing.length ? 'main-thread' : null,
        note: missing.length
          ? `闸门登记表里缺少套件：${missing.join(', ')}（这一项现在由登记表本身判定，不是靠人声明）`
          : null,
        evidence: [{
          check: 'release_gate.registry',
          file: 'scripts/roco/verify-release.mjs',
          // **只陈述这一项自己的判据**（要求哪些套件、命中哪些），不写「闸门总数」：
          // 写总数会让「加一条无关套件」也把 pack 弄成过期（第 86 轮实测踩到：加 rag-eval 套件后
          // pack 与重建不一致，而这一项的结论其实没变）。判据要盯自己声称的东西。
          actual: `要求 ${JSON.stringify(wanted)}；命中 ${JSON.stringify(present)}`,
        }],
      };
    }
    if (def.evaluator === 'static_false') {
      return {
        id: def.id, key: def.key, title: def.title, satisfied: false,
        owner: def.owner ?? null, note: def.reason,
        evidence: [{check: `${def.key}.static_false`, file: null, actual: def.reason}],
      };
    }
    const result = evidenceFor(def.check);
    return {
      id: def.id, key: def.key, title: def.title,
      satisfied: Boolean(result.satisfied),
      owner: null, note: null,
      evidence: [result.facts],
    };
  });

  const satisfiedCount = items.filter((i) => i.satisfied).length;
  const blocking = [];
  for (const item of items) {
    if (!item.satisfied) blocking.push({kind: 'readiness_item', id: item.id, key: item.key, why: item.note ?? '该项的标准尚未达成'});
  }
  if (unresolvedConflicts > 0) {
    blocking.push({kind: 'unresolved_conflicts', count: unresolvedConflicts,
      why: '冲突未解决 ⇒ 就绪判定不得为 ready（不是警告，是拒绝）'});
  }
  if (freshnessStatus === 'STALE') {
    blocking.push({kind: 'stale_snapshot', why: '公网快照日期早于冻结 revision 日期 ⇒ STALE，就绪判定不得为 ready'});
  }
  const ready = items.every((i) => i.satisfied) && unresolvedConflicts === 0 && freshnessStatus !== 'STALE';
  return {
    game_data_pack_v2_status: ready ? 'ready' : 'draft',
    conflict_gate: unresolvedConflicts === 0 ? 'NO_UNRESOLVED_CONFLICTS' : 'BLOCKED_UNRESOLVED_CONFLICTS',
    satisfied_count: satisfiedCount,
    total_items: items.length,
    items,
    blocking,
    rule_build: `READINESS_ITEMS 逐项（static_false 项不由数据推出）：9 项全 satisfied 且 conflicts.unresolved=0 且 freshness!=STALE ⇒ ready，否则 draft。`
      + `本轮 ${satisfiedCount}/9 项 satisfied，未解决冲突 ${unresolvedConflicts} 条，新鲜度 ${freshnessStatus}。`,
  };
}

// ── 生成前的结构自检（不读磁盘；磁盘级判据在 verify-game-data-pack.mjs） ────

export function selfCheckPack(pack, schema = buildSchema()) {
  const problems = [];
  const say = (msg) => problems.push(msg);
  const contract = schema['x-roco-contract'];

  for (const field of schema.required) {
    if (pack[field] === undefined) say(`顶层缺字段 ${field}`);
  }
  if (pack.schema_version !== PACK_VERSION) say(`schema_version 应为 ${PACK_VERSION}，实际 ${pack.schema_version}`);

  const entities = [...pack.sections.distributable.entities, ...pack.sections.reference_only.entities];
  const sectionOfKey = new Map();
  for (const [name, section] of Object.entries(pack.sections)) {
    for (const entity of section.entities) {
      if (sectionOfKey.has(entity.entity_key)) say(`${entity.entity_key} 同时出现在多个分节里`);
      sectionOfKey.set(entity.entity_key, name);
    }
  }
  if (entities.length !== pack.metadata.entity_counts.total) {
    say(`实体总数 ${entities.length} 与 metadata.entity_counts.total=${pack.metadata.entity_counts.total} 不一致`);
  }
  const requiredEntity = contract.required_entity_fields;
  for (const entity of entities) {
    for (const field of requiredEntity) {
      if (entity[field] === undefined || entity[field] === null) {
        say(`${entity.entity_key || '(无 entity_key)'} 缺必填字段 ${field}`);
      }
    }
    if (!RECORD_KIND_ENUM.includes(entity.record_kind)) {
      say(`${entity.entity_key} 的 record_kind=${entity.record_kind} 不在 enum 里`);
    }
    if (!(GROUP_RECORD_KINDS[entity.group] ?? []).includes(entity.record_kind)) {
      say(`${entity.entity_key} 的 record_kind=${entity.record_kind} 与 group=${entity.group} 不匹配`);
    }
    if (!Array.isArray(entity.provenance) || !entity.provenance.length) {
      say(`${entity.entity_key} 没有 provenance —— 说不清这条从哪来`);
    }
    for (const [i, p] of (entity.provenance ?? []).entries()) {
      for (const field of contract.required_provenance_fields) {
        if (!p[field]) say(`${entity.entity_key} 的 provenance[${i}] 缺 ${field}`);
      }
      if (p.artifact_sha256 && !/^[0-9a-f]{64}$/.test(p.artifact_sha256)) {
        say(`${entity.entity_key} 的 provenance[${i}].artifact_sha256 不是 64 位十六进制`);
      }
      if (p.source_scope && !SOURCE_SCOPES.includes(p.source_scope)) {
        say(`${entity.entity_key} 的 provenance[${i}].source_scope=${p.source_scope} 不在词表里`);
      }
      if (p.artifact_path && !pack.artifacts[p.artifact_path]) {
        say(`${entity.entity_key} 的 provenance[${i}].artifact_path=${p.artifact_path} 不在 artifacts 登记表里`);
      } else if (p.artifact_path && pack.artifacts[p.artifact_path].sha256 !== p.artifact_sha256) {
        say(`${entity.entity_key} 的 provenance[${i}].artifact_sha256 与 artifacts 登记表不一致`);
      }
    }
    for (const ref of entity.refs ?? []) {
      for (const field of ['field', 'artifact_path', 'pointer']) {
        if (!ref[field]) say(`${entity.entity_key} 的 refs 里有一条缺 ${field}`);
      }
      if (ref.artifact_path && !pack.artifacts[ref.artifact_path]) {
        say(`${entity.entity_key} 的 ref「${ref.field}」指向未登记的 artifact_path=${ref.artifact_path}`);
      }
      if ((entity.unknown_fields ?? []).includes(ref.field)) {
        say(`${entity.entity_key} 的 ref「${ref.field}」有指针却被同时标进 unknown_fields —— 有值就不许标 unknown`);
      }
      if (entity.tags && Object.prototype.hasOwnProperty.call(entity.tags, ref.field)) {
        say(`${entity.entity_key} 的 ref「${ref.field}」有指针却在 tags 里也带了值 —— 大字段不许抄进包`);
      }
      if (entity.tags_live && Object.prototype.hasOwnProperty.call(entity.tags_live, ref.field)) {
        say(`${entity.entity_key} 的 ref「${ref.field}」有指针却在 tags_live 里也带了值`);
      }
    }
    for (const field of entity.unknown_fields ?? []) {
      if (!pack.unknown_fields_allowlist.includes(field)) {
        say(`${entity.entity_key} 的 unknown_fields 含允许清单外的 ${field}`);
      }
    }
    if (!FORM_AXES.includes(entity.form_axis?.axis)) {
      say(`${entity.entity_key} 的 form_axis.axis=${entity.form_axis?.axis} 不在词表里`);
    }
  }

  // 分节 vs 许可
  for (const entity of pack.sections.distributable.entities) {
    for (const p of entity.provenance) {
      const entry = pack.source_registry.find((r) => r.source_id === p.source_id);
      if (!entry) say(`${entity.entity_key} 的 provenance.source_id=${p.source_id} 不在 source_registry 里`);
      else if (entry.redistribution === 'REFERENCE_ONLY') {
        say(`${entity.entity_key} 的来源 ${p.source_id} 是 REFERENCE_ONLY，却出现在 distributable 分节里`);
      }
    }
  }
  for (const entity of pack.sections.reference_only.entities) {
    const hasReferenceOnly = entity.provenance.some((p) => {
      const entry = pack.source_registry.find((r) => r.source_id === p.source_id);
      return entry?.redistribution === 'REFERENCE_ONLY';
    });
    if (!hasReferenceOnly) {
      say(`${entity.entity_key} 在 reference_only 分节里，但它没有任何 REFERENCE_ONLY 来源 —— 分节归属错了`);
    }
  }
  if (!pack.sections.reference_only.note) say('reference_only 分节必须写明「为什么是空的 / 装了什么」');

  // 许可_ref 必须在来源台账里
  const licenceIds = new Set(pack.source_registry.map((r) => r.licence_ref).filter(Boolean));
  for (const entity of entities) {
    if (!licenceIds.has(entity.licence_ref)) {
      say(`${entity.entity_key} 的 licence_ref=${entity.licence_ref} 在 source_registry 里查不到`);
    }
  }

  // 冲突
  for (const item of pack.conflicts.items) {
    if (!Object.keys(CONFLICT_CLASSES).includes(item.class)) say(`${item.conflict_id} 的 class=${item.class} 不在三类里`);
    if (!CONFLICT_STATUSES.includes(item.status)) say(`${item.conflict_id} 的 status=${item.status} 不在词表里`);
    if (!item.evidence?.length) say(`${item.conflict_id} 没有证据`);
    if (!item.reason) say(`${item.conflict_id} 没有写原因`);
    if (item.status === 'UNRESOLVED' && item.resolution !== null) say(`${item.conflict_id} 未解决却带着 resolution`);
    if (item.status !== 'UNRESOLVED' && !item.resolution) say(`${item.conflict_id} 已裁定却没写 resolution 口径`);
  }
  if (pack.conflicts.total !== pack.conflicts.items.length) {
    say(`conflicts.total=${pack.conflicts.total} 与 items 数 ${pack.conflicts.items.length} 不一致`);
  }
  const unresolved = pack.conflicts.items.filter((i) => i.status === 'UNRESOLVED').length;
  if (pack.conflicts.unresolved !== unresolved) {
    say(`conflicts.unresolved=${pack.conflicts.unresolved} 与实际未解决条数 ${unresolved} 不一致`);
  }
  if (Object.keys(pack.conflicts.classes).length !== 3) say('冲突分类必须恰好是三类（IDENTITY/VALUE/GRANULARITY）');

  // 形态轴
  for (const assignment of pack.form_axis.assignments) {
    if (!FORM_AXES.includes(assignment.axis)) say(`${assignment.entity_key} 的形态轴 ${assignment.axis} 不在词表里`);
    if (assignment.axis === 'UNMAPPED' && !(assignment.reasons ?? []).length) {
      say(`${assignment.entity_key} 标了 UNMAPPED 却没写原因 —— 不许猜也不许不解释`);
    }
  }
  const nonBasePets = entities.filter((e) => e.group === 'pet' && e.form_axis.axis !== 'BASE');
  if (nonBasePets.length !== pack.form_axis.assignments.length) {
    say(`非基础精灵 ${nonBasePets.length} 条，但 form_axis.assignments 只有 ${pack.form_axis.assignments.length} 条`);
  }
  for (const [axis, count] of Object.entries(pack.form_axis.counts)) {
    const actual = entities.filter((e) => e.group === 'pet' && e.form_axis.axis === axis).length;
    if (actual !== count) say(`form_axis.counts.${axis}=${count} 与实际 ${actual} 不一致`);
  }
  if (!pack.form_axis.notes) say('form_axis 缺 notes（必须说明 OTHER/UNMAPPED 为什么是这些数）');

  // 覆盖矩阵：**不许**把值字段标成可比
  const illegalComparable = pack.field_coverage_matrix.rows
    .filter((r) => r.comparable && !pack.field_coverage_matrix.comparable_field_allowlist.includes(r.field));
  for (const row of illegalComparable) {
    say(`覆盖矩阵把 ${row.group}.${row.field} 标成可比，但它在可比字段白名单之外 —— 值字段不许声称可比`);
  }
  for (const row of pack.field_coverage_matrix.rows) {
    if (!row.comparable && !String(row.verdict).startsWith('NOT_COMPARABLE_')) {
      say(`${row.group}.${row.field} 不可比却用了 verdict=${row.verdict}`);
    }
    if (!row.reason) say(`${row.group}.${row.field} 没有写不可比的原因`);
    if (row.comparable && row.equal !== row.matched_entities) {
      say(`${row.group}.${row.field} 被标成可比，但 equal=${row.equal} ≠ matched=${row.matched_entities}`);
    }
  }
  if (!pack.field_coverage_matrix.verdict_vocabulary) say('覆盖矩阵缺 verdict 词表');

  // 契约
  if (!pack.contract?.contains?.length) say('contract.contains 为空');
  if (!pack.contract?.does_not_contain?.length) say('contract.does_not_contain 为空');
  if (!pack.unknown_fields_allowlist?.length) say('unknown_fields_allowlist 为空');
  if (JSON.stringify(pack.unknown_fields_allowlist) !== JSON.stringify(contract.unknown_fields_allowlist)) {
    say('unknown_fields_allowlist 与 schema 的声明不一致');
  }

  // 新鲜度 + 就绪
  if (!['FRESH', 'STALE'].includes(pack.freshness.status)) say(`freshness.status=${pack.freshness.status} 不在 {FRESH,STALE} 里`);
  if (pack.freshness.guard.pass !== (pack.freshness.status === 'FRESH')) {
    say('freshness.guard 与 freshness.status 不一致');
  }
  if (pack.freshness.guard.pass !== (pack.freshness.guard.left >= pack.freshness.guard.right)) {
    say('freshness.guard 的比较结果与 left/right 对不上');
  }
  const readiness = pack.readiness;
  const declaredReady = readiness.game_data_pack_v2_status === 'ready';
  if (declaredReady && unresolved > 0) {
    say(`就绪判定是 ready，但有 ${unresolved} 条未解决冲突 —— 未解决冲突必须**拒绝** ready，不是发警告`);
  }
  if (declaredReady && pack.freshness.status === 'STALE') {
    say('就绪判定是 ready，但快照是 STALE —— STALE 必须拒绝 ready');
  }
  const allSatisfied = readiness.items.every((i) => i.satisfied);
  if (declaredReady && !allSatisfied) {
    say(`就绪判定是 ready，但只有 ${readiness.satisfied_count}/${readiness.total_items} 项 satisfied`);
  }
  if (readiness.satisfied_count !== readiness.items.filter((i) => i.satisfied).length) {
    say('readiness.satisfied_count 与 items 里 satisfied 的条数不一致');
  }
  if (readiness.total_items !== READINESS_ITEMS.length) {
    say(`readiness.total_items=${readiness.total_items}，§9 是 ${READINESS_ITEMS.length} 项`);
  }
  if (!declaredReady && readiness.blocking.length === 0) {
    say('就绪判定是 draft，却没有列 blocking —— 必须说清还缺哪几项');
  }
  return problems;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function writeArtifacts() {
  const schema = buildSchema();
  const pack = buildPack();
  const schemaText = `${JSON.stringify(schema, null, 1)}\n`;
  const packText = `${JSON.stringify(pack, null, 1)}\n`;
  mkdirSync(PACK_DIR, {recursive: true});
  writeFileSync(SCHEMA_PATH, schemaText);
  writeFileSync(PACK_PATH, packText);
  return {schema, pack, schemaText, packText};
}

function checkOnDisk() {
  const problems = [];
  for (const path of [SCHEMA_PATH, PACK_PATH]) {
    if (!existsSync(path)) problems.push(`缺产物 ${rel(path)}：先跑 node scripts/roco/build-game-data-pack.mjs`);
  }
  if (problems.length) return {problems, fresh: null};
  const {pack, schemaText, packText} = writeArtifactsInMemory();
  const onDiskSchema = readFileSync(SCHEMA_PATH, 'utf8');
  const onDiskPack = readFileSync(PACK_PATH, 'utf8');
  if (onDiskSchema !== schemaText) problems.push(`schema.json 与「现在重建」的结果不一致（${onDiskSchema.length} vs ${schemaText.length} 字节）`);
  if (onDiskPack !== packText) problems.push(`pack.json 与「现在重建」的结果不一致（${onDiskPack.length} vs ${packText.length} 字节）`);
  return {problems, fresh: {pack, schemaText, packText}};
}

/** 只重建、不写盘（`--check` 用）。 */
function writeArtifactsInMemory() {
  const schema = buildSchema();
  const pack = buildPack();
  return {schema, pack, schemaText: `${JSON.stringify(schema, null, 1)}\n`, packText: `${JSON.stringify(pack, null, 1)}\n`};
}

const HELP = `用法：node scripts/roco/build-game-data-pack.mjs [--check] [--selftest] [--json]

  （无参数）  生成 data/roco/game-data-pack/v2/schema.json 与 pack.json
  --check    只校验：现在重建的结果必须与磁盘产物**逐字节相同**（可复跑判据），不写盘
  --selftest ≥6 条反证：把包改坏，结构自检必须抓住
  --json     把规模统计打到 stdout

  退出码：0=成功；1=自检/一致性失败
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv.includes('--selftest')) {
    const pack = buildPack();
    const real = selfCheckPack(pack);
    if (real.length) {
      process.stdout.write(`[selftest] ✖ 正产物没过自检：${real.slice(0, 3).join('；')}\n`);
      return 1;
    }
    const clone = () => JSON.parse(JSON.stringify(pack));
    const cases = [
      ['抽掉一条实体的 provenance', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].provenance = [];
        return bad;
      }],
      ['抽掉一条实体的 licence_ref', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].licence_ref = null;
        return bad;
      }],
      ['把 record_kind 改成词表外的值', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].record_kind = 'skill_record';
        return bad;
      }],
      ['把 REFERENCE_ONLY 来源的实体塞进 distributable', () => {
        const bad = clone();
        const source = bad.source_registry.find((r) => r.source_id === 'nrc-ai-sqlite');
        source.redistribution = 'REFERENCE_ONLY';
        const victim = bad.sections.distributable.entities[0];
        victim.provenance = [{
          source_id: 'nrc-ai-sqlite', source_scope: 'frozen_l1',
          artifact_path: victim.provenance[0].artifact_path,
          artifact_sha256: victim.provenance[0].artifact_sha256,
          pointer: victim.provenance[0].pointer,
        }];
        return bad;
      }],
      ['有值的字段被标进 unknown_fields', () => {
        const bad = clone();
        const victim = bad.sections.distributable.entities.find((e) => e.refs.some((r) => r.field === 'stats'));
        victim.unknown_fields = [...victim.unknown_fields, 'stats'];
        return bad;
      }],
      ['冲突未解决却把就绪标成 ready', () => {
        const bad = clone();
        bad.readiness.game_data_pack_v2_status = 'ready';
        bad.readiness.satisfied_count = bad.readiness.total_items;
        bad.readiness.items = bad.readiness.items.map((i) => ({...i, satisfied: true}));
        bad.readiness.blocking = [];
        return bad;
      }],
      ['快照标成 STALE 却仍 ready', () => {
        const bad = clone();
        bad.freshness.status = 'STALE';
        bad.freshness.guard.pass = false;
        bad.readiness.game_data_pack_v2_status = 'ready';
        bad.readiness.items = bad.readiness.items.map((i) => ({...i, satisfied: true}));
        bad.readiness.satisfied_count = bad.readiness.total_items;
        bad.readiness.blocking = [];
        return bad;
      }],
      ['把种族值标成可比字段', () => {
        const bad = clone();
        const row = bad.field_coverage_matrix.rows.find((r) => r.field === 'stats');
        row.comparable = true;
        row.verdict = 'COMPARABLE_PUBLIC_INDEX_HAS_FIELD';
        row.equal = row.matched_entities;
        return bad;
      }],
      ['UNMAPPED 形态轴不写原因', () => {
        const bad = clone();
        bad.form_axis.assignments[0].axis = 'UNMAPPED';
        bad.form_axis.assignments[0].reasons = [];
        return bad;
      }],
      ['reference_only 分节缺 note（空分节必须解释）', () => {
        const bad = clone();
        delete bad.sections.reference_only.note;
        return bad;
      }],
    ];
    let caught = 0;
    for (const [name, mutate] of cases) {
      const bad = mutate();
      let problems = [];
      try {
        problems = selfCheckPack(bad);
      } catch (error) {
        problems = [`自检抛错：${error.message}`];
      }
      if (problems.length) {
        caught += 1;
        process.stdout.write(`[selftest] 抓住：${name} → ${problems[0]}\n`);
      } else {
        process.stdout.write(`[selftest] ✖ 没抓住：${name}\n`);
      }
    }
    process.stdout.write(`[selftest] ${caught}/${cases.length} 个破坏被抓到；正产物通过结构自检\n`);
    return caught === cases.length ? 0 : 1;
  }

  if (argv.includes('--check')) {
    const {problems} = checkOnDisk();
    if (problems.length) {
      process.stdout.write(`[check] ✖ ${problems.length} 条问题：\n  ${problems.join('\n  ')}\n`);
      return 1;
    }
    process.stdout.write('[check] OK：schema.json / pack.json 与「现在重建」逐字节相同\n');
    return 0;
  }

  const schema = buildSchema();
  const pack = buildPack();
  const problems = selfCheckPack(pack, schema);
  if (problems.length) {
    process.stdout.write(`生成的内容没过结构自检：\n  ${problems.slice(0, 10).join('\n  ')}\n`);
    return 1;
  }
  const schemaText = `${JSON.stringify(schema, null, 1)}\n`;
  const packText = `${JSON.stringify(pack, null, 1)}\n`;
  mkdirSync(PACK_DIR, {recursive: true});
  writeFileSync(SCHEMA_PATH, schemaText);
  writeFileSync(PACK_PATH, packText);
  const counts = pack.metadata.entity_counts;
  process.stdout.write(`OK game-data-pack → ${rel(SCHEMA_PATH)}（${Buffer.byteLength(schemaText)} 字节）`
    + ` + ${rel(PACK_PATH)}（${Buffer.byteLength(packText)} 字节）\n`);
  process.stdout.write(`   实体 ${counts.total}：${JSON.stringify(counts.by_record_kind)}\n`);
  process.stdout.write(`   分节 distributable=${counts.by_section.distributable} `
    + `reference_only=${counts.by_section.reference_only}；provenance 条目 ${JSON.stringify(counts.by_source_scope)}\n`);
  process.stdout.write(`   冲突 ${pack.conflicts.total} 条（未解决 ${pack.conflicts.unresolved}）；`
    + `形态轴 ${JSON.stringify(pack.form_axis.counts)}\n`);
  process.stdout.write(`   就绪判定 ${pack.readiness.game_data_pack_v2_status} `
    + `（${pack.readiness.satisfied_count}/${pack.readiness.total_items} 项 satisfied，blocking ${pack.readiness.blocking.length} 条）\n`);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({counts, conflicts: pack.conflicts.total, readiness: pack.readiness}, null, 1)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[build-game-data-pack] 运行失败：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
