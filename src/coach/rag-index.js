// RC-204 RAG 索引层（增量能力，不替换、不削弱 strategist.js 的既有卡片检索）。
//
// 这一层只做四件事，每一件都能被单独证伪：
//   ① 实体/别名表：把 pack 的 1446 条实体、台账 20 条结论、2 份 ruleset 配置、
//      80 个 owned 个体统一成「文档」，每条文档带**具体别名**（名字 / 形态名 /
//      编号 / game_id / 职业 / 双属性）与**通用标签**（系别 / 类别 / 记录种类）。
//   ② 结构化过滤：record_kind（精灵 / 技能 / 特性 / 台账 / 配置 / 个体）与
//      source_scope（冻结快照 / 公网索引）按查询里的显式词做**硬过滤**；
//      硬过滤把正确答案也滤掉时，退回不过滤并在 intent 里如实标记 filter_fallback。
//   ③ BM25：纯 JS 实现，字段级（名字 / 别名 / 正文）分别算 idf 与长度归一，
//      不做任何模型调用，没有外部依赖。
//   ④ evidence / ruleset rerank：只在**相关性门槛之上**的候选之间，用品级
//      （pack provenance / 台账等级）与 ruleset 版本做微调。绝不允许把不相关
//      但等级高的记录顶上来 —— 那样「等级」就成了噪声放大器。
//
// 弃答（ABSTAIN）是合法结论，而且是**默认的保守方向**：
//   - 语料里没有这条 → NO_MATCH；
//   - pack 自己把条目标成 UNRESOLVED 身份冲突，且查询没有消歧词 →
//     UNRESOLVED_IDENTITY_CONFLICT；
//   - 查询要求「当事实断言」所需的最低等级（比如实机/官方），而语料里
//     最强候选也达不到 → EVIDENCE_LEVEL_INSUFFICIENT（附上候选 id 与它的等级）。
//
// 向量检索本轮**没有做**：没有本地嵌入模型、也不能联网，硬塞一个假向量只会
// 造出一个不可复跑的指标。接口留在 searchIndex 的 `vector` 选项上：传入
// {embed(text)->number[], docs:Map<id,number[]>} 时按余弦相似度加成；不传就是
// 纯词法路径。这样将来接真模型时不用改调用方，也不会在今天就假装做过。

import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve as resolvePath} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 src/coach/ 下。 */
export const REPO_ROOT = resolvePath(HERE, '..', '..');

/**
 * 台账六级（强 → 弱）。顺序与 scripts/roco/evidence-ledger-lib.mjs 的
 * CONFIDENCE_ORDER **必须**逐字一致；eval-rag-retrieval.mjs 启动时会 deepEqual
 * 对一次，tests/roco-rag-eval.test.js 也会再对一次。两份常量只会漂移一次，
 * 而那一次会被判据抓住，所以这里不复制注释里的话，只复制数组本身。
 */
export const EVIDENCE_LEVELS = Object.freeze([
  'OFFICIAL_CURRENT',
  'RECORDED_IN_GAME',
  'COMMUNITY_CURRENT',
  'CROSS_SOURCE_SUPPORTED',
  'ENGINE_HYPOTHESIS',
  'UNKNOWN',
]);

/** 中文标签只用于报告可读性，不参与打分。 */
export const EVIDENCE_LABELS = Object.freeze({
  OFFICIAL_CURRENT: '官方当前材料',
  RECORDED_IN_GAME: '可复核实机',
  COMMUNITY_CURRENT: '社区当前可见',
  CROSS_SOURCE_SUPPORTED: '多来源支持',
  ENGINE_HYPOTHESIS: '工程假设',
  UNKNOWN: '无证据',
});

/** 0 = 最强。未知等级一律排到最弱，不用「默认强」蒙混。 */
export function evidenceRank(level) {
  const index = EVIDENCE_LEVELS.indexOf(level);
  return index < 0 ? EVIDENCE_LEVELS.length : index;
}

/** a 是否**不弱于** b。 */
export function atLeastAsStrong(a, b) {
  return evidenceRank(a) <= evidenceRank(b);
}

/** 弃答哨兵：结果里的 id 就是这个字符串。 */
export const ABSTAIN = 'ABSTAIN';

export const ABSTAIN_REASONS = Object.freeze({
  NO_MATCH: '语料里没有可支撑的候选',
  UNRESOLVED_IDENTITY_CONFLICT: 'pack 自己把该条目标成 UNRESOLVED 身份冲突，查询又没有消歧词',
  EVIDENCE_LEVEL_INSUFFICIENT: '最强候选的证据等级低于该问题当事实断言所需的最低等级',
});

export const RAG_INPUTS = Object.freeze({
  pack: 'data/roco/game-data-pack/v2/pack.json',
  ledger: 'data/roco/evidence/rule-evidence-ledger.json',
  rulesetDir: 'data/roco/rulesets',
  owned: 'data/roco/owned/owned-pets.json',
  heldout: 'data/roco/rag/heldout-queries.json',
  report: 'reports/roco/rag/rag-eval.json',
  evalFixtures: ['tests/evals/retrieval.json', 'tests/evals/retrieval-extended.json'],
});

/** 记录种类 → 玩家能读的中文标签（机械翻译，不新造事实）。 */
export const RECORD_KIND_LABELS = Object.freeze({
  pet_record: '精灵',
  pet_form: '精灵形态',
  battle_skill: '技能',
  trait_record: '特性',
  ledger_entry: '规则证据条目',
  ruleset_config: '规则配置',
  owned_instance: '已拥有个体',
  conflict_record: '冲突条目',
  conflict_policy: '冲突登记政策',
});

/**
 * source_id → 证据等级。映射依据是 10 号文档的 source_markers：
 * 社区 wiki 页面 = COMMUNITY_CURRENT；仓库内部事实源 = ENGINE_HYPOTHESIS。
 * 没有登记过的 source_id 一律落 ENGINE_HYPOTHESIS（保守，不借强等级）。
 */
const SOURCE_LEVELS = Object.freeze({
  'wiki-rocom-snapshot': 'COMMUNITY_CURRENT',
  'wiki-nrc-live-index-2026-09-21': 'COMMUNITY_CURRENT',
});

