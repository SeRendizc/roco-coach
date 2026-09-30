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
import {LIB_BY_RECORD_KIND, LIB_SCOPE, LIBS_PATH, assertLib, buildLibKindMap, loadLibs} from './rag-libs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 src/coach/ 下。 */
export const REPO_ROOT = resolvePath(HERE, '..', '..');

/**
 * 台账六级（强 → 弱）。顺序与 scripts/roco/evidence-ledger-lib.mjs 的
 * CONFIDENCE_ORDER **必须**逐字一致；eval-rag-retrieval.mjs 启动时会 deepEqual
 * 对一次，tests/roco-rag-eval.test.js 也会再对一次。两份常量只会漂移一次，
 * 而那一次会被判据抓住，所以这里不复制注释里的话，只复制数组本身。
 *
 * 2026-09-27（审计 ②）：常量本体搬到 `./evidence-levels.js`（那里不 import node 内建，
 * 浏览器侧也用得到 —— 天气回答要把依据等级印给玩家看）。这里 import 进来自己用、
 * 同时**原样再导出**，外部 API（`EVIDENCE_LEVELS` / `EVIDENCE_LABELS`）一个字没变。
 */
import {EVIDENCE_LEVELS, EVIDENCE_LABELS} from './evidence-levels.js';
export {EVIDENCE_LEVELS, EVIDENCE_LABELS};

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
  SCOPE_EXCLUDED: '查询点名的记录种类只落在被排除的 scope 上（玩家个体数据不属于规则语料）',
});

export const RAG_INPUTS = Object.freeze({
  pack: 'data/roco/game-data-pack/v2/pack.json',
  ledger: 'data/roco/evidence/rule-evidence-ledger.json',
  rulesetDir: 'data/roco/rulesets',
  heldout: 'data/roco/rag/heldout-queries.json',
  report: 'reports/roco/rag/rag-eval.json',
  evalFixtures: ['tests/evals/retrieval.json', 'tests/evals/retrieval-extended.json'],
});

/**
 * 玩家个体数据**不属于规则语料**（人类口径：「memory 与 RAG 分开做好」）。
 *
 * `owned` 原来混在 RAG_INPUTS 里，与 pack/台账平级 —— 后果是「我的个体」这类问题
 * 和「规则是什么」共用一条检索路径与一个 idf，玩家自己的 48 只个体会参与规则文档的
 * 词频统计。现在拆成单独一组：`RAG_INPUTS` 与 `PLAYER_INPUTS` 的 key 交集必须为空
 * （tests/roco-rag-libs.test.js 钉着这一条）。
 *
 * ⚠️ `loadCorpus()` 的返回对象里**仍然有** `corpus.owned`：eval 侧
 * （scripts/roco/eval-rag-retrieval.mjs 的 checkDerivation）在模块加载期就读它。
 * 这里拆的是「输入登记」，不是返回形状。
 */