const SOURCE_SCOPE_LABELS = Object.freeze({
  frozen_l1: '冻结快照',
  live_bwiki: '公网索引',
});

// ── 读语料（只读；不写任何文件） ───────────────────────────────────────────

export function loadCorpus({root = REPO_ROOT} = {}) {
  const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
  const pack = readJson(RAG_INPUTS.pack);
  const ledger = readJson(RAG_INPUTS.ledger);
  const owned = readJson(RAG_INPUTS.owned);
  const dir = join(root, RAG_INPUTS.rulesetDir);
  const rulesets = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file: `${RAG_INPUTS.rulesetDir}/${file}`,
      data: JSON.parse(readFileSync(join(dir, file), 'utf8')),
    }));
  return {pack, ledger, owned, rulesets};
}

// ── 分词与 BM25 ───────────────────────────────────────────────────────────

/** 中文按 bigram、ASCII 按词；不做词干化，不引入词典。 */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const match of source.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/g)) {
    const chunk = match[0];
    if (/^[a-z0-9]+$/.test(chunk)) {
      tokens.push(chunk);
      continue;
    }
    if (chunk.length === 1) tokens.push(chunk);
    for (let i = 0; i + 1 < chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2));
  }
  return tokens;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildFieldStats(docs, field) {
  const df = new Map();
  let totalLength = 0;
  for (const doc of docs) {
    const tokens = doc.tokens[field];
    totalLength += tokens.length;
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return {df, avgLength: docs.length ? totalLength / docs.length : 0, size: docs.length};
}

function bm25FieldScore(doc, field, terms, stats) {
  const tokens = doc.tokens[field];
  if (!tokens.length) return 0;
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of terms) {
    const freq = tf.get(term);
    if (!freq) continue;
    const docFreq = stats.df.get(term) ?? 0;
    const idf = Math.log(1 + (stats.size - docFreq + 0.5) / (docFreq + 0.5));
    const norm = freq * (BM25_K1 + 1)
      / (freq + BM25_K1 * (1 - BM25_B + BM25_B * tokens.length / (stats.avgLength || 1)));
    score += idf * norm;
  }
  return score;
}

// ── 文档构建 ──────────────────────────────────────────────────────────────

/** 把任意 JSON 值拍成稳定的「路径=值」行，键名也进正文（英文键也是真实证据）。 */
function flatten(value, prefix = '') {
  const rows = [];
  if (value === null || typeof value !== 'object') {
    rows.push(`${prefix}=${String(value)}`);
    return rows;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rows.push(...flatten(item, `${prefix}[${index}]`)));
    return rows;
  }
  for (const key of Object.keys(value)) rows.push(...flatten(value[key], prefix ? `${prefix}.${key}` : key));
  return rows;
}

function strongestLevel(levels) {
  const known = levels.filter((level) => EVIDENCE_LEVELS.includes(level));
  if (!known.length) return 'UNKNOWN';
  return known.reduce((best, level) => (evidenceRank(level) < evidenceRank(best) ? level : best), known[0]);
}

function weakestLevel(levels) {
  const known = levels.filter((level) => EVIDENCE_LEVELS.includes(level));
  if (!known.length) return 'UNKNOWN';
  return known.reduce((worst, level) => (evidenceRank(level) > evidenceRank(worst) ? level : worst), known[0]);
}

function entitySourceLevel(sourceId) {
  return SOURCE_LEVELS[sourceId] ?? 'ENGINE_HYPOTHESIS';
}

/** 从 pack 的 form_axis 规则表机械推出「live.form.lord → 首领」这类标签，不猜。 */
function axisLabelsFromPack(pack) {
  const axisEnums = new Map((pack.form_axis?.axes ?? []).map((row) => [row.axis, row.label]));
  const ruleToAxis = new Map();
  for (const rule of pack.form_axis?.rules ?? []) {
    if (rule.axis && axisEnums.has(rule.axis)) ruleToAxis.set(rule.rule_id, axisEnums.get(rule.axis));
  }
  return {axisEnums, ruleToAxis};
}

class DocBuilder {
  constructor() {
    this.docs = [];
  }

  add(doc) {
    const nameText = [doc.name, doc.title].filter(Boolean).join(' ');
    const aliasText = doc.aliases.map((alias) => alias.text).join(' ');
    this.docs.push({
      ...doc,
      fields: {name: nameText, alias: aliasText, body: doc.body},
      tokens: {name: tokenize(nameText), alias: tokenize(aliasText), body: tokenize(doc.body)},
    });
  }
}

function alias(text, kind, weight) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  return {text: value, kind, weight};
}

function specificAliasesForEntity(entity, helpers) {
  const {ruleToAxis} = helpers;
  const out = [
    alias(entity.name, 'name', 3),
    alias(entity.title, 'title', 3),
    // 实体 id 必须可检索：探针 P13「pet_000532 这个实体是什么」在首轮是 NO_MATCH，
    // 因为 pack 正文里根本没有 id 字段。结构化 id 查找是索引层的基本能力，所以补上。
    alias(entity.entity_key, 'entity_key', 3),
    alias(entity.id, 'entity_id', 2.5),
  ];
  const paren = /[（(]([^）)]+)[）)]/.exec(entity.title ?? '');
  if (paren) {
    out.push(alias(paren[1], 'form_name', 2.5));
    out.push(alias(String(entity.title).replace(/[（(][^）)]+[）)]/g, ''), 'title_base', 2.6));
  }
  if (entity.tags?.number) out.push(alias(entity.tags.number, 'number', 2));
  if (entity.tags?.game_id !== undefined) out.push(alias(String(entity.tags.game_id), 'game_id', 2));
  if (entity.tags?.class) out.push(alias(entity.tags.class, 'class', 0.4));
  // 「通用标签」（系别 / 形态轴标签）刻意只给极小权重：它们一次能命中上百条文档，
  // 权重一大就变成「谁都有份」的噪声。真正的区分度交给名字/形态名与 BM25 正文。
  for (const type of entity.tags?.types ?? []) out.push(alias(type, 'type', 0.05));
  const liveTypes = [entity.tags_live?.type, entity.tags_live?.primary_type, entity.tags_live?.secondary_type]
    .filter(Boolean).flatMap((value) => String(value).split('|'));
  for (const type of liveTypes) {
    out.push(alias(type, 'type_live', 0.05));
    out.push(alias(`${type}系`, 'type_live', 0.05));
  }
  for (const ruleId of entity.form_axis?.rule_ids ?? []) {
    const label = ruleToAxis.get(ruleId);
    if (label) out.push(alias(label, 'axis_label', 0.05));
  }
  return out.filter(Boolean);
}

function entityBody(entity, helpers) {
  const {axisEnums} = helpers;
  const rows = [
    `${RECORD_KIND_LABELS[entity.record_kind] ?? entity.record_kind}`,
    `记录种类 ${entity.record_kind}`,
    `分组 ${entity.group}`,
    `来源范围 ${SOURCE_SCOPE_LABELS[entity.source_scope] ?? entity.source_scope}`,
    `级别 ${entity.source_scope}`,
    `授权 ${entity.licence_ref}`,
  ];
  const axis = entity.form_axis?.axis;
  if (axis) {
    rows.push(`形态轴 ${axisEnums.get(axis) ?? axis}`);
    for (const secondary of entity.form_axis?.secondary_axes ?? []) {
      rows.push(`次要形态轴 ${axisEnums.get(secondary) ?? secondary}`);
    }
    for (const ruleId of entity.form_axis?.rule_ids ?? []) rows.push(`形态规则 ${ruleId}`);
  }
  for (const scope of new Set((entity.provenance ?? []).map((p) => p.source_scope))) {
    rows.push(`来源范围 ${SOURCE_SCOPE_LABELS[scope] ?? scope}`);
  }
  for (const entry of entity.provenance ?? []) {
    rows.push(`出处 ${entry.source_id} ${entry.pointer}`);
  }
  for (const field of entity.unknown_fields ?? []) rows.push(`未知字段 ${field}`);
  rows.push(...flatten(entity.tags ?? {}, 'tags'));
  rows.push(...flatten(entity.tags_live ?? {}, 'tags_live'));
  return rows.join(' \n ');
}

function ledgerBody(entry) {
  const rows = [
    RECORD_KIND_LABELS.ledger_entry,
    `条目 ${entry.id}`,
    `主题 ${entry.topic}`,
    `证据等级 ${entry.confidence}`,
    `结论 ${entry.claim}`,
  ];
  if (entry.notes) rows.push(`注记 ${entry.notes}`);
  if (entry.needs_microcase) rows.push(`需要实机 ${entry.microcase_id ?? '未指定'}`);
  for (const source of entry.sources ?? []) {
    rows.push(`来源标记 ${source.marker} 等级 ${source.level} ${source.url ?? ''} ${source.quote ?? ''}`);
  }
  for (const artifact of entry.affected_artifacts ?? []) rows.push(`影响产物 ${artifact}`);
  return rows.join(' \n ');
}

function rulesetBody(config) {
  const rows = [
    RECORD_KIND_LABELS.ruleset_config,
    `配置 ${config.ruleset_config_id}`,
    `状态 ${config.status}`,
    `推广策略 ${config.promotion_policy}`,
    config.is_default ? '默认配置 是' : '默认配置 否',
  ];
  if (config.battle_mode?.label) rows.push(`战斗模式 ${config.battle_mode.label}`);
  if (config.battle_mode?.registry_status) rows.push(`模式登记状态 ${config.battle_mode.registry_status}`);
  if (config.requires_microcase_before_default) rows.push('成为默认前需要实机 microcase');
  for (const note of config.notes ?? []) rows.push(`说明 ${note}`);
  rows.push(...flatten(config, 'config'));
  return rows.join(' \n ');
}

/**
 * 把一份 ruleset 配置按路径拆成「根文档 + 最多两层子文档」。
 *
 * 为什么要拆：整份 JSON 作为一条文档时，`turn_order.speed_tie` 那一小段会被
 * 几千 token 的正文做长度归一化稀释掉，查「同速判据」永远够不着门槛。
 * 拆开之后每个字段段落自己算 BM25 长度，查询能真正落在字段上。
 *
 * 字段里的 `evidence_id` 会 JOIN 到台账那条中文 claim（数据自带的引用，不是我们
 * 编的翻译），这样中文问「能量上限」能查到英文键 `energy.max` 的配置字段。
 */
function rulesetChunks(data, ledgerById) {
  const chunks = [];
  const walk = (value, path, depth) => {
    if (depth > 2 || value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      // 只给**子对象**建字段文档：标量叶子（value / evidence_id / reason）单独成条
      // 会变成超短正文，把任何碰到该词的长查询都吸过去，指标好看但检索是坏的。
      if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
      const childPath = path ? `${path}.${key}` : key;
      chunks.push({path: childPath, value: child});
      walk(child, childPath, depth + 1);
    }
  };
  walk(data, '', 0);
  return chunks.map((chunk) => {
    const flat = flatten(chunk.value, chunk.path);
    const levels = flat.join('\n').match(/=(OFFICIAL_CURRENT|RECORDED_IN_GAME|COMMUNITY_CURRENT|CROSS_SOURCE_SUPPORTED|ENGINE_HYPOTHESIS|UNKNOWN)\b/g)
      ?.map((row) => row.slice(1)) ?? [];
    const evidenceIds = [...new Set((flat.join(' ').match(/EV-[A-Z0-9-]+/g) ?? []))].sort();
    const claimRows = evidenceIds
      .map((id) => ledgerById.get(id))
      .filter(Boolean)
      .map((entry) => `证据引用 ${entry.id} 等级 ${entry.confidence} ${entry.claim}`);
    return {
      path: chunk.path,
      body: [`${RECORD_KIND_LABELS.ruleset_config} 配置 ${data.ruleset_config_id} 字段路径 ${chunk.path}`, ...flat, ...claimRows].join(' \n '),
      levels,
      evidenceIds,
    };
  });
}