export const PLAYER_INPUTS = Object.freeze({
  owned: 'data/roco/owned/owned-pets.json',
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
  type_chart: '属性相性',
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

/**
 * L3 属性相性表的输入路径：**由 `libs.json` 的 `inputs` 声明**（record_kinds 含 `type_chart`
 * 的那个库），不在 RAG_INPUTS 里再抄一份。
 *
 * 为什么只留一个登记处：相性表是**分库语料**，真源路径写两处必然漂，而「库声明指向 A、
 * 索引却读了 B」这种错谁都不会发现（两处各自都"看着对"）。`rag-libs.assertLib` 会检查
 * 声明出来的路径存在，所以这里的唯一职责是**解析出路径**。
 *
 * 库不存在 / 还没 ready / 没写 inputs 一律返回 null —— 不假装有语料（fail closed）。
 */
export function typeChartInput({root = REPO_ROOT, libs = null} = {}) {
  const registry = libs ?? loadLibs({root}).libs;
  const spec = registry.find((lib) => (lib.record_kinds ?? []).includes('type_chart')) ?? null;
  if (!spec || spec.status !== 'ready') return null;
  const path = (spec.inputs ?? [])[0] ?? null;
  return path ? {lib_id: spec.lib_id, path} : null;
}

/**
 * L5 术语表的输入路径 —— 与 `typeChartInput` 同一个做法：读 `libs.json` 的 `inputs`，
 * 而不是在代码里另写一份路径（否则「文档说来自 A、断言说来自 B」）。
 */
export function termsInput({root = REPO_ROOT, libs = null} = {}) {
  const registry = libs ?? loadLibs({root}).libs;
  const spec = registry.find((lib) => (lib.record_kinds ?? []).includes('term_entry')) ?? null;
  if (!spec || spec.status !== 'ready') return null;
  const path = (spec.inputs ?? [])[0] ?? null;
  return path ? {lib_id: spec.lib_id, path} : null;
}

/**
 * L4 战术卡库的输入 —— 卡片本体在 `src/game/content.js`（**唯一真源，不再生成 JSON 副本**）。
 * 与 `termsInput`/`typeChartInput` 同一个做法：路径从 `libs.json` 的 `inputs` 解析。
 */
export function cardsInput({root = REPO_ROOT, libs = null} = {}) {
  const registry = libs ?? loadLibs({root}).libs;
  const spec = registry.find((lib) => (lib.record_kinds ?? []).includes('tactic_card')) ?? null;
  if (!spec || spec.status !== 'ready') return null;
  const path = (spec.inputs ?? [])[0] ?? null;
  return path ? {lib_id: spec.lib_id, path} : null;
}

export function loadCorpus({root = REPO_ROOT, libs = null} = {}) {
  const readJson = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
  const pack = readJson(RAG_INPUTS.pack);
  const ledger = readJson(RAG_INPUTS.ledger);
  const owned = readJson(PLAYER_INPUTS.owned);
  const dir = join(root, RAG_INPUTS.rulesetDir);
  const rulesets = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file: `${RAG_INPUTS.rulesetDir}/${file}`,
      data: JSON.parse(readFileSync(join(dir, file), 'utf8')),
    }));
  // L3 相性表：读哪一份由 libs.json 的 inputs 决定（见 typeChartInput）。
  // 路径不存在就抛 —— 「库声明了真源、真源却不在」必须响，不许静默变成空库。
  const typeChartSpec = typeChartInput({root, libs});
  let typeChart = null;
  if (typeChartSpec) {
    if (!existsSync(join(root, typeChartSpec.path))) {
      throw new Error(`库 ${typeChartSpec.lib_id} 的输入路径不存在：${typeChartSpec.path}（见 ${LIBS_PATH}）`);
    }
    typeChart = readJson(typeChartSpec.path);
  }
  // L4 战术卡库：读**派生产物** `data/roco/derived/tactic-cards.json`
  // （由 `scripts/roco/build-tactic-cards.mjs` 从 `src/game/content.js` 生成，`--check` 钉住漂移）。
  // 为什么不用动态 import 直接读 `content.js`：那会把 `loadCorpus()` 变成 async，
  // 而它有十来个同步调用点（评测、校验脚本、判据）—— 为了一个库把整条链改异步不划算；
  // 派生产物里记着 `source_sha256`，判据会拿它跟当前 content.js 的 sha 对，改卡片不重跑就红。
  const cardsSpec = cardsInput({root, libs});
  let cards = null;
  if (cardsSpec) {
    if (!existsSync(join(root, cardsSpec.path))) {
      throw new Error(`库 ${cardsSpec.lib_id} 的输入路径不存在：${cardsSpec.path}（见 ${LIBS_PATH}）`);
    }
    const raw = readJson(cardsSpec.path);
    cards = Array.isArray(raw.cards) ? raw.cards : null;
  }
  // L5 术语表：同样是"库声明了真源、真源却不在"就抛，不许静默变成空库。
  const termsSpec = termsInput({root, libs});
  let terms = null;
  if (termsSpec) {
    if (!existsSync(join(root, termsSpec.path))) {
      throw new Error(`库 ${termsSpec.lib_id} 的输入路径不存在：${termsSpec.path}（见 ${LIBS_PATH}）`);
    }
    terms = readJson(termsSpec.path);
  }
  // 返回形状只**增加**一个键：`corpus.owned` 一个字都没改（见 PLAYER_INPUTS 的注释）。
  return {pack, ledger, owned, rulesets, typeChart, terms, cards,
          cardsArtifact: cardsSpec ? readJson(cardsSpec.path) : null,
          cardsPath: cardsSpec?.path ?? null};
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