function conflictBody(item) {
  const rows = [
    RECORD_KIND_LABELS.conflict_record,
    `冲突 ${item.conflict_id}`,
    `分类 ${item.class}`,
    `状态 ${item.status}`,
    `名字 ${item.name ?? ''}`,
    `歧义 ${item.ambiguity ?? ''}`,
    `原因 ${item.reason ?? ''}`,
  ];
  for (const key of item.entity_keys ?? []) rows.push(`涉及 ${key}`);
  for (const id of item.counterpart_ids ?? []) rows.push(`对方 ${id}`);
  for (const entry of item.evidence ?? []) rows.push(`证据 ${entry.kind} ${entry.path} ${entry.pointer}`);
  return rows.join(' \n ');
}

function conflictPolicyBody(pack) {
  const rows = [RECORD_KIND_LABELS.conflict_policy, '冲突登记政策 总表'];
  for (const [key, text] of Object.entries(pack.conflicts?.classes ?? {})) rows.push(`分类说明 ${key} ${text}`);
  for (const [key, text] of Object.entries(pack.conflicts?.resolution_policy ?? {})) rows.push(`处理政策 ${key} ${text}`);
  rows.push(`冲突统计 总数 ${pack.conflicts?.total ?? 0} 未解决 ${pack.conflicts?.unresolved ?? 0}`);
  for (const row of pack.field_coverage_matrix?.rows ?? []) {
    rows.push(`可比字段 ${row.group}.${row.field} 结论 ${row.verdict} ${row.reason ?? ''}`);
  }
  return rows.join(' \n ');
}

function ownedBody(instance) {
  const rows = [
    RECORD_KIND_LABELS.owned_instance,
    `个体 ${instance.instance_id}`,
    `物种 ${instance.species_id} ${instance.species_name}`,
    `层级 ${instance.species_tier}`,
    `等级 ${instance.level}`,
    instance.favourite ? '收藏 是' : '收藏 否',
    instance.locked ? '锁定 是' : '锁定 否',
    `技能 ${(instance.skills ?? []).join(' ')}`,
  ];
  for (const field of instance.unknown_fields ?? []) rows.push(`未知字段 ${field}`);
  for (const entry of instance.provenance ?? []) rows.push(`出处 ${entry.source_id} ${entry.pointer}`);
  // effect_reason 是语料自己写的「为什么这里是 UNKNOWN」（例如「面板换算公式未校准」），
  // 它必须进正文：否则「面板公式有吗」这类问题检索不到正确的落点，只能撞到名字里带
  // 「换算」两个字的无关特性上。
  for (const key of ['nature', 'talent', 'specialty', 'bloodline']) {
    const value = instance[key];
    if (!value || typeof value !== 'object') continue;
    rows.push(`字段 ${key}.effect=${value.effect ?? ''}`);
    rows.push(`字段 ${key}.effect_reason=${value.effect_reason ?? ''}`);
    if (value.microcase_id) rows.push(`字段 ${key}.microcase_id=${value.microcase_id}`);
  }
  rows.push(...flatten({panel_stats: instance.panel_stats}, 'fields'));
  return rows.join(' \n ');
}

/**
 * 构建全部文档。返回的数组顺序固定（pack → ledger → rulesets → owned），
 * 因此同样的输入两次构建逐字节相同。
 */
export function buildDocuments(corpus, {includeProvenance = true, root = REPO_ROOT} = {}) {
  const helpers = axisLabelsFromPack(corpus.pack);
  const binding = corpus.pack.ruleset_binding ?? {};
  const builder = new DocBuilder();
  const entities = [
    ...(corpus.pack.sections?.distributable?.entities ?? []),
    ...(corpus.pack.sections?.reference_only?.entities ?? []),
  ];
  const ledgerById = new Map((corpus.ledger.entries ?? []).map((entry) => [entry.id, entry]));
  const unresolved = new Map();
  for (const item of corpus.pack.conflicts?.items ?? []) {
    if (item.status !== 'UNRESOLVED') continue;
    for (const key of item.entity_keys ?? []) unresolved.set(key, item.conflict_id);
  }
  for (const entity of entities) {
    const levels = (entity.provenance ?? []).map((p) => entitySourceLevel(p.source_id));
    builder.add({
      id: entity.entity_key,
      record_kind: entity.record_kind,
      group: entity.group,
      name: entity.name,
      title: entity.title,
      entity_key: entity.entity_key,
      source_scopes: [...new Set((entity.provenance ?? []).map((p) => p.source_scope))].sort(),
      provenance: includeProvenance ? (entity.provenance ?? []) : [],
      licence_ref: entity.licence_ref ?? null,
      evidence_level: strongestLevel(levels),
      evidence_level_weakest: weakestLevel(levels),
      confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
      ruleset_config_id: binding.ruleset_config_id ?? null,
      unresolved_conflict_id: unresolved.get(entity.entity_key) ?? null,
      aliases: specificAliasesForEntity(entity, helpers).map((a) => ({...a})),
      body: entityBody(entity, helpers),
    });
  }
  for (const entry of corpus.ledger.entries ?? []) {
    builder.add({
      id: entry.id,
      record_kind: 'ledger_entry',
      group: 'rule',
      name: entry.id,
      title: entry.claim,
      source_scopes: ['handoff_10'],
      provenance: includeProvenance ? (entry.sources ?? []) : [],
      licence_ref: corpus.ledger.source_id ?? null,
      evidence_level: entry.confidence,
      evidence_level_weakest: entry.confidence,
      confidence_set: [entry.confidence],
      ruleset_config_id: binding.ruleset_config_id ?? null,
      unresolved_conflict_id: null,
      aliases: [alias(entry.id, 'ledger_id', 3), alias(entry.topic, 'topic', 1.5)].filter(Boolean),
      body: ledgerBody(entry),
    });
  }
  // 冲突条目与冲突政策也进索引：④ 类「冲突 / 证据不足」的查询必须有一个
  // 真正带证据指针的落点，而不是靠「我感觉这里查不到」。
  for (const item of corpus.pack.conflicts?.items ?? []) {
    builder.add({
      id: `conflict::${item.conflict_id}`,
      record_kind: 'conflict_record',
      group: 'conflict',
      name: item.name ?? item.conflict_id,
      title: `${item.conflict_id} ${item.class}`,
      source_scopes: ['frozen_l1', 'live_bwiki'],
      provenance: includeProvenance ? (item.evidence ?? []).map((entry) => ({
        source_id: 'reconciliation_report',
        source_scope: 'repo',
        artifact_path: entry.path,
        artifact_sha256: entry.sha256,
        pointer: entry.pointer,
      })) : [],
      licence_ref: 'wiki-rocom-snapshot',
      evidence_level: 'COMMUNITY_CURRENT',
      evidence_level_weakest: 'UNKNOWN',
      confidence_set: ['COMMUNITY_CURRENT', 'UNKNOWN'],
      ruleset_config_id: binding.ruleset_config_id ?? null,
      unresolved_conflict_id: item.status === 'UNRESOLVED' ? item.conflict_id : null,
      flags: {},
      aliases: [alias(item.name, 'conflict_name', 2), alias(item.conflict_id, 'conflict_id', 1.5)].filter(Boolean),
      body: conflictBody(item),
    });
  }
  builder.add({
    id: 'conflict_policy::pack',
    record_kind: 'conflict_policy',
    group: 'conflict',
    name: '冲突登记政策',
    title: '冲突登记政策 总表',
    source_scopes: ['frozen_l1', 'live_bwiki'],
    provenance: includeProvenance ? [{
      source_id: 'game_data_pack',
      source_scope: 'repo',
      artifact_path: RAG_INPUTS.pack,
      artifact_sha256: sha256File(join(root, RAG_INPUTS.pack)),
      pointer: 'conflicts.classes',
    }] : [],
    licence_ref: 'wiki-rocom-snapshot',
    evidence_level: 'COMMUNITY_CURRENT',
    evidence_level_weakest: 'UNKNOWN',
    confidence_set: ['COMMUNITY_CURRENT', 'UNKNOWN'],
    ruleset_config_id: binding.ruleset_config_id ?? null,
    unresolved_conflict_id: null,
    flags: {},
    aliases: [alias('冲突登记政策', 'policy_name', 2)],
    body: conflictPolicyBody(corpus.pack),
  });
  for (const {file, data} of corpus.rulesets) {
    const levels = flatten(data).join('\n').match(/=(OFFICIAL_CURRENT|RECORDED_IN_GAME|COMMUNITY_CURRENT|CROSS_SOURCE_SUPPORTED|ENGINE_HYPOTHESIS|UNKNOWN)\b/g)
      ?.map((row) => row.slice(1)) ?? [];
    const flags = {is_default: data.is_default === true, candidate_only: data.is_default !== true};
    builder.add({
      id: `ruleset_config::${data.ruleset_config_id}`,
      record_kind: 'ruleset_config',
      group: 'rule',
      name: data.ruleset_config_id,
      title: data.battle_mode?.label ?? data.ruleset_config_id,
      source_scopes: ['ruleset_config'],
      provenance: includeProvenance ? [{
        source_id: 'ruleset_config_file',
        source_scope: 'repo',
        artifact_path: file,
        artifact_sha256: sha256File(join(root, file)),
        pointer: 'status',
      }] : [],
      licence_ref: data.game ?? null,
      evidence_level: strongestLevel(levels),
      evidence_level_weakest: weakestLevel(levels),
      confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
      ruleset_config_id: data.ruleset_config_id,
      unresolved_conflict_id: null,
      flags,
      aliases: [alias(data.ruleset_config_id, 'config_id', 3)].filter(Boolean),
      body: rulesetBody(data),
    });
    for (const chunk of rulesetChunks(data, ledgerById)) {
      builder.add({
        id: `ruleset_config::${data.ruleset_config_id}#${chunk.path}`,
        record_kind: 'ruleset_config',
        group: 'rule',
        name: `${data.ruleset_config_id} ${chunk.path}`,
        title: `${data.ruleset_config_id} 的 ${chunk.path}`,
        source_scopes: ['ruleset_config'],
        provenance: includeProvenance ? [{
          source_id: 'ruleset_config_file',
          source_scope: 'repo',
          artifact_path: file,
          artifact_sha256: sha256File(join(root, file)),
          pointer: chunk.path,
        }] : [],
        licence_ref: data.game ?? null,
        evidence_level: strongestLevel(chunk.levels),
        evidence_level_weakest: weakestLevel(chunk.levels),
        confidence_set: [...new Set(chunk.levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
        ruleset_config_id: data.ruleset_config_id,
        unresolved_conflict_id: null,
        flags,
        aliases: [alias(data.ruleset_config_id, 'config_id', 1.5), alias(chunk.path, 'config_path', 1.5)].filter(Boolean),
        body: chunk.body,
      });
    }
  }
  for (const instance of corpus.owned.instances ?? []) {
    const levels = (instance.provenance ?? []).map((p) => entitySourceLevel(p.source_id));
    builder.add({
      id: `owned::${instance.instance_id}`,
      record_kind: 'owned_instance',
      group: 'owned',
      name: instance.instance_id,
      title: `${instance.species_name} 的个体`,
      source_scopes: ['frozen_l1'],
      provenance: includeProvenance ? (instance.provenance ?? []) : [],
      licence_ref: instance.licence_ref ?? null,
      evidence_level: strongestLevel(levels),
      evidence_level_weakest: weakestLevel(levels),
      confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
      ruleset_config_id: binding.ruleset_config_id ?? null,
      unresolved_conflict_id: null,
      aliases: [
        alias(instance.instance_id, 'instance_id', 3),
        alias(instance.species_name, 'species_name', 2),
        alias(instance.species_id, 'species_id', 2),
      ].filter(Boolean),
      body: ownedBody(instance),
    });
  }
  return builder.docs;
}

let SHA_CACHE = new Map();
export function sha256File(path) {
  if (SHA_CACHE.has(path)) return SHA_CACHE.get(path);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  SHA_CACHE.set(path, digest);
  return digest;
}

/** 索引对象：文档 + 三个字段的 BM25 统计 + 冲突表。测试可整体替换。 */
export function createRagIndex(corpus, options = {}) {
  const documents = buildDocuments(corpus, {root: options.root ?? REPO_ROOT, ...options});
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return {
    documents,
    byId,
    stats: {
      name: buildFieldStats(documents, 'name'),
      alias: buildFieldStats(documents, 'alias'),
      body: buildFieldStats(documents, 'body'),
    },
    unresolved: new Map(documents.filter((d) => d.unresolved_conflict_id).map((d) => [d.id, d.unresolved_conflict_id])),
    ruleset_config_ids: [...new Set(documents.map((d) => d.ruleset_config_id).filter(Boolean))].sort(),
  };
}

// ── 查询意图：结构化过滤词 ────────────────────────────────────────────────

const KIND_KEYWORDS = Object.freeze([
  [/精灵|宠物|宝可梦|形态/, ['pet_record', 'pet_form']],
  [/技能|招式/, ['battle_skill']],
  [/特性/, ['trait_record']],
  [/个体|我的/, ['owned_instance']],
  [/冲突|比过|逐条核|核对过|有分歧/, ['conflict_record', 'conflict_policy']],
]);

/**
 * 这些记录种类的总数很小（20 / 2 / 80 / 100），显式提到它们就等于把答案空间
 * 钉死了。这时不设相关性门槛：小集合里最像的那条就是答案，用「分数不够」
 * 丢掉它，只会让一条更不像的别类文档顶上。
 */
const PINNED_KINDS = Object.freeze(['ledger_entry', 'ruleset_config', 'owned_instance', 'conflict_record', 'conflict_policy']);

const SCOPE_KEYWORDS = Object.freeze([
  [/公网|公开索引|索引里|线上|bwiki/i, 'live_bwiki'],
  [/冻结|快照|冻结层/, 'frozen_l1'],
]);

/**
 * 检测结构化过滤条件。台账 / 配置这两类是**强意图**：命中就只看那一类，
 * 因为「哪条台账」「哪套配置」本身就把答案空间说死了。
 * 「默认 / 不能当默认」是配置上的结构化属性（is_default），也当过滤条件用，
 * 而不是靠「默认」两个字在正文里出现几次来决定谁赢。
 */
export function detectFilters(query) {
  const text = String(query);
  if (/台账|证据条目|证据台账|规则结论|结论条目/.test(text)) {
    return {kinds: ['ledger_entry'], scopes: [], prefer_default: null, config_level: false, strong: true, reason: '命中台账词'};
  }
  if (/ruleset|规则配置|配置文件|配置/.test(text)) {
    let preferDefault = null;
    if (/默认/.test(text)) preferDefault = /不能|不是|非|候选|未|没有|哪个不/.test(text) ? false : true;
    if (preferDefault === null && /候选/.test(text)) preferDefault = false;
    // 「哪套 / 哪份 / 默认」问的是配置这件东西本身，不是它某个字段：
    // 这时只留根文档，别让某个字段段落的短正文顶上来。
    const configLevel = /哪套|哪一套|哪份|哪一份|默认|不能当默认/.test(text);
    return {
      kinds: ['ruleset_config'], scopes: [], prefer_default: preferDefault, config_level: configLevel, strong: true,
      reason: `命中配置词${preferDefault === null ? '' : ` + is_default=${preferDefault}`}${configLevel ? ' + 配置级问题' : ''}`,
    };
  }
  const kinds = [];
  for (const [pattern, values] of KIND_KEYWORDS) {
    if (pattern.test(text)) for (const value of values) if (!kinds.includes(value)) kinds.push(value);
  }
  const scopes = [];
  for (const [pattern, value] of SCOPE_KEYWORDS) {
    if (pattern.test(text)) scopes.push(value);
  }
  const pinned = kinds.length > 0 && kinds.every((kind) => PINNED_KINDS.includes(kind));
  return {
    kinds,
    scopes,
    prefer_default: null,
    config_level: false,
    strong: pinned,
    reason: kinds.length || scopes.length ? '命中记录种类/来源范围词' : '无显式过滤词',
  };
}

const EVIDENCE_ASK = /证据|等级|官方|确认|定论|事实|规则|版本|配置|ruleset|台账|实机/i;

// 相关性门槛：低于它的候选不进结果，也不参与取证。
// 数值由语料标定（报告里的 score_calibration 会打印「被判定相关的候选最低分」），
// 不是拍脑袋。门槛太低会让「技能」这种泛词把整类文档都捞进来。
export const SCORE_FLOOR = 25;

// 硬过滤的退让比：过滤后的最好候选如果远弱于不过滤的最好候选，
// 说明过滤条件把正确答案滤掉了 —— 退回不过滤，并如实标记 filter_fallback。
const FILTER_FALLBACK_RATIO = 0.6;

// ── 检索 ─────────────────────────────────────────────────────────────────

function levelBonus(level) {
  const span = EVIDENCE_LEVELS.length - 1;
  return (span - evidenceRank(level)) / span;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 别名匹配。数字类别名（编号 / game_id）必须落在数字边界上：
 * 否则「编号 001」会命中查询里的「3001」，把无关实体顶上来。
 */
function aliasMatches(normalizedQuery, entry) {
  const needle = entry.text.toLowerCase();
  if (entry.kind === 'number' || entry.kind === 'game_id') {
    return new RegExp(`(^|[^0-9])${escapeRegExp(needle)}([^0-9]|$)`).test(normalizedQuery);
  }
  return normalizedQuery.includes(needle);
}

/**
 * 检索主入口。
 * @param {object} index createRagIndex 的产物
 * @param {string} query 查询原文
 * @param {object} options
 *   limit        返回条数（默认 10）
 *   requireLevel 该问题当「事实断言」所需的最低等级；达不到就弃答
 *   requireRulesetConfigId 版本要求
 *   vector       可选向量接口 {embed, docs}；本轮不实现，传了才走余弦加成
 *   floor        覆盖相关性门槛（标定与反证用；正常检索不要传）
 */
export function searchIndex(index, query, options = {}) {
  const {
    limit = 10,
    requireLevel = null,
    requireRulesetConfigId = null,
    vector = null,
    floor = null,
  } = options;
  const terms = tokenize(query);
  const intent = detectFilters(query);
  const asksEvidence = EVIDENCE_ASK.test(String(query));
  const normalizedQuery = String(query).toLowerCase();

  const scoreFor = (doc) => {
    const nameScore = bm25FieldScore(doc, 'name', terms, index.stats.name);
    const aliasScore = bm25FieldScore(doc, 'alias', terms, index.stats.alias);
    const bodyScore = bm25FieldScore(doc, 'body', terms, index.stats.body);
    let aliasBoost = 0;
    const matched = [];
    for (const entry of doc.aliases) {
      if (entry.text.length < 2 && !/^[a-z0-9]+$/i.test(entry.text)) continue;
      if (aliasMatches(normalizedQuery, entry)) {
        aliasBoost += entry.weight;
        matched.push({kind: entry.kind, text: entry.text});
      }
    }
    return {
      doc,
      nameScore,
      aliasScore,
      bodyScore,
      aliasBoost,
      matched,
      relevance: 1000 * aliasBoost + 3 * nameScore + 2 * aliasScore + bodyScore,
      vectorScore: 0,
    };
  };

  // 强意图（「哪条台账」「哪套配置」）把答案空间钉死成一小撮文档，
  // 这时不再设相关性门槛：20 条台账里最像的那条就是答案，
  // 用「分数不够」把它丢掉，反而会用一条更不像的别类文档顶上。
  const effectiveFloor = floor ?? (intent.strong ? 0 : SCORE_FLOOR);
  const run = (candidates) => candidates
    .map(scoreFor)
    .filter((row) => row.relevance >= effectiveFloor || row.aliasBoost > 0)
    .sort((a, b) => b.relevance - a.relevance || a.doc.id.localeCompare(b.doc.id));

  const passFilters = (doc) => {
    if (intent.kinds.length && !intent.kinds.includes(doc.record_kind)) return false;
    if (intent.scopes.length && !doc.source_scopes.some((scope) => intent.scopes.includes(scope))) return false;
    if (intent.prefer_default !== null && doc.record_kind === 'ruleset_config'
      && doc.flags.is_default !== intent.prefer_default) return false;
    if (intent.config_level && doc.id.includes('#')) return false;
    return true;
  };

  const hasFilter = intent.kinds.length > 0 || intent.scopes.length > 0
    || intent.prefer_default !== null || intent.config_level;
  const unfilteredRows = run(index.documents);
  const filteredRows = hasFilter ? run(index.documents.filter(passFilters)) : unfilteredRows;
  let rows = filteredRows;
  let filterFallback = false;
  if (hasFilter) {
    const filteredBest = filteredRows[0]?.relevance ?? 0;
    const unfilteredBest = unfilteredRows[0]?.relevance ?? 0;
    // is_default 是语料里的**权威属性**；强意图（台账/配置）也把答案空间钉死了。
    // 这两种情况下过滤后还有候选就信它，不再按分数退让。
    // 其它种类/来源过滤才按相关性比退让 —— 那些词可能只是句子里顺手带的。
    const attributeFilter = intent.prefer_default !== null || intent.config_level;
    const authoritative = intent.strong || (attributeFilter && filteredRows.length > 0);
    if (!filteredRows.length || (!authoritative && filteredBest < FILTER_FALLBACK_RATIO * unfilteredBest)) {
      // 硬过滤把更好的候选滤掉了：退回不过滤，但如实标记。不许把「过滤错」伪装成「语料没有」。
      rows = unfilteredRows;
      filterFallback = true;
    }
  }
  const top = rows[0] ?? null;
  const topRelevance = top ? top.relevance : 0;


  // 可选向量加成：接口在、实现不在。没有 embed 就完全不参与，不假装。
  if (vector && typeof vector.embed === 'function' && vector.docs instanceof Map) {
    const queryVector = vector.embed(query);
    for (const row of rows) {
      const docVector = vector.docs.get(row.doc.id);
      if (!Array.isArray(docVector) || docVector.length !== queryVector.length) continue;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < queryVector.length; i += 1) {
        dot += queryVector[i] * docVector[i];
        normA += queryVector[i] ** 2;
        normB += docVector[i] ** 2;
      }
      row.vectorScore = normA && normB ? dot / Math.sqrt(normA * normB) : 0;
    }
    rows = rows.slice().sort((a, b) => (b.relevance + 200 * b.vectorScore) - (a.relevance + 200 * a.vectorScore)
      || a.doc.id.localeCompare(b.doc.id));
  }

  // evidence / ruleset rerank：只在相关性门槛之上的候选之间微调。
  const reRanked = rows.map((row) => {
    let bonus = 0;
    if (row.relevance >= 0.5 * topRelevance) {
      bonus += 0.05 * topRelevance * levelBonus(row.doc.evidence_level);
      if (requireRulesetConfigId && row.doc.ruleset_config_id === requireRulesetConfigId) {
        bonus += 0.06 * topRelevance;
      }
      if (row.doc.provenance.length && row.doc.licence_ref) bonus += 0.01 * topRelevance;
    }
    return {...row, score: row.relevance + bonus};
  }).sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));

  const compact = reRanked.slice(0, limit).map((row) => ({
    id: row.doc.id,
    record_kind: row.doc.record_kind,
    name: row.doc.name,
    title: row.doc.title,
    score: Number(row.score.toFixed(6)),
    relevance: Number(row.relevance.toFixed(6)),
    alias_score: Number((1000 * row.aliasBoost).toFixed(6)),
    bm25: Number((3 * row.nameScore + 2 * row.aliasScore + row.bodyScore).toFixed(6)),
    vector_score: Number(row.vectorScore.toFixed(6)),
    evidence_level: row.doc.evidence_level,
    evidence_level_weakest: row.doc.evidence_level_weakest,
    source_scopes: row.doc.source_scopes,
    ruleset_config_id: row.doc.ruleset_config_id,
    has_provenance: row.doc.provenance.length > 0,
    matched_aliases: row.matched,
  }));

  const base = {
    query,
    intent: {
      kinds: intent.kinds,
      scopes: intent.scopes,
      prefer_default: intent.prefer_default,
      config_level: intent.config_level,
      reason: intent.reason,
      strong: intent.strong,
      filter_fallback: filterFallback,
      asks_evidence: asksEvidence,
      require_level: requireLevel,
      require_ruleset_config_id: requireRulesetConfigId,
      vector: vector ? 'supplied' : 'not_implemented',
    },
    candidates: rows.length,
    results: compact,
  };

  // ── 弃答判定（保守方向优先） ──
  if (!top) {
    return {...base, abstained: true, reason_code: 'NO_MATCH', reason: ABSTAIN_REASONS.NO_MATCH, results: []};
  }
  const identityHit = rows
    .filter((row) => row.matched.length && row.doc.unresolved_conflict_id)
    .map((row) => row.doc);
  if (identityHit.length) {
    // 消歧只看**比名字更具体**的东西：实体 id，或与名字不同、带括号后缀的完整 title。
    // 只写名字不算消歧 —— 名字正是冲突的那一项。
    const disambiguated = identityHit.some((doc) => {
      const specific = [doc.id, doc.entity_key, doc.title !== doc.name ? doc.title : null].filter(Boolean);
      return specific.some((token) => String(query).includes(token));
    });
    if (!disambiguated) {
      return {
        ...base,
        abstained: true,
        reason_code: 'UNRESOLVED_IDENTITY_CONFLICT',
        reason: `${ABSTAIN_REASONS.UNRESOLVED_IDENTITY_CONFLICT}：${identityHit.map((d) => `${d.id}(${d.unresolved_conflict_id})`).join('、')}`,
        conflict_ids: [...new Set(identityHit.map((d) => d.unresolved_conflict_id))],
      };
    }
  }
  if (requireLevel && !atLeastAsStrong(top.doc.evidence_level, requireLevel)) {
    return {
      ...base,
      abstained: true,
      reason_code: 'EVIDENCE_LEVEL_INSUFFICIENT',
      reason: `${ABSTAIN_REASONS.EVIDENCE_LEVEL_INSUFFICIENT}：问题需要 ${requireLevel}，最强候选 ${top.doc.id} 只有 ${top.doc.evidence_level}`,
      best_candidate: {
        id: top.doc.id,
        evidence_level: top.doc.evidence_level,
        required_level: requireLevel,
      },
    };
  }
  return {...base, abstained: false, reason_code: null, reason: null};
}