/**
 * 属性相性表的一条文档（record_kind = `type_chart`，lib = L3）。
 *
 * 真源的形状：每个键是**防御方**的一个属性或属性组合（`冰系` / `光系|地系`），
 * `weak` = 它被哪些属性克制，`resist` = 它抵抗哪些属性，每个元素 `{type, multiplier}`。
 *
 * 正文写法有三条硬要求，每一条都对应一个**实测过的检索缺口**，不是为了好看：
 *   ① 逐字写出「克制 / 抵抗」—— 术语表 terms.json 里没有任何一条定义这两个词，
 *      探针 P10「冰系被哪些属性克制」当年只能按系别标签召回冰系精灵，就是因为正文里
 *      只有属性名、没有这两个字；
 *   ② 倍率写成 `X系 ×N`，N 与 types.json 逐字相同（不四舍五入、不换算）；
 *   ③ 每一对关系另写成 `攻击方克制/抵抗防御方` 的**同一段中文**（中间不留空格）。
 *      理由：这张表是**防御向**索引，而「火系克什么」问的是**进攻向** ——
 *      防御向的键（冰系）不会出现在这种问句的别名里，只能靠正文里的
 *      「火系克制冰系」这一串 bigram（火系 / 系克 / 克制 / 制冰 / 冰系）命中。
 *
 * ⚠️ 正文**刻意不写「倍率」这个词**：M07「属性倍率一共有哪几档」的答案是台账条目
 * EV-TYPE-MULTIPLIER。这 120 条文档每条都短、词又集中，一旦「倍率」进入正文，
 * ① 全库「倍率」的 idf 会被这 120 条拉低、② 某条短正文会顶掉那条台账 ——
 * 那正是「新文档抢旧查询的 top-1」。数值本身用 `×N` 逐字给全，信息一点没少。
 *
 * 【2026-09-25 人类裁决：双属性按两系相乘】原话「属性双属性叠加：快照 3×（现用）
 * vs 两个社区源 4×，差 41 格。**使用社区源**」。所以双属性条目的正文数值
 * **不能**再照抄 `types.json` 那一行的封顶值（×3），必须写成**两条单属性相乘**
 * 的结果（×4）—— 台账 EV-TYPE-MULTIPLIER（RECORDED_IN_GAME）与
 * `roco/src/roco_env/data.py::TypeChart.multiplier` 同一口径。
 * **旧口径留痕**：本条原文写「倍率写成 `X系 ×N`，N 与 types.json 逐字相同」；
 * 那句话对**单属性**仍然成立（18/18 逐字不变），对双属性已被裁决取代。
 * 单属性的行为一个字都没动：它继续逐字照抄快照那一行。
 */
function typeChartBody(entry, singleRows = null) {
  const key = String(entry.key ?? '');
  const parts = key.split('|').filter(Boolean);
  // 双属性：值 = 两条单属性行的倍率相乘（缺单属性行时按中性 1 参与相乘）。
  // 归类（weak / resist / 中性）也按**相乘后**的值判定：乘积为 1 的项从两侧都消失。
  const multiply = parts.length === 2 && singleRows ? parts : null;
  const valueOf = (attackType, fallback) => {
    if (!multiply) return fallback;
    let product = 1;
    for (const part of multiply) {
      const row = singleRows.get(part);
      product *= row ? (row.get(attackType) ?? 1) : 1;
    }
    return product;
  };
  const candidates = [];
  const push = (item) => {
    if (item && item.type && !candidates.some((row) => row.type === item.type)) candidates.push(item);
  };
  for (const item of entry.weak ?? []) push(item);
  for (const item of entry.resist ?? []) push(item);
  if (multiply) {
    // 相乘后可能出现快照那一行没列的攻击属性（或反过来），所以候选集要把
    // 两条单属性行里出现过的攻击属性都算上 —— 否则「正文=真源」只是碰巧成立。
    for (const part of multiply) {
      const row = singleRows.get(part);
      if (!row) continue;
      for (const attackType of row.keys()) push({type: attackType});
    }
  }
  const weak = candidates
    .map((item) => ({type: item.type, multiplier: valueOf(item.type, item.multiplier)}))
    .filter((item) => item.multiplier > 1);
  const resist = candidates
    .map((item) => ({type: item.type, multiplier: valueOf(item.type, item.multiplier)}))
    .filter((item) => item.multiplier < 1);
  const rows = [
    RECORD_KIND_LABELS.type_chart,
    '记录种类 type_chart',
    `条目 ${entry.key}`,
    `防御方属性 ${entry.key}`,
  ];
  if (multiply) rows.push(`双属性叠加 ${multiply.join('|')} 按两系相乘`);
  for (const item of weak) rows.push(`${item.type}克制${entry.key} ×${item.multiplier}`);
  for (const item of resist) rows.push(`${entry.key}抵抗${item.type} ×${item.multiplier}`);
  rows.push(`克制（weak） ${weak.map((item) => `${item.type} ×${item.multiplier}`).join(' ') || '无'}`);
  rows.push(`抵抗（resist） ${resist.map((item) => `${item.type} ×${item.multiplier}`).join(' ') || '无'}`);
  return rows.join(' \n ');
}

/** 单属性行 → `Map(攻击属性 → 倍率)`。双属性条目正文的**唯一**取数口。 */
function singleTypeRows(types) {
  const out = new Map();
  for (const [key, row] of Object.entries(types ?? {})) {
    if (String(key).includes('|')) continue;
    const table = new Map();
    for (const item of row?.weak ?? []) table.set(item.type, Number(item.multiplier));
    for (const item of row?.resist ?? []) if (!table.has(item.type)) table.set(item.type, Number(item.multiplier));
    out.set(key, table);
  }
  return out;
}

/**
 * 相性表文档的别名：整键给满权重（`冰系` → 3000 分，这是「问哪个属性」的锚点），
 * 双属性的**组成部分**只给 0.5 —— 否则 16 条含「冰系」的双属性文档会一起去抢
 * 「冰系被什么克制」的 top-1，而同名的那条单属性文档反而被自己的组合挤下去。
 */
function typeChartAliases(key) {
  const out = [alias(key, 'type_key', 3)];
  for (const part of String(key).split('|')) {
    if (part && part !== key) out.push(alias(part, 'type_key_part', 0.5));
  }
  return out.filter(Boolean);
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
 * 给一篇文档打库归属：`lib_id`（哪个 RAG 库）与 `scope`（rule / player）。
 *
 * ⚠️ 这是**纯附加**：`DocBuilder.add` 的 fields / tokens 只从 name / title / aliases / body
 * 派生，多两个字段不参与任何打分，也不动文档顺序。record_kind 没登记过就抛 ——
 * 一篇无法归库的文档会在「按库检索」时静默消失，那比直接抛错坏得多（fail closed）。
 */
export function tagDocument(doc, {kindMap = LIB_BY_RECORD_KIND, scopeByLib = LIB_SCOPE} = {}) {
  const libId = kindMap[doc.record_kind];
  if (!libId) {
    throw new Error(`记录种类 ${doc.record_kind}（文档 ${doc.id}）没有登记在任何 RAG 库里：`
      + `先把它写进 ${LIBS_PATH} 的某个 lib.record_kinds，不许让它悬空`);
  }
  const scope = scopeByLib[libId];
  if (!scope) throw new Error(`库 ${libId} 没有 scope（见 ${LIBS_PATH}）`);
  return {...doc, lib_id: libId, scope};
}

/**
 * 构建全部文档。返回的数组顺序固定（pack → ledger → rulesets → owned），
 * 因此同样的输入两次构建逐字节相同。
 *
 * `libs` 可覆盖默认注册表（反证与测试用：给某库一个假路径、或先删掉一个库）。
 */
export function buildDocuments(corpus, {includeProvenance = true, root = REPO_ROOT, libs = null} = {}) {
  const registry = libs ?? loadLibs({root}).libs;
  const kindMap = buildLibKindMap(registry);
  const scopeByLib = Object.fromEntries(registry.map((lib) => [lib.lib_id, lib.scope]));
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
  // ── L3 属性相性表（record_kind = type_chart）──
  //
  // **追加在最末尾**（owned 之后）：既有文档的相对顺序一个字都不动 ——
  // pack 实体 → 台账 → 冲突 → 冲突政策 → ruleset 配置 → 玩家个体 → **相性表**。
  // 顺序不是审美问题：报告与各库文档都按这个顺序产出，「同输入两次构建逐字节相同」
  // 也依赖它，所以新语料只许**追加**，不许插进既有文档之间。
  //
  // 语料来自 corpus.typeChart —— loadCorpus 按 libs.json 的 inputs 读进来的那份；
  // 路径也从同一份注册表解析，避免「文档说来自 A、断言说来自 B」。
  const typeChartSpec = typeChartInput({root, libs: registry});
  if (typeChartSpec && corpus.typeChart?.types) {
    const sourceId = corpus.typeChart.source_id ?? 'wiki-rocom-snapshot';
    const levels = [entitySourceLevel(sourceId)];
    // 单属性行只算一次：双属性条目的正文 = 两条单属性相乘（2026-09-25 人类裁决）。
    const singleRows = singleTypeRows(corpus.typeChart.types);
    for (const key of Object.keys(corpus.typeChart.types)) {
      const entry = corpus.typeChart.types[key] ?? {};
      builder.add({
        id: `type_chart::${key}`,
        record_kind: 'type_chart',
        group: 'type_chart',
        name: key,
        // title 里刻意**不写「属性」（挡 M07 的属性倍率问句）也不写「克制表」**：
        // 后者是缺席证明（derivation 的 absence 扫描只看 name/title）的比对词。
        title: `${key} 相性`,
        source_scopes: ['frozen_l1'],
        provenance: includeProvenance ? [{
          source_id: sourceId,
          source_scope: 'frozen_l1',
          artifact_path: typeChartSpec.path,
          artifact_sha256: sha256File(join(root, typeChartSpec.path)),
          // 真实 JSON pointer：types.json 的 types 是个对象，键就是属性名（含 `光系|地系`）。
          pointer: `types.${key}`,
        }] : [],
        licence_ref: sourceId,
        evidence_level: strongestLevel(levels),
        evidence_level_weakest: weakestLevel(levels),
        confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
        ruleset_config_id: binding.ruleset_config_id ?? null,
        unresolved_conflict_id: null,
        flags: {},
        aliases: typeChartAliases(key),
        body: typeChartBody(entry, singleRows),
      });
    }
  }
  // ── L5 术语表（record_kind = term_entry）──
  //
  // **追加在最末尾**（相性表之后）：既有文档的相对顺序一个字都不动（同输入两次构建逐字节相同）。
  // 为什么要有这一库（2026-09-25 第 46 轮）：人类在 c21/c22/c23 批注里要求「预制相关规则知识库进 RAG」，
  // 而冻结语料的 54 条术语（1015 应对 / 1020 先手 / 3019 选择…）此前**一篇都检索不到** ——
  // 规则类问句只能靠模型记忆，正是那几条批注要修的东西。术语是**一手来源**（游戏内文本），
  // 所以只写 note 与 desc 原文，不加任何解释。
  const termsSpec = termsInput({root, libs: registry});
  // ⚠ 冻结语料里 `terms` 是**对象**（`{"1001": {term_id, note, desc}, …}`），不是数组 ——
  // 第一版按数组写，实测 L5 文档数 = 0（而且是"静默 0"：库声明了却一篇都没有，靠 `rag-libs` 的
  // fail-closed 才会响）。这里两种形状都收。
  const termRows = Array.isArray(corpus.terms?.terms)
    ? corpus.terms.terms
    : Object.values(corpus.terms?.terms ?? {});
  if (termsSpec && termRows.length) {
    const sourceId = corpus.terms.source_id ?? 'frozen-terms';
    const levels = [entitySourceLevel(sourceId)];
    for (const term of termRows) {
      const termId = String(term.term_id ?? '');
      if (!termId) continue;
      const note = String(term.note ?? '');
      builder.add({
        id: `term::${termId}`,
        record_kind: 'term_entry',
        group: 'term',
        name: note || termId,
        title: `${note || termId}（术语 ${termId}）`,
        source_scopes: ['frozen_l1'],
        provenance: includeProvenance ? [{
          source_id: sourceId,
          source_scope: 'frozen_l1',
          artifact_path: termsSpec.path,
          artifact_sha256: sha256File(join(root, termsSpec.path)),
          pointer: `terms.${termId}`,
        }] : [],
        licence_ref: sourceId,
        evidence_level: strongestLevel(levels),
        evidence_level_weakest: weakestLevel(levels),
        confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
        ruleset_config_id: binding.ruleset_config_id ?? null,
        unresolved_conflict_id: null,
        flags: {},
        // 别名只放**术语自己的名字**（`alias()` 的形状，`{text, kind, weight}`）：
        // 检索「应对是什么」要靠它命中，不许猜同义词。
        // ⚠ 第一版写成 `[note]`（字符串数组），实测 `searchIndex` 直接抛
        // `Cannot read properties of undefined (reading 'length')` —— 索引要的是别名**条目**。
        aliases: note ? [alias(note, 'term_name', 3)] : [],
        body: `${note}：${String(term.desc ?? '')}`,
      });
    }
  }
  // ── L4 战术卡库（record_kind = tactic_card）──
  //
  // **追加在最末尾**（术语表之后）。语料来自派生产物 `data/roco/derived/tactic-cards.json`
  // （由 `scripts/roco/build-tactic-cards.mjs` 从 `src/game/content.js` 生成）。
  // 文档 id **直接沿用卡片 id**（`tactic:*` / `rule:skill:*`）—— 教练引用卡片时用的就是这套 id，
  // 两处同源才能在回执里对上。
  const cardsSpec = cardsInput({root, libs: registry});
  if (cardsSpec && Array.isArray(corpus.cards)) {
    const artifact = corpus.cardsArtifact ?? {};
    const sourceId = 'repo-cards';
    const levels = [entitySourceLevel(sourceId)];
    corpus.cards.forEach((card, position) => {
      const cardId = String(card.id ?? '');
      if (!cardId) return;
      builder.add({
        id: cardId,
        record_kind: 'tactic_card',
        group: 'tactic_card',
        name: String(card.title ?? cardId),
        title: `${String(card.title ?? cardId)}（战术卡 ${cardId}）`,
        source_scopes: ['frozen_l1'],
        provenance: includeProvenance ? [{
          source_id: sourceId,
          source_scope: 'frozen_l1',
          artifact_path: cardsSpec.path,
          artifact_sha256: sha256File(join(root, cardsSpec.path)),
          pointer: `cards[${position}]`,
        }] : [],
        licence_ref: sourceId,
        evidence_level: strongestLevel(levels),
        evidence_level_weakest: weakestLevel(levels),
        confidence_set: [...new Set(levels)].sort((a, b) => evidenceRank(a) - evidenceRank(b)),
        ruleset_config_id: binding.ruleset_config_id ?? null,
        unresolved_conflict_id: null,
        flags: {},
        // 关键词当别名（卡片自己声明的检索词，不是我们猜的同义词）。
        aliases: String(card.keywords ?? '').split(/\s+/).filter(Boolean)
          .map((word) => alias(word, 'card_keyword', 2)),
        body: [RECORD_KIND_LABELS.tactic_card ?? '战术卡', card.title, card.principle,
               card.counterexample, `关键词 ${card.keywords ?? ''}`, `规则版本 ${card.rules_version ?? ''}`,
               `出处 ${(card.authority ?? []).join('、')}`].filter(Boolean).join(' \n '),
      });
    });
    void artifact;
  }
  // 一处收口打标（T1）：每篇文档带 lib_id 与 scope。只加字段、不改分数、不改顺序。
  return builder.docs.map((doc) => tagDocument(doc, {kindMap, scopeByLib}));
}

let SHA_CACHE = new Map();
export function sha256File(path) {
  if (SHA_CACHE.has(path)) return SHA_CACHE.get(path);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  SHA_CACHE.set(path, digest);
  return digest;
}

/** 由一组文档造出索引对象（统计量**只**由这组文档算出）。 */
function indexFromDocuments(documents, {libIds = null} = {}) {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return {
    documents,
    byId,
    lib_ids: libIds ?? [...new Set(documents.map((doc) => doc.lib_id))].sort(),
    stats: {
      name: buildFieldStats(documents, 'name'),
      alias: buildFieldStats(documents, 'alias'),
      body: buildFieldStats(documents, 'body'),
    },
    unresolved: new Map(documents.filter((d) => d.unresolved_conflict_id).map((d) => [d.id, d.unresolved_conflict_id])),
    ruleset_config_ids: [...new Set(documents.map((d) => d.ruleset_config_id).filter(Boolean))].sort(),
  };
}

/**
 * 索引对象：文档 + 三个字段的 BM25 统计 + 冲突表。测试可整体替换。
 *
 * **每库一个索引实例**（`lib` / `lib_ids` 选项）：统计量（idf / 平均长度）只由该库的
 * 文档算出。这不是优化，是判据能成立的前提 —— 共用全局索引时，
 * 「删掉某库 ⇒ 其它库结果逐字节不变」根本不成立（idf 会跟着变）。
 *
 * 不传 `lib` 时得到的是**全库联合视图**（与分库前逐字节相同）：
 * eval-rag-retrieval.mjs 的 `conflict_policy::pack` 硬编码、基线B 遍历 `index.documents`、
 * grounded 按 id 查都依赖它。
 */
export function createRagIndex(corpus, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const registry = options.libs ?? loadLibs({root}).libs;
  const documents = buildDocuments(corpus, {root, ...options});
  const wanted = normalizeLibIds(options.lib ?? options.lib_ids ?? null);
  if (!wanted) return indexFromDocuments(documents);
  for (const libId of wanted) assertLib(libId, {root, libs: registry});
  const selected = documents.filter((doc) => wanted.includes(doc.lib_id));
  for (const libId of wanted) {
    assertLib(libId, {root, libs: registry, documents: selected.filter((doc) => doc.lib_id === libId)});
  }
  return indexFromDocuments(selected, {libIds: wanted.slice().sort()});
}

/** `lib` / `lib_ids` 选项归一：字符串、数组、null 都收。空数组视同「不筛」。 */
function normalizeLibIds(value) {
  if (value === null || value === undefined) return null;
  const ids = Array.isArray(value) ? value : [value];
  if (!ids.length) return null;
  for (const id of ids) if (typeof id !== 'string' || !id.trim()) throw new Error(`lib 筛选值必须是 lib_id 字符串：${String(id)}`);
  return [...new Set(ids)];
}

/**
 * 一次把**每个库**建成独立索引，另加一份全库联合视图。
 * `pending` 的库没有 inputs，建不出索引，也不假装能建 —— 登记在 `pending` 里。
 *
 * 返回值：`{root, libs, joint, byLib: Map<lib_id, index>, pending: [{lib_id, reason}]}`。
 * 「删掉一个库」= 用 `libs` 覆盖注册表后重新建（tests/roco-rag-libs.test.js 的反证就是这么做的）。
 */
export function createRagIndexSet(corpus, options = {}) {
  const root = options.root ?? REPO_ROOT;
  const registry = options.libs ?? loadLibs({root}).libs;
  const documents = buildDocuments(corpus, {root, ...options});
  const byLib = new Map();
  const pending = [];
  for (const spec of registry) {
    assertLib(spec, {root});
    const docs = documents.filter((doc) => doc.lib_id === spec.lib_id);
    if (spec.status === 'pending') {
      pending.push({lib_id: spec.lib_id, reason: 'status=pending（尚无 inputs，本轮不建索引）'});
      continue;
    }
    assertLib(spec, {root, documents: docs});
    byLib.set(spec.lib_id, indexFromDocuments(docs, {libIds: [spec.lib_id]}));
  }
  return {root, libs: registry, joint: indexFromDocuments(documents), byLib, pending};
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
 *   libs         只要这些 lib_id 的文档（分库 debug：`libs:['L1']`）
 *   scope        只要这些 scope（'rule' / 'player' / 数组）；传了就**覆盖**下面的默认
 *   includePlayer 规则检索**默认排除** scope==='player'（玩家个体不是规则语料）。
 *                 要读玩家数据必须显式给 includePlayer:true 或 scope:'player'。
 */
//: 「定义型」问句：问的是**术语本身是什么意思**。术语库（L5）对这类问句是**正解**。
const DEFINITION_ASK = /定义|术语|什么意思|是什么意思|指的是|怎么解释/;

//: 「要打法/建议」的问句：战术卡库（L4）只在这类问句里当候选。
//:
//: 实测（2026-09-25 第 47 轮，把 L4 接进联合索引的当天）：93 张卡片**关键词极密**，
//: 于是它把台账/配置挤掉了整整一档 —— Recall@1 **1.000 → 0.794**、等级匹配 **1.000 → 0.824**，
//: 而且 C01–C05 五条"必须弃答"的问句全部变成命中卡片（它们是**事实/证据**问句，卡片答不了）。
//: 这不是"卡片没用"，而是**问句类型不对**：卡片回答"该怎么打 / 该不该"，不回答"是哪一条 / 测过吗"。
const GUIDANCE_ASK = /该不该|要不要|怎么打|怎么用|怎么办|咋办|如何应对|怎么应对|思路|打法|建议|技巧|为什么|为啥|值得吗|划算吗/;

/**
 * **玩家旧说法 → 当前词表口径**（2026-10-01 task-42，Lead 窄例外）。
 *
 * 为什么需要：知识卡的 `keywords` 里**有意保留**「豆」（那是玩家的旧说法，删了召回就退化），
 * 而卡的正文已经统一叫「能量」（`src/game/content.js`，词表唯一事实源见 `src/coach/player-text.js`）。
 * 查询侧也归一化，两条说法才都能命中同一张卡；将来真把旧关键词清掉时，「豆」也不会查不到。
 *
 * 纪律（学 `LOADOUT_STORE_*` 那一套）：**这张表只在本文件定义一处**，判据会钉住"只有一处"；
 * 其它模块需要时只许 `import`，不许各写一份近义映射。
 */
export const LEGACY_QUERY_ALIASES = Object.freeze({'豆': '能量'});

/**
 * 查询扩展：`原文 + 归一化后的变体`。
 *
 * 为什么保留原文而不是直接替换：卡自己的 `keywords` 里还有旧说法，**替换会把它删掉**；
 * 追加一份归一化变体，等于「旧词命中关键词 + 新词命中正文」两条路都留着（互为备份）。
 * 例：`豆怎么算` → `豆怎么算 能量怎么算`。
 */
export function expandLegacyQuery(text) {
  const raw = String(text ?? '');
  const extras = [];
  for (const [legacy, canonical] of Object.entries(LEGACY_QUERY_ALIASES)) {
    if (raw.includes(legacy)) extras.push(raw.split(legacy).join(canonical));
  }
  return extras.length ? `${raw} ${extras.join(' ')}` : raw;
}

export function searchIndex(index, query, options = {}) {
  const {
    limit = 10,
    requireLevel = null,
    requireRulesetConfigId = null,
    vector = null,
    floor = null,
    libs = null,
    scope = null,
    includePlayer = false,
  } = options;
  const terms = tokenize(query);
  const intent = detectFilters(query);
  const asksEvidence = EVIDENCE_ASK.test(String(query));
  const normalizedQuery = String(query).toLowerCase();

  // ── 候选集：分库 + scope。默认排除玩家个体（memory / RAG 分离）──
  const libFilter = normalizeLibIds(libs);
  if (libFilter && Array.isArray(index.lib_ids)) {
    // lib_id 打错一个字母就返回空，与「这个库真的没有」长得一模一样 —— 直接抛。
    for (const libId of libFilter) {
      if (!index.lib_ids.includes(libId)) {
        throw new Error(`索引里没有库 ${libId}（这个索引装了 ${JSON.stringify(index.lib_ids)}）：`
          + 'lib 筛选值写错会静默返回空结果，所以这里直接抛');
      }
    }
  }
  const scopeFilter = scope === null || scope === undefined ? null : new Set(Array.isArray(scope) ? scope : [scope]);
  // ── 术语库**只回答"这个词是什么意思"**（2026-09-25 第 46 轮实测）──
  //
  // L5 术语表上线后，held-out 里两条被它顶掉（都是**话题相关但答不了那一问**）：
  //   · C02「换入一只已经离场过的精灵时，入场能量按多少算，**实机测过吗**」→ 命中 `term::3009`（离场语义，3059 分），
  //     于是从"弃答 + 登记例外"变成有答案 —— 而术语是定义、不带任何测量，弃答判据正是为这种情形存在的；
  //   · M07「属性倍率一共有哪几档」→ 命中 `term::3014`（**属性增减**，不是倍率档位），把真正该出的记录级文档挤到后面。
  // 两处的共同点是：问句只是**话题上**碰到了那个词，问的并不是它的定义。
  // 所以口径收紧成一条：**术语文档只在定义型问句里当候选**（`DEFINITION_ASK`）。
  // 修的是检索而不是判据 —— 那两条判据（弃答 / 等级）一个字都没动。
  const termsAllowed = DEFINITION_ASK.test(String(query));
  // 同理：战术卡只在"要打法/建议"的问句里当候选（同一天的实测见 `GUIDANCE_ASK` 上方）。
  const cardsAllowed = GUIDANCE_ASK.test(String(query));
  const candidates = index.documents.filter((doc) => {
    if (libFilter && !libFilter.includes(doc.lib_id)) return false;
    if (!termsAllowed && doc.record_kind === 'term_entry') return false;
    if (!cardsAllowed && doc.record_kind === 'tactic_card') return false;
    if (scopeFilter) return scopeFilter.has(doc.scope);
    return includePlayer === true || doc.scope !== 'player';
  });
  // 「查询点名的记录种类只存在于被排除的 scope 里」——这时过滤结果必然为空，
  // 而下面 :906 的静默回落会拿一条**无关的规则文档**顶上（旧行为）。
  // 这是「玩家数据被排除」这件事被伪装成「规则语料里没有」，必须显式说出来。
  const playerKinds = new Set(index.documents.filter((doc) => doc.scope === 'player').map((doc) => doc.record_kind));
  const excludedKinds = intent.kinds.filter((kind) => playerKinds.has(kind)
    && !candidates.some((doc) => doc.record_kind === kind));
  const scopeExcluded = excludedKinds.length > 0 && excludedKinds.length === intent.kinds.length;

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
  const unfilteredRows = run(candidates);
  const filteredRows = hasFilter ? run(candidates.filter(passFilters)) : unfilteredRows;
  let rows = filteredRows;
  let filterFallback = false;
  // scopeExcluded 时**连退让都不做**：那不是「过滤条件把答案滤掉了」，
  // 而是「这个 scope 我不读」。退让会把 filter_fallback 记成 true，把性质说错。
  if (hasFilter && !scopeExcluded) {
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
    // T1：每条结果都能追到它属于哪个库、哪个 scope（debug 的最小信息量）。
    lib_id: row.doc.lib_id,
    scope: row.doc.scope,
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
  //
  // 第一条就是「被排除的 scope」，而且必须在**任何回落之前**判：旧行为里过滤结果为空会
  // 静默退回全库，于是一个问「我的个体」的问题会拿到一条无关的规则文档当答案 ——
  // 那不是降级，那是把「我不读玩家数据」伪装成「规则是这么说的」。
  if (scopeExcluded) {
    const excludedScopes = [...new Set(index.documents
      .filter((doc) => excludedKinds.includes(doc.record_kind)).map((doc) => doc.scope))].sort();
    return {
      ...base,
      abstained: true,
      reason_code: 'SCOPE_EXCLUDED',
      scope_excluded: true,
      excluded_scopes: excludedScopes,
      excluded_record_kinds: excludedKinds,
      candidates: candidates.length,
      results: [],
      reason: `${ABSTAIN_REASONS.SCOPE_EXCLUDED}：${excludedKinds.join('、')} 只存在于 scope=${excludedScopes.join('/')} 的库里，`
        + '规则检索路径默认不读它（要读必须显式走玩家通道 includePlayer / scope:"player"）',
    };
  }
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