// ── grounded（可追溯）判定 ────────────────────────────────────────────────

/** 解析 pack 里那种 `pets[0].stats` / `skills.skill_000246` 指针。 */
export function resolvePointer(root, pointer) {
  const parts = String(pointer ?? '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return {found: false};
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) return {found: false};
    cursor = cursor[part];
  }
  return {found: true, value: cursor};
}

const ARTIFACT_CACHE = new Map();

function artifactJson(root, relative) {
  const path = join(root, relative);
  if (ARTIFACT_CACHE.has(path)) return ARTIFACT_CACHE.get(path);
  let value = null;
  if (existsSync(path)) {
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      value = null;
    }
  }
  ARTIFACT_CACHE.set(path, value);
  return value;
}

/**
 * 检一条文档能不能追到证据。返回逐项判定，不返回「大概可以」。
 * - pack 实体 / owned 个体：每条 provenance 的 artifact 存在 + sha256 命中 + 头一条指针可解析；
 * - 台账条目：等级在六级内 + 至少一条 source 带 url/marker/level；
 * - ruleset 配置：配置文件在磁盘上且 sha256 命中。
 */
export function groundDocument(doc, {root = REPO_ROOT} = {}) {
  const checks = [];
  const problems = [];
  if (doc.record_kind === 'ledger_entry') {
    const levelOk = EVIDENCE_LEVELS.includes(doc.evidence_level);
    const sourcesOk = doc.provenance.length > 0
      && doc.provenance.every((s) => s && s.marker && s.level && (s.url || s.quote));
    checks.push({check: 'ledger_level', ok: levelOk, detail: doc.evidence_level});
    checks.push({check: 'ledger_sources', ok: sourcesOk, detail: `${doc.provenance.length} 条`});
    if (!levelOk) problems.push(`${doc.id} 等级不在六级内：${doc.evidence_level}`);
    if (!sourcesOk) problems.push(`${doc.id} 的 sources 缺 marker/level/url`);
    return {id: doc.id, record_kind: doc.record_kind, grounded: problems.length === 0, checks, problems};
  }
  if (!doc.provenance.length) problems.push(`${doc.id} 没有任何 provenance 条目`);
  checks.push({check: 'provenance_present', ok: doc.provenance.length > 0, detail: `${doc.provenance.length} 条`});
  doc.provenance.forEach((entry, index) => {
    const path = entry.artifact_path;
    const exists = path ? existsSync(join(root, path)) : false;
    checks.push({check: `artifact_exists[${index}]`, ok: exists, detail: String(path)});
    if (!exists) problems.push(`${doc.id} 的 artifact 不存在：${path}`);
    if (exists && entry.artifact_sha256) {
      const actual = sha256File(join(root, path));
      const ok = actual === entry.artifact_sha256;
      checks.push({check: `artifact_sha256[${index}]`, ok, detail: ok ? '命中' : `${actual} != ${entry.artifact_sha256}`});
      if (!ok) problems.push(`${doc.id} 的 ${path} sha256 对不上磁盘`);
    }
    if (exists && index === 0 && entry.pointer) {
      const artifact = artifactJson(root, path);
      const resolved = artifact ? resolvePointer(artifact, entry.pointer) : {found: false};
      checks.push({check: 'pointer_resolves[0]', ok: resolved.found, detail: String(entry.pointer)});
      if (!resolved.found) problems.push(`${doc.id} 的首条指针解析不到：${entry.pointer}`);
    }
  });
  return {id: doc.id, record_kind: doc.record_kind, grounded: problems.length === 0, checks, problems};
}

export function resetCaches() {
  SHA_CACHE = new Map();
  ARTIFACT_CACHE.clear();
}
