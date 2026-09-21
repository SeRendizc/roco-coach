// 版本化环境先验（Meta prior）的共享库。
//
// 为什么单独成库：`scripts/roco/build-meta-prior.mjs`、`scripts/roco/verify-meta-prior.mjs`
// 与 `tests/roco-meta-prior.test.js` 必须跑**同一条判据**。判据一旦被复制成三份，
// 三份就会各自漂移，最后谁也不知道哪一份算数（这条理由抄自 evidence-ledger-lib.mjs）。
//
// 这个库回答一件事：**这份先验有没有把它自己的依据、边界和「不知道」说清楚**。
//
// 它**不**回答的是：环境里哪个体系更强。本仓库现在没有任何真实对局数据，
// 所以「谁强」这个问题的诚实答案是 UNKNOWN——库的全部工作就是让这个 UNKNOWN 填不进去假的数。
//
// 一条判据如果没有必红方向，它真正的状态是「没人知道」。所以每条规则都在
// `AUDIT_RULES` 里写了一句「什么输入必须让它红」，`selftest()` 逐条给反证。

import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BANNED_CLAIM_KEYS,
  COMMUNITY_TIER_WORDS,
  CONFIDENCE_LEVELS,
  DIMENSION_CRITERIA,
  DIMENSIONS,
  PSEUDO_PRECISION_WORDS,
} from '../../src/coach/team-gaps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/**
 * 台账六级与 RC-302 的七维判据**从 RC-302 转出**，不在这里另立一套名字：
 * 等级和判据都只有一份定义（这是 evidence-ledger-lib.mjs 那条理由的同一件事）。
 */
export {CONFIDENCE_LEVELS, DIMENSION_CRITERIA, DIMENSIONS};

// ─────────────────────────────────────────────────────────────────────────
// 路径与标识
// ─────────────────────────────────────────────────────────────────────────

export const META_PRIOR_DIR = join('data', 'roco', 'meta-prior');
export const SCHEMA_PATH = join(META_PRIOR_DIR, 'schema.json');
export const DEFAULT_META_PRIOR_PATH = join(META_PRIOR_DIR, 'v1.json');
export const META_PRIOR_SCHEMA = 'roco-meta-prior/v1';
export const SCHEMA_DOC_SCHEMA = 'roco-meta-prior-schema/v1';
export const META_PRIOR_ID_PREFIX = 'roco-meta-prior/v1#';

/** 先验引用（derived_from）必须指向的仓内产物。先验不是新证据，只是对这些产物的引用。 */
export const DERIVED_FROM_REQUIRED = Object.freeze([
  Object.freeze({role: 'rule_evidence_ledger', path: 'data/roco/evidence/rule-evidence-ledger.json'}),
  Object.freeze({role: 'game_data_pack', path: 'data/roco/game-data-pack/v2/pack.json'}),
  Object.freeze({role: 'ruleset_config', path: 'data/roco/rulesets/legacy-sim-v1.json'}),
  Object.freeze({role: 'catalog_reconciliation', path: 'reports/roco/reconciliation/catalog-reconciliation.json'}),
]);

/** RC-304 要消费的五个口径。少一个，这份先验就没法被 RC-304 真正用上。 */
export const RC304_INPUT_KEYS = Object.freeze([
  'expected_meta_value',
  'worst_archetype',
  'matchup_spread',
  'execution_tolerance',
  'coverage_confidence',
]);

export const AXES = Object.freeze([...DIMENSIONS]);

/**
 * 判据 ID → 轴。**判据 ID 就是 `src/coach/team-gaps.js#DIMENSION_CRITERIA` 的键**，
 * 所以这里不另立一套名字：先验说「靠什么被识别」，指的必须是 RC-302 已经实现的那一条。
 */
export const CRITERION_AXIS = Object.freeze(Object.fromEntries(
  Object.keys(DIMENSION_CRITERIA).map((criterion) => [criterion, criterion])));

export const CRITERION_IDS = Object.freeze(Object.keys(DIMENSION_CRITERIA));

/**
 * 禁止字段（扫的是**键名**，任何层级、包括写成 null）。
 *
 * 为什么连 null 也拦：`win_rate: null` 读起来像「这个字段以后会填」，而不是
 * 「我们不产出这种东西」。禁令必须是结构性的，不能靠值来判断。
 */
export const BANNED_KEYS = Object.freeze([...new Set([
  ...BANNED_CLAIM_KEYS,
  'win_rate',
  'tier',
  'T0',
  't0',
  'strength_score',
  'meta_share',
  'usage_rate',
  'pick_rate',
  'ban_rate',
  'winrate',
  'win_probability',
  'mu',
  'win_ci',
  'tier_list',
  'rank_score',
  'power_score',
  'elo',
  'rating',
])]);

/** 禁止词（扫的是**文本**）。这份是「弱判据」：命中条目会进 `soft_problems`，让人来解释，不直接判红。 */
export const BANNED_WORDS = Object.freeze([...new Set([
  ...COMMUNITY_TIER_WORDS,
  ...PSEUDO_PRECISION_WORDS,
  '占比最高',
  '最强体系',
  '版本答案',
])]);

/**
 * 否定语境：这份先验里大量出现「不许输出胜率 / 没有真实对局数据 / 不是强度榜」这类
 * **声明边界**的句子。判据若把它们也判红，就会逼着实现方不再写「我不输出胜率」——
 * 那正好把最该保留的一句话删掉了。
 *
 * 所以判据是：禁词命中时看它**前面 12 个字符**里有没有否定词；有就算「这是一句否定声明」。
 * 判据仍然有牙：直接写「这只的胜率是 62%」没有否定词，照样进 soft_problems。
 * 而**键名**（win_rate 等）不受这个豁免（见 walkKeys）。
 */
export const NEGATION_MARKERS = Object.freeze([
  '不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '而非', '绝非',
  '不输出', '不产出', '不在', '任何',
]);

function isNegatedClaim(text, at) {
  const window = String(text).slice(Math.max(0, at - 12), at);
  return NEGATION_MARKERS.some((marker) => window.includes(marker));
}

/** 判据的「必红方向」：每条审计规则一句方向说明（报告里逐条贴出来）。 */
export const AUDIT_RULES = Object.freeze([
  Object.freeze({code: 'SCHEMA', direction: '顶层 schema / meta_prior_id 不对，或版本作用域缺赛季、ruleset_id、ruleset_config_id、as_of 里的任意一项 ⇒ 红'}),
  Object.freeze({code: 'BANNED_KEY', direction: '任何层级出现胜率 / 榜单 / 强度分一类**键名**（写成 null 也算）⇒ 红'}),
  Object.freeze({code: 'ARCHETYPE_SHAPE', direction: '体系缺必填字段、archetype_id 不合 ^[a-z][a-z0-9_]*$、或 archetype_id 重复 ⇒ 红'}),
  Object.freeze({code: 'SEED_SPECIES', direction: '`seed_species[]` 里的物种在 pack 的 pet 实体里不存在 ⇒ 红（写了一个不存在的精灵名，等于编造环境里有它）'}),
  Object.freeze({code: 'SEED_SELECTION', direction: '体系没有任何种子物种却不声明 seed_selection.source="none_available" 且 needs_recording 为空 ⇒ 红'}),
  Object.freeze({code: 'CRITERION', direction: 'feature_axes[].criterion 不是 RC-302 已实现的判据 ID（自创形容词）⇒ 红'}),
  Object.freeze({code: 'EVIDENCE', direction: '某条 evidence 的 ref 既不是 http(s)、也不是仓里真实存在的文件，或缺 date / confidence ⇒ 红'}),
  Object.freeze({code: 'CONFIDENCE', direction: 'confidence 用了台账六级之外的等级 ⇒ 红'}),
  Object.freeze({code: 'DISTRIBUTION', direction: 'distribution 缺某个体系的一条；`measured` 却没有来源 → 红；`unknown` 却带非 null value 或没有 reason → 红'}),
  Object.freeze({code: 'USAGE', direction: 'usage.inputs 缺 RC-304 的五个口径之一，或某个口径没有可读说明 ⇒ 红'}),
  Object.freeze({code: 'DERIVED_FROM', direction: 'derived_from 缺必需角色、引用的文件不存在、或 sha256 与磁盘不一致 ⇒ 红（先验引用的产物已经变了）'}),
  Object.freeze({code: 'CHECK', direction: '`--check` 时磁盘上的 v1.json 与重新构建的结果不一致（含排序）⇒ 红'}),
]);

// ─────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const arr = (value) => (Array.isArray(value) ? value : []);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 逐字节稳定的序列化：键按字典序，绝不出现挂钟时间戳。 */
export function stableStringify(value, indent = 2) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isPlainObject(input)) {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = canonical(input[key]);
      return out;
    }
    return input;
  };
  return `${JSON.stringify(canonical(value), null, indent)}\n`;
}

/** 先验 ID：对「去掉 meta_prior_id 之后的正文」做 sha256。改一个字节，ID 就变。 */
export function computeMetaPriorId(document) {
  const {meta_prior_id: _ignored, ...body} = document || {};
  return `${META_PRIOR_ID_PREFIX}${sha256(stableStringify(body, 0)).slice(0, 16)}`;
}

/** 读 JSON；失败返回 null（调用方负责记一条问题，不要抛）。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 审计问题：`{code, where, detail}`。 */
export const problem = (code, where, detail) => ({code, where, detail});
export const formatProblem = (p) => `[${p.code}] ${p.where}：${p.detail}`;

// ─────────────────────────────────────────────────────────────────────────
// 仓内可核对的数据面
// ─────────────────────────────────────────────────────────────────────────

function packEntities(pack) {
  const out = [];
  for (const value of Object.values(pack?.sections || {})) {
    for (const entity of arr(value?.entities)) out.push(entity);
  }
  return out;
}

/**
 * 把仓里真正能核对的东西读进来（只读）。
 *
 * `pack.petNames` 是 `seed_species` 的核对面：一个物种名如果在里面找不到，
 * 就说明先验写了一个环境里不存在的精灵。
 */
export function loadRepoData({root = ROOT} = {}) {
  const pack = readJson(join(root, 'data', 'roco', 'game-data-pack', 'v2', 'pack.json'));
  const ledger = readJson(join(root, 'data', 'roco', 'evidence', 'rule-evidence-ledger.json'));
  const rulesets = {};
  for (const rel of ['legacy-sim-v1.json', 'mobile-s4-candidate-v2.json']) {
    const data = readJson(join(root, 'data', 'roco', 'rulesets', rel));
    if (data) rulesets[rel.replace(/\.json$/, '')] = data;
  }
  const entities = pack ? packEntities(pack) : [];
  const pets = entities.filter((entity) => entity?.group === 'pet');
  const petNames = new Set(pets.map((entity) => entity?.name).filter(Boolean));
  const byId = new Map(pets.map((entity) => [entity?.id, entity]));
  return {
    root,
    pack,
    ledger,
    rulesets,
    packPetEntities: pets,
    packPetIds: pets.map((entity) => entity?.id).filter(Boolean).sort(),
    petNames,
    petById: byId,
    petForms: pets.filter((entity) => entity?.record_kind === 'pet_form'),
    petRecords: pets.filter((entity) => entity?.record_kind === 'pet_record'),
    confidenceLevels: arr(ledger?.confidence_levels).map((row) => row?.id).filter(Boolean),
  };
}

/** 先验给出的版本作用域是否与 pack 的规则绑定一致。 */
export function checkScopeAgainstRepo(metaPrior, repo) {
  const problems = [];
  const binding = repo.pack?.ruleset_binding || {};
  const scope = metaPrior?.version_scope || {};
  const add = (where, detail) => problems.push(problem('SCHEMA', where, detail));
  if (scope.ruleset_id && binding.ruleset_id && scope.ruleset_id !== binding.ruleset_id) {
    add('version_scope.ruleset_id',
      `先验写的是 ${JSON.stringify(scope.ruleset_id)}，pack 的规则绑定是 ${JSON.stringify(binding.ruleset_id)}`);
  }
  if (scope.ruleset_config_id && binding.ruleset_config_id
      && scope.ruleset_config_id !== binding.ruleset_config_id) {
    add('version_scope.ruleset_config_id',
      `先验写的是 ${JSON.stringify(scope.ruleset_config_id)}，pack 的规则绑定是 ${JSON.stringify(binding.ruleset_config_id)}`);
  }
  if (scope.ruleset_id && repo.ledger?.ruleset_id && scope.ruleset_id !== repo.ledger.ruleset_id) {
    add('version_scope.ruleset_id',
      `先验写的是 ${JSON.stringify(scope.ruleset_id)}，台账的 ruleset_id 是 ${JSON.stringify(repo.ledger.ruleset_id)}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────
// 判据
// ─────────────────────────────────────────────────────────────────────────

function walkKeys(value, path, hits, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, `${path}[${index}]`, hits, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (BANNED_KEYS.includes(key)) hits.push({path: path ? `${path}.${key}` : key, key});
    walkKeys(item, path ? `${path}.${key}` : key, hits, depth + 1);
  }
}

function walkText(value, path, hits, depth = 0) {
  if (depth > 12 || value === null) return;
  if (typeof value === 'string') {
    for (const word of BANNED_WORDS) {
      const at = value.indexOf(word);
      if (at < 0 || isNegatedClaim(value, at)) continue;
      hits.push({path, word});
    }
    const pct = value.match(/%/);
    if (pct && /(胜|概率|强|率)/.test(value) && !isNegatedClaim(value, pct.index)) {
      hits.push({path, word: '%（伪精确百分数）'});
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkText(item, `${path}[${index}]`, hits, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) walkText(item, path ? `${path}.${key}` : key, hits, depth + 1);
}

/** 证据引用是不是**可核对**：http(s)，或仓里真实存在的文件（允许 #... 指针后缀）。 */
export function refResolvable(ref, {root = ROOT} = {}) {
  if (typeof ref !== 'string' || !ref.trim()) return {ok: false, kind: 'empty'};
  const raw = ref.split('#')[0].trim();
  if (/^https?:\/\//.test(raw)) return {ok: true, kind: 'url', absolute: raw};
  if (raw.startsWith('/')) return {ok: existsSync(raw), kind: 'absolute', absolute: raw};
  const absolute = join(root, raw);
  return {ok: existsSync(absolute), kind: 'repo_file', absolute};
}

/**
 * 逐条校验一份先验。返回 `{ok, problems, soft_problems, criteria, summary}`。
 *
 * `options.repo` 允许注入内存里的仓数据（测试与先验构建器用）；
 * `options.repoData` 允许让 derived_from 的 sha256 对着**内存副本**核对
 * （反证里改坏的是内存副本，不落盘改真产物）。
 */
export function validateMetaPrior(metaPrior, options = {}) {
  const repo = options.repo ?? loadRepoData({root: options.root ?? ROOT});
  const root = repo.root ?? options.root ?? ROOT;
  const problems = [];
  const soft = [];
  const add = (code, where, detail) => problems.push(problem(code, where, detail));
  // 弱判据的条目形状是 `{code, where, word, detail}`：它和必红问题**不同形**，
  // 这样调用方不会把「需要人解释」误当成「必须修」。
  const soften = (where, word, text) => soft.push({code: 'BANNED_WORD', where, word, detail: text});

  if (!isPlainObject(metaPrior)) {
    return {
      ok: false,
      problems: [problem('SCHEMA', 'meta_prior', '先验不是对象')],
      soft_problems: [],
      criteria: [],
      summary: {},
    };
  }

  // ① 顶层。
  if (metaPrior.schema !== META_PRIOR_SCHEMA) {
    add('SCHEMA', 'schema', `schema 是 ${JSON.stringify(metaPrior.schema ?? null)}，应为 ${META_PRIOR_SCHEMA}`);
  }
  const expectedId = computeMetaPriorId(metaPrior);
  if (metaPrior.meta_prior_id !== expectedId) {
    add('SCHEMA', 'meta_prior_id',
      `meta_prior_id 是 ${JSON.stringify(metaPrior.meta_prior_id ?? null)}，按正文重算应为 ${expectedId}`);
  }

  // ② 版本作用域：四项缺一不可。
  const scope = metaPrior.version_scope;
  const scopeFields = ['season', 'ruleset_id', 'ruleset_config_id', 'as_of'];
  if (!isPlainObject(scope)) {
    add('SCHEMA', 'version_scope', `version_scope 必须是对象，实际 ${JSON.stringify(scope ?? null)}`);
  } else {
    for (const field of scopeFields) {
      const value = scope[field];
      if (typeof value !== 'string' || !value.trim()) {
        add('SCHEMA', `version_scope.${field}`,
          `版本作用域的 ${field} 缺失或为空（实际值 ${JSON.stringify(value ?? null)}）——缺它这份先验就说不清管的是哪一版`);
      }
    }
    if (typeof scope.as_of === 'string' && scope.as_of.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(scope.as_of)) {
      add('SCHEMA', 'version_scope.as_of', `as_of 必须是 YYYY-MM-DD，实际 ${JSON.stringify(scope.as_of)}`);
    }
  }
  problems.push(...checkScopeAgainstRepo(metaPrior, repo));

  // ③ derived_from：先验只是引用，引用必须对得上磁盘。
  const derived = arr(metaPrior.derived_from);
  if (!derived.length) add('DERIVED_FROM', 'derived_from', 'derived_from 不能为空：先验必须说清它引用了哪些产物');
  const derivedByRole = new Map();
  derived.forEach((row, index) => {
    const where = `derived_from[${index}]`;
    if (!isPlainObject(row)) {
      add('DERIVED_FROM', where, '引用项不是对象');
      return;
    }
    for (const field of ['path', 'sha256', 'role']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) {
        add('DERIVED_FROM', `${where}.${field}`, `缺少非空字段 ${field}`);
      }
    }
    if (typeof row.sha256 === 'string' && row.sha256.trim() && !/^[0-9a-f]{64}$/.test(row.sha256)) {
      add('DERIVED_FROM', `${where}.sha256`, `sha256 必须是 64 位小写十六进制，实际 ${JSON.stringify(row.sha256)}`);
    }
    if (typeof row.path === 'string' && row.path.trim()) {
      derivedByRole.set(row.role, row);
      const injected = options.repoData?.[row.path];
      const absolute = join(root, row.path);
      const text = typeof injected === 'string' ? injected : (existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
      if (text === null) {
        add('DERIVED_FROM', `${where}.path`, `引用的文件不存在：${row.path}`);
      } else if (typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256)) {
        const actual = sha256(text);
        if (actual !== row.sha256) {
          add('DERIVED_FROM', `${where}.sha256`,
            `${row.path} 的 sha256 与磁盘不一致：先验写 ${row.sha256}，磁盘是 ${actual}`);
        }
      }
    }
  });
  for (const required of DERIVED_FROM_REQUIRED) {
    const row = derivedByRole.get(required.role);
    if (!row) {
      add('DERIVED_FROM', 'derived_from', `缺少角色 ${required.role}（应指向 ${required.path}）`);
    } else if (row.path !== required.path) {
      add('DERIVED_FROM', `derived_from[role=${required.role}]`,
        `角色 ${required.role} 指向 ${row.path}，应为 ${required.path}`);
    }
  }

  // ④ claim：说清这份先验**含**什么、**不含**什么。
  const claim = metaPrior.claim;
  if (!isPlainObject(claim)) {
    add('SCHEMA', 'claim', `claim 必须是对象，实际 ${JSON.stringify(claim ?? null)}`);
  } else {
    for (const field of ['contains', 'does_not_contain']) {
      const value = claim[field];
      if (!Array.isArray(value) || !value.length) {
        add('SCHEMA', `claim.${field}`, `${field} 必须是非空数组（实际 ${JSON.stringify(value ?? null)}）`);
      } else if (value.some((line) => typeof line !== 'string' || !line.trim())) {
        add('SCHEMA', `claim.${field}`, `${field} 里每一项都必须是非空字符串`);
      }
    }
  }

  // ⑤ 体系。
  const archetypes = arr(metaPrior.archetypes);
  if (!archetypes.length) add('ARCHETYPE_SHAPE', 'archetypes', 'archetypes 不能为空');
  const archetypeIds = [];
  archetypes.forEach((archetype, index) => {
    const where = `archetypes[${index}]`;
    if (!isPlainObject(archetype)) {
      add('ARCHETYPE_SHAPE', where, '体系不是对象');
      return;
    }
    const id = typeof archetype.archetype_id === 'string' ? archetype.archetype_id : `(缺 id @${index})`;
    const at = `archetypes[${id}]`;
    archetypeIds.push(archetype.archetype_id);
    if (typeof archetype.archetype_id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(archetype.archetype_id)) {
      add('ARCHETYPE_SHAPE', `${at}.archetype_id`,
        `archetype_id 必须匹配 ^[a-z][a-z0-9_]*$，实际 ${JSON.stringify(archetype.archetype_id ?? null)}`);
    }
    for (const field of ['label', 'label_source', 'notes']) {
      if (typeof archetype[field] !== 'string' || !archetype[field].trim()) {
        add('ARCHETYPE_SHAPE', `${at}.${field}`, `${field} 不能为空`);
      }
    }
    if (!CONFIDENCE_LEVELS.includes(archetype.confidence)) {
      add('CONFIDENCE', `${at}.confidence`,
        `confidence 不在台账六级里：${JSON.stringify(archetype.confidence ?? null)}（六级 = ${CONFIDENCE_LEVELS.join(' / ')}）`);
    }

    // ⑤-1 种子物种必须在 pack 里真实存在。
    const seeds = arr(archetype.seed_species);
    const selection = archetype.seed_selection;
    if (!isPlainObject(selection)) {
      add('SEED_SELECTION', `${at}.seed_selection`, 'seed_selection 必须是对象（说明种子是「名称命中」还是「可复算选择器的代表元」）');
    }
    const selectionSource = isPlainObject(selection) ? selection.source : null;
    if (!seeds.length) {
      const hasReason = isPlainObject(selection) && typeof selection.note === 'string' && selection.note.trim().length >= 8;
      const needsRecording = arr(archetype.needs_recording).length > 0;
      if (selectionSource !== 'none_available' || !hasReason || !needsRecording) {
        add('SEED_SPECIES', `${at}.seed_species`,
          '没有种子物种时，必须声明 seed_selection.source="none_available"、写清 note、并且 needs_recording 非空'
          + `（实际 source=${JSON.stringify(selectionSource)}、needs_recording=${arr(archetype.needs_recording).length} 条）`);
      }
    }
    seeds.forEach((seed, seedIndex) => {
      const seedWhere = `${at}.seed_species[${seedIndex}]`;
      if (typeof seed !== 'string' || !seed.trim()) {
        add('SEED_SPECIES', seedWhere, `种子物种必须是非空字符串（实际 ${JSON.stringify(seed ?? null)}）`);
        return;
      }
      if (!repo.petNames.has(seed)) {
        add('SEED_SPECIES', seedWhere, `${seed} 不在 pack 的 pet 实体里（pack 现有 ${repo.petNames.size} 个名字）——先验不许写环境里不存在的精灵`);
      }
    });

    // ⑤-2 特征轴必须复用的是 RC-302 已经实现的判据。
    const axes = arr(archetype.feature_axes);
    if (!axes.length) add('CRITERION', `${at}.feature_axes`, 'feature_axes 不能为空：说不清靠什么特征被识别');
    axes.forEach((axis, axisIndex) => {
      const axisWhere = `${at}.feature_axes[${axisIndex}]`;
      if (!isPlainObject(axis)) {
        add('CRITERION', axisWhere, '特征轴不是对象');
        return;
      }
      if (!AXES.includes(axis.axis)) {
        add('CRITERION', `${axisWhere}.axis`, `axis 不在 RC-302 的七维里：${JSON.stringify(axis.axis ?? null)}`);
      }
      if (!CRITERION_IDS.includes(axis.criterion)) {
        add('CRITERION', `${axisWhere}.criterion`,
          `criterion 不是 src/coach/team-gaps.js#DIMENSION_CRITERIA 的判据 ID：${JSON.stringify(axis.criterion ?? null)}`
          + `（合法 ID：${CRITERION_IDS.join(' / ')}）——先验不许自创形容词`);
      } else if (axis.axis !== CRITERION_AXIS[axis.criterion]) {
        add('CRITERION', `${axisWhere}.axis`,
          `判据 ${axis.criterion} 属于 ${CRITERION_AXIS[axis.criterion]} 轴，写成了 ${JSON.stringify(axis.axis)}`);
      }
      if (typeof axis.how !== 'string' || axis.how.trim().length < 8) {
        add('CRITERION', `${axisWhere}.how`, 'how 必须写清这条判据在这个体系上具体怎么算（至少 8 个字符）');
      }
    });

    // ⑤-3 证据逐条可核对。
    const evidenceRows = arr(archetype.evidence);
    if (!evidenceRows.length) add('EVIDENCE', `${at}.evidence`, 'evidence 不能为空：没有任何依据的体系不许进先验');
    evidenceRows.forEach((row, evidenceIndex) => {
      const evidenceWhere = `${at}.evidence[${evidenceIndex}]`;
      if (!isPlainObject(row)) {
        add('EVIDENCE', evidenceWhere, '证据不是对象');
        return;
      }
      if (!CONFIDENCE_LEVELS.includes(row.confidence)) {
        add('CONFIDENCE', `${evidenceWhere}.confidence`,
          `confidence 不在台账六级里：${JSON.stringify(row.confidence ?? null)}`);
      }
      if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
        add('EVIDENCE', `${evidenceWhere}.date`, `date 必须是 YYYY-MM-DD，实际 ${JSON.stringify(row.date ?? null)}`);
      }
      if (typeof row.claim !== 'string' || row.claim.trim().length < 8) {
        add('EVIDENCE', `${evidenceWhere}.claim`, 'claim 必须写清这条来源支撑了什么（至少 8 个字符）');
      }
      const resolved = refResolvable(row.ref, {root});
      if (!resolved.ok) {
        add('EVIDENCE', `${evidenceWhere}.ref`,
          `ref 既不是 http(s)、也不是仓里真实存在的文件：${JSON.stringify(row.ref ?? null)}`);
      }
      // 逐条证据还要能被**台账**核对：等级与首要来源都以台账为准，抄一份就会漂移。
      if (typeof row.ledger_entry === 'string' && row.ledger_entry.startsWith('EV-')) {
        const entry = arr(repo.ledger?.entries).find((item) => item?.id === row.ledger_entry);
        if (!entry) {
          add('EVIDENCE', `${evidenceWhere}.ledger_entry`,
            `台账里没有 ${row.ledger_entry}（“我们记在台账里了”如果台账里没有，和没记是一样的）`);
        } else {
          if (entry.confidence !== row.confidence) {
            add('CONFIDENCE', `${evidenceWhere}.confidence`,
              `台账 ${row.ledger_entry} 的等级是 ${entry.confidence}，这里写的是 ${row.confidence}（等级只能与台账一致）`);
          }
          const primary = arr(entry.sources).find((source) => typeof source?.url === 'string' && source.url.trim());
          if (primary && typeof row.ref === 'string' && row.ref !== primary.url) {
            add('EVIDENCE', `${evidenceWhere}.ref`,
              `台账 ${row.ledger_entry} 的首要来源是 ${JSON.stringify(primary.url)}，这里写的是 ${JSON.stringify(row.ref)}`);
          }
        }
      }
    });

    // ⑤-4 缺什么实机证据：必须是数组（可以为空，但字段不能缺）。
    if (!Array.isArray(archetype.needs_recording)) {
      add('ARCHETYPE_SHAPE', `${at}.needs_recording`,
        `needs_recording 必须是数组（实际 ${JSON.stringify(archetype.needs_recording ?? null)}）`);
    }
  });
  const duplicated = archetypeIds.filter((id, index) => archetypeIds.indexOf(id) !== index);
  if (duplicated.length) add('ARCHETYPE_SHAPE', 'archetypes', `archetype_id 重复：${[...new Set(duplicated)].join('/')}`);

  // ⑥ distribution：只有两种合法形态。
  const distribution = arr(metaPrior.distribution);
  if (!distribution.length) add('DISTRIBUTION', 'distribution', 'distribution 不能为空');
  const distSeen = new Set();
  distribution.forEach((row, index) => {
    const where = `distribution[${index}]`;
    if (!isPlainObject(row)) {
      add('DISTRIBUTION', where, '分布项不是对象');
      return;
    }
    const at = `distribution[${row.archetype_id ?? `@${index}`}]`;
    distSeen.add(row.archetype_id);
    if (typeof row.archetype_id !== 'string' || !row.archetype_id.trim()) {
      add('DISTRIBUTION', `${at}.archetype_id`, 'archetype_id 不能为空');
    } else if (!archetypeIds.includes(row.archetype_id)) {
      add('DISTRIBUTION', `${at}.archetype_id`, `${row.archetype_id} 不在 archetypes[] 里（分布必须逐体系给出）`);
    }
    if (row.source === 'measured') {
      if (Array.isArray(row.sources) && row.sources.length) {
        row.sources.forEach((source, sourceIndex) => {
          const sourceWhere = `${at}.sources[${sourceIndex}]`;
          if (!isPlainObject(source)) {
            add('DISTRIBUTION', sourceWhere, '来源不是对象');
            return;
          }
          if (!CONFIDENCE_LEVELS.includes(source.confidence)) {
            add('CONFIDENCE', `${sourceWhere}.confidence`, `confidence 不在台账六级里：${JSON.stringify(source.confidence ?? null)}`);
          }
          if (typeof source.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.date)) {
            add('EVIDENCE', `${sourceWhere}.date`, `date 必须是 YYYY-MM-DD，实际 ${JSON.stringify(source.date ?? null)}`);
          }
          const resolved = refResolvable(source.ref, {root});
          if (!resolved.ok) {
            add('EVIDENCE', `${sourceWhere}.ref`, `ref 不可核对：${JSON.stringify(source.ref ?? null)}`);
          }
        });
      } else {
        add('DISTRIBUTION', `${at}.sources`,
          'source="measured" 却没有任何来源：占比必须逐条给 url/文件 + 日期 + 等级，缺来源的数值一律不合法');
      }
      if (!Number.isFinite(row.value)) {
        add('DISTRIBUTION', `${at}.value`, `source="measured" 时 value 必须是有限数值，实际 ${JSON.stringify(row.value ?? null)}`);
      }
      const valueSource = row.value_source;
      const valueSourceLegal = isPlainObject(valueSource)
        && (valueSource.availability === 'not_available'
          || (valueSource.availability === 'available' && refResolvable(valueSource.ref, {root}).ok));
      if (!valueSourceLegal) {
        add('DISTRIBUTION', `${at}.value_source`,
          'measured 必须写清这个数值本身出自哪里：value_source.availability ∈ {available, not_available}，'
          + 'available 时 ref 必须可核对');
      }
    } else if (row.source === 'unknown') {
      if (row.value !== null) {
        add('DISTRIBUTION', `${at}.value`,
          `source="unknown" 时 value 必须是 null，实际 ${JSON.stringify(row.value ?? null)}`
          + '（我们没有任何真实对局数据，不许用看起来合理的数字填充）');
      }
      if (typeof row.reason !== 'string' || row.reason.trim().length < 12) {
        add('DISTRIBUTION', `${at}.reason`,
          `source="unknown" 时必须写清原因（至少 12 个字符），实际 ${JSON.stringify(row.reason ?? null)}`);
      }
      if (row.sources !== undefined && row.sources !== null && arr(row.sources).length) {
        add('DISTRIBUTION', `${at}.sources`,
          'source="unknown" 却挂了 sources：要么它是 measured，要么把来源删掉——挂来源会让「不知道」看起来像有依据');
      }
    } else {
      add('DISTRIBUTION', `${at}.source`,
        `source 只能是 measured 或 unknown，实际 ${JSON.stringify(row.source ?? null)}`);
    }
  });
  for (const id of archetypeIds) {
    if (!distSeen.has(id)) add('DISTRIBUTION', `distribution[${id}]`, `archetypes[] 里的 ${id} 在 distribution 里没有对应项`);
  }
  const distSummary = {
    measured: distribution.filter((row) => row?.source === 'measured').length,
    unknown: distribution.filter((row) => row?.source === 'unknown').length,
  };

  // ⑦ usage：RC-304 的输入口径，写成字段说明。
  const usage = metaPrior.usage;
  if (!isPlainObject(usage)) {
    add('USAGE', 'usage', `usage 必须是对象，实际 ${JSON.stringify(usage ?? null)}`);
  } else {
    if (typeof usage.consumer !== 'string' || !usage.consumer.trim()) {
      add('USAGE', 'usage.consumer', 'usage.consumer 必须写清谁消费这份先验（预期是 RC-304）');
    }
    for (const field of ['fields', 'not_in_scope']) {
      if (typeof usage[field] !== 'string' || usage[field].trim().length < 12) {
        add('USAGE', `usage.${field}`, `usage.${field} 必须是一段可读说明（至少 12 个字符）`);
      }
    }
    if (typeof usage.honesty !== 'string' || usage.honesty.trim().length < 12) {
      add('USAGE', 'usage.honesty', 'usage.honesty 必须写清这份先验「不能用来做什么」');
    }
    if (!isPlainObject(usage.inputs)) {
      add('USAGE', 'usage.inputs', 'usage.inputs 必须是对象');
    } else {
      for (const key of RC304_INPUT_KEYS) {
        const entry = usage.inputs[key];
        if (!isPlainObject(entry)) {
          add('USAGE', `usage.inputs.${key}`, `缺少 RC-304 输入口径 ${key}`);
          continue;
        }
        if (typeof entry.definition !== 'string' || entry.definition.trim().length < 12) {
          add('USAGE', `usage.inputs.${key}.definition`, `${key}.definition 必须写清这个口径的定义（至少 12 个字符）`);
        }
        if (!Array.isArray(entry.inputs) || !entry.inputs.length) {
          add('USAGE', `usage.inputs.${key}.inputs`, `${key}.inputs 必须是非空数组：说清它吃哪些字段`);
        } else if (entry.inputs.some((line) => typeof line !== 'string' || !line.trim())) {
          add('USAGE', `usage.inputs.${key}.inputs`, `${key}.inputs 里每一项都必须是非空字符串`);
        }
        if (typeof entry.honesty !== 'string' || entry.honesty.trim().length < 8) {
          add('USAGE', `usage.inputs.${key}.honesty`, `${key}.honesty 必须写清这条口径的诚实边界`);
        }
      }
      const extra = Object.keys(usage.inputs).filter((key) => !RC304_INPUT_KEYS.includes(key));
      if (extra.length) add('USAGE', 'usage.inputs', `出现 RC-304 口径之外的多余键：${extra.join('/')}`);
    }
  }

  // ⑧ 禁止字段：任何层级、包括写成 null。
  const keyHits = [];
  walkKeys(metaPrior, '', keyHits);
  for (const hit of keyHits) {
    add('BANNED_KEY', hit.path,
      '这是禁令字段名（禁令与 RC-302 BANNED_CLAIM_KEYS 同源）：它要么给出胜率/榜单式的伪精确结论，'
      + '要么让人以为这份先验以后会填它。写 null 也不允许——禁令必须是结构性的。');
  }

  // ⑨ 禁止词：弱判据（不判红，但必须有人解释）。
  const wordHits = [];
  walkText(metaPrior, '', wordHits);
  for (const hit of wordHits) {
    soften(hit.path, hit.word, `文本里出现禁词「${hit.word}」，而它前面 12 个字符里没有任何否定词`);
  }

  // ⑩ 判据与实测：报告里逐条贴出的东西。
  const evidenceRows = archetypes.flatMap((archetype) => arr(archetype?.evidence));
  const confidenceHistogram = Object.fromEntries(CONFIDENCE_LEVELS.map((level) => [level, 0]));
  for (const row of evidenceRows) {
    if (Object.hasOwn(confidenceHistogram, row?.confidence)) confidenceHistogram[row.confidence] += 1;
  }
  const criteria = [
    {
      code: 'no_banned_key',
      criteria: '递归扫先验的全部键名；命中 scripts/roco/meta-prior-lib.mjs#BANNED_KEYS（与 RC-302 BANNED_CLAIM_KEYS 同源）即红。',
      actual: `命中 ${keyHits.length} 条：${keyHits.map((h) => h.key).join('/') || '(无)'}`,
      ok: keyHits.length === 0,
    },
    {
      code: 'seed_species_in_pack',
      criteria: '每个 seed_species 名字必须在 pack.json 的 pet 实体 name 集合里逐字命中。',
      actual: `种子物种 ${archetypes.reduce((sum, a) => sum + arr(a?.seed_species).length, 0)} 个，pack pet 名字 ${repo.petNames.size} 个`,
      ok: problems.every((p) => p.code !== 'SEED_SPECIES'),
    },
    {
      code: 'criteria_reuse_rc302',
      criteria: `每个 feature_axes[].criterion 必须 ∈ ${CRITERION_IDS.join(' / ')}（src/coach/team-gaps.js#DIMENSION_CRITERIA）。`,
      actual: `用到判据：${[...new Set(archetypes.flatMap((a) => arr(a?.feature_axes).map((x) => x?.criterion)))].join('/') || '(无)'}`,
      ok: problems.every((p) => p.code !== 'CRITERION'),
    },
    {
      code: 'distribution_shape',
      criteria: 'measured ⇒ 至少一条可核对来源 + 有限数值 + value_source；unknown ⇒ value === null + reason 非空。',
      actual: `measured ${distSummary.measured} 项 / unknown ${distSummary.unknown} 项（共 ${archetypes.length} 个体系）`,
      ok: problems.every((p) => p.code !== 'DISTRIBUTION'),
    },
    {
      code: 'confidence_six_levels',
      criteria: `体系与逐条证据的 confidence 只能取台账六级：${CONFIDENCE_LEVELS.join(' / ')}。`,
      actual: JSON.stringify(confidenceHistogram),
      ok: problems.every((p) => p.code !== 'CONFIDENCE'),
    },
    {
      code: 'derived_from_hash',
      criteria: 'derived_from 每条的 sha256 必须等于磁盘上该文件的 sha256（先验只是引用，引用漂移即红）。',
      actual: `引用 ${derived.length} 项：${derived.map((row) => row?.path).filter(Boolean).join(' / ') || '(无)'}`,
      ok: !problems.some((p) => p.code === 'DERIVED_FROM' && /sha256/.test(p.where)),
    },
  ];

  const summary = {
    schema: metaPrior.schema ?? null,
    meta_prior_id: metaPrior.meta_prior_id ?? null,
    archetypes: archetypes.length,
    archetype_ids: archetypeIds.filter(Boolean),
    evidence: evidenceRows.length,
    evidence_confidence: confidenceHistogram,
    distribution: distSummary,
    distribution_source: distSummary.measured > 0 ? 'measured' : (distSummary.unknown > 0 ? 'unknown' : null),
    seed_species: archetypes.reduce((sum, a) => sum + arr(a?.seed_species).length, 0),
    criteria_used: [...new Set(archetypes.flatMap((a) => arr(a?.feature_axes).map((x) => x?.criterion)).filter(Boolean))].sort(),
    needs_recording: archetypes.reduce((sum, a) => sum + arr(a?.needs_recording).length, 0),
    version_scope: isPlainObject(scope) ? scope : null,
    soft_problems: soft.length,
  };

  return {ok: problems.length === 0, problems, soft_problems: soft, criteria, summary};
}

/** 从磁盘上读一份先验并校验。 */
export function checkRepo({root = ROOT, metaPriorPath = null, repo = null, repoData = null} = {}) {
  const path = metaPriorPath || join(root, DEFAULT_META_PRIOR_PATH);
  const metaPrior = readJson(path);
  if (!metaPrior) {
    return {
      ok: false,
      problems: [problem('SCHEMA', 'meta_prior', `读不到或不是合法 JSON：${path}`)],
      soft_problems: [],
      criteria: [],
      summary: {},
      meta_prior_path: path,
    };
  }
  const report = validateMetaPrior(metaPrior, {root, repo: repo ?? loadRepoData({root}), repoData});
  report.meta_prior_path = resolve(path);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────
// 内容面：从 RC-302 注册的判据里取「体系靠什么被识别」
// ─────────────────────────────────────────────────────────────────────────

/** 一条特征轴：判据 ID 必须真的是 `DIMENSION_CRITERIA` 的键，`how` 说清它在这个体系上怎么算。 */
const axis = (criterion, how) => {
  if (!Object.hasOwn(DIMENSION_CRITERIA, criterion)) {
    throw new Error(`判据 ID ${criterion} 不在 RC-302 的 DIMENSION_CRITERIA 里，先验不许自创判据`);
  }
  return Object.freeze({axis: criterion, criterion, how});
};

/** 证据的等级不能高于它支撑的结论（抄自 evidence-ledger-lib.mjs 的同名约束）。 */
function weakerOf(levels) {
  const sorted = [...levels].sort((a, b) => CONFIDENCE_LEVELS.indexOf(a) - CONFIDENCE_LEVELS.indexOf(b));
  return sorted[sorted.length - 1] || 'UNKNOWN';
}

const TOTAL_UNKNOWN_REASON = '仓库里没有任何真实对局数据（录屏 / 匿名对局 / 离线联赛产物都没有），'
  + '所以「各体系在环境里占多少」这个问题现在没有可核对的来源。按契约，unknown + value: null + reason 是**唯一**合法写法：'
  + '拿一个看起来合理的数字填进去，会让后面所有「对版本环境的期望表现」都建在一个编出来的分母上。';

const PER_ARCHETYPE_UNKNOWN_REASON = '即使将来有了真实对局数据，这一条也要给出**逐条可核对的来源**（url 或仓内文件 + 日期 + 等级）才能从 unknown 改成 measured；'
  + '现在连一次真实匹配的记录都没有。';

/**
 * 体系种子的定义表。
 *
 * `seedSelection` 里写的是**怎么选出这批种子**：`named_in_authority` 是名称在权威文档里被点名，
 * 另外两种是「RC-302 已有的可复算判据在这个 pack 上的选择结果」。两种都不允许手写一个排名。
 */
export const ARCHETYPE_SEEDS = Object.freeze([
  Object.freeze({
    archetype_id: 'poison_stack',
    label: '毒系消耗',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3'
      + '（「毒、翼王、陨星、萌化、冰、沙暴、武等体系作为版本 archetype seed」）',
    selector: Object.freeze({kind: 'type_tag_main_forms', type: '毒系'}),
    defaultSeeds: Object.freeze(['厉毒修萝', '古啦多', '千棘盔']),
    axes: Object.freeze([
      axis('coverage', '把成员的属性组合按 types.join("|") 拼成防御键查 types.json：数「队伍里能接住某个攻击系别」的成员比例。'),
      axis('synergy', '对每个成员数 answers(m,T)（其余成员里能接 T 的个数）与 shared(T)：毒系队伍同一弱点堆叠会被直接数出来。'),
      axis('respond', '从冻结 learnsets 的学招池里按 skills[].desc 词条数「应对攻击 / 应对状态 / 应对防御」出现次数。'),
      axis('energy', '取成员具体 build 的四个技能在 skills.json 的 energy，算 min / max / 合计 / 零费技能数。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'doc-13-4', 'ledger-EV-TYPE-MULTIPLIER']),
    needsRecording: Object.freeze([
      '标准 PVP 里「毒」系队伍的实机出场与胜负记录（当前一条都没有）',
      '中毒 / 剧毒类状态的具体结算时序 microcase（对齐 MC-007 系列）',
    ]),
    notes: '毒系在台账里唯一有分级支撑的是「属性倍率四档」与「应对是真实机制」两条；'
      + '「毒系体系当前很强」这个说法在台账里**没有**对应条目，所以本条目只登记「它是一批可识别的精灵」，不登记任何强弱。',
  }),
  Object.freeze({
    archetype_id: 'wing_king_flyer',
    label: '翼王飞翼',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「翼王」）',
    selector: Object.freeze({kind: 'named_in_authority', names: Object.freeze(['圣羽翼王'])}),
    defaultSeeds: Object.freeze(['圣羽翼王']),
    axes: Object.freeze([
      axis('speed', '用冻结迁移层 roster-48.json#pets[].stats.spe 与同行的 speed_tier 统计梯度；没有档位的一律 unknown，不拿 knowledge_only 值冒充。'),
      axis('pivot', '从学招池里数 desc 含「迅捷」（台账 swift.injection：主动换入时自动使用）或含「自己脱离 / 立即替换」的技能。'),
      axis('coverage', '同 poison_stack：属性防御键 × 18 个攻击系别的抗性承接。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'ledger-EV-PVP-FAINT-MANA-LOSS', 'ledger-EV-ENERGY-ENDTURN-REGEN']),
    needsRecording: Object.freeze([
      '「飓风」类特性的实机触发与魔力扣减结算录屏（台账 EV-PVP-FAINT-MANA-LOSS 已挂 MC-E09）',
      '翼系队伍的实机出场记录（当前一条都没有）',
    ]),
    notes: '「翼王」这个名字是从 13 号文档 §3 抄下来的，不是我们从数据里推的；'
      + '它在 pack 里对应 pet_record「圣羽翼王」1 个实体。13 号文档点名它属于 archetype seed，但**没有**说它强。',
  }),
  Object.freeze({
    archetype_id: 'meteor_burst',
    label: '陨星爆发',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「陨星」）',
    selector: Object.freeze({kind: 'name_contains', text: '陨星'}),
    defaultSeeds: Object.freeze(['陨星虫', '落陨星兔']),
    axes: Object.freeze([
      axis('energy', '取成员 build 的四个技能的 energy 与本次请求所用 ruleset 的 energy.max.value 对照，数超限技能数（本模块不写死任何能量数字）。'),
      axis('coverage', '属性防御键 × 18 个攻击系别：数「有没有成员能接住」。'),
      axis('cost', '槽位与硬约束的可满足性算术：locked ∪ must_include 能不能装进六槽、必须换掉的只数是否超过上限。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'ledger-EV-ENERGY-MAX', 'ledger-EV-POWER-NOT-PROVIDED']),
    needsRecording: Object.freeze([
      '能量上限到底是 6 还是 10 的实机 microcase（台账 EV-ENERGY-MAX 挂 MC-E01）',
      '「陨星」这一挂的实机配招与出场记录（当前一条都没有）',
    ]),
    notes: '「陨星」在 pack 里命中两个名字：陨星虫（虫系 pet_record）与落陨星兔（幻系+幽系 pet_record）。'
      + '本条只说明这两个名字真实存在；它们是不是同一个体系，13 号文档没有定义，我们也不替它定义。',
  }),
  Object.freeze({
    archetype_id: 'sugar_morph',
    label: '萌化叠层',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「萌化」）',
    selector: Object.freeze({
      kind: 'learnable_move_keyword', keyword: '萌化',
      pool: '冻结迁移层 data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json（12 只）',
    }),
    defaultSeeds: Object.freeze(['化蝶', '雪影娃娃', '秩序鱿墨', '圆号鱼', '黑猫巫师']),
    axes: Object.freeze([
      axis('energy', '萌化的层数会改能耗（例如特性「守护者」：己方其他精灵每有 1 层萌化，入场时全技能能耗 -1），所以这里数的是 build 四个技能的能耗曲线。'),
      axis('respond', '数「应对」词条出现次数：萌化里有多条是「防御应对成功」时才触发。'),
      axis('synergy', 'answers(m,T) / shared(T) 计数：萌化体系常常是「同一只反复上场」，弱点堆叠会被直接数出来。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'doc-13-4', 'ledger-EV-TRAITS-TRIGGER-COMPLEXITY']),
    needsRecording: Object.freeze([
      '萌化层数的获得 / 解除 / 上限实机规则（台账里没有这一条，BANNED 之外的社区说法一律不采信）',
      '「萌化」体系在标准 PVP 里的实机出场与胜负记录（当前一条都没有）',
    ]),
    notes: '「萌化」在本仓的可核对面是 skills.json 里 desc 含「萌化」的 19 条技能（多为特性行），'
      + '其中 12 只冻结迁移层的精灵学得到 4 条。本条只登记「萌化是数据里真实存在的词条」与'
      + '「哪些精灵能学到它」，**没有**登记萌化到底怎么叠、叠上去强不强。',
  }),
  Object.freeze({
    archetype_id: 'ice_control',
    label: '冰系控场',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「冰」）',
    selector: Object.freeze({kind: 'type_tag_main_forms', type: '冰系'}),
    defaultSeeds: Object.freeze(['雪影娃娃', '冰封怨灵', '九尾狐']),
    axes: Object.freeze([
      axis('coverage', '属性防御键 × 18 个攻击系别：冰系队伍的防御承接面会被逐条数出来（这是唯一可复算的“控场”替代物）。'),
      axis('speed', '冻结迁移层速度档位统计（没有档位的 unknown）。'),
      axis('respond', '学招池里「应对」词条计数。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'ledger-EV-TYPE-MULTIPLIER', 'ledger-EV-LEAVE-SEMANTICS']),
    needsRecording: Object.freeze([
      '冰系控制类效果（冻结 / 减速）的实机结算时序（台账里没有条目）',
      '冰系队伍的实机出场与胜负记录（当前一条都没有）',
    ]),
    notes: '本仓对「冰」能核对的只有两件事：pack 里有 32 只主形态冰系精灵（本条的种子选择器），'
      + 'features_axes 里的判据全部来自 RC-302。没有任何证据说冰系体系当前处于什么位置。',
  }),
  Object.freeze({
    archetype_id: 'sandstorm_weather',
    label: '沙暴天气',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「沙暴」）',
    selector: Object.freeze({
      kind: 'learnable_move_keyword', keyword: '沙暴',
      pool: '冻结迁移层 data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json（12 只）',
      outcome: 'none_available',
    }),
    defaultSeeds: Object.freeze([]),
    axes: Object.freeze([
      axis('coverage', '沙暴是天气，不直接改属性承接；这里数的是候选队伍在 18 个攻击系别上的防御承接面（天气只是这层的输入之一）。'),
      axis('respond', '学招池里「应对」词条计数：沙暴相关的三条技能里有「先手 +1」与「获得速度 +50」这类条件效果。'),
      axis('pivot', '换入/离场手段计数：天气体系通常要靠主动换人来维持，这一条数的是 desc 含「迅捷 / 自己脱离 / 立即替换」的技能。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'ledger-EV-ENERGY-MAX', 'ledger-EV-TURN-ORDER-STRICT']),
    needsRecording: Object.freeze([
      '沙暴天气的实机规则：改天气的回合归属、持续 8 回合的计数方式、天气结束时的时序（台账里没有条目）',
      '哪几只精灵真的学得到「沙涌 / 扬尘 / 流沙统治者」——冻结迁移层 12 只里**一只都没有**，需要更全的学招数据或实机录屏',
      '沙暴体系的实机出场记录（当前一条都没有）',
    ]),
    notes: '**如实登记的缺口**：skills.json 里 desc 含「沙暴」的有 3 条（沙涌 / 扬尘 / 流沙统治者），'
      + '但冻结迁移层 learnsets.json 的 12 只精灵**没有任何一只**能学到它们——所以本条的 seed_species 只能是空的。'
      + '这不是「沙暴不存在」，而是「本仓现有的可核对面里没有沙暴的载体」。按契约，空种子必须显式声明'
      + 'none_available 并挂上待录证据，不许静默降级成一个空体系。',
  }),
  Object.freeze({
    archetype_id: 'fighting_press',
    label: '武系压制',
    label_source: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3（点名「武」）',
    selector: Object.freeze({kind: 'type_tag_main_forms', type: '武系'}),
    defaultSeeds: Object.freeze(['海豹船长', '画间沉铁兽', '炽心勇狮']),
    axes: Object.freeze([
      axis('coverage', '属性防御键 × 18 个攻击系别：武系队伍的“压制”在本仓里唯一可复算的替代物是防御承接面，而不是任何形容词。'),
      axis('speed', '冻结迁移层速度档位统计（没有档位的 unknown）。'),
      axis('energy', '成员 build 四个技能的能耗曲线 vs 本次请求的 ruleset energy.max.value。'),
    ]),
    evidenceRefs: Object.freeze(['doc-13-3', 'ledger-EV-TURN-ORDER-MECHANISMS-EXIST', 'ledger-EV-TYPE-MULTIPLIER']),
    needsRecording: Object.freeze([
      '出手顺序的完整排序键与并列时的逐项降级（台账 EV-TURN-ORDER-STRICT 已挂 MC-E05）',
      '武系队伍的实机出场与胜负记录（当前一条都没有）',
    ]),
    notes: '「压制」这个词只出现在 label 里，作为**人类可读的体系名**；本条没有任何一条 feature_axes 用形容词。'
      + '武系在 pack 里有 24 只主形态精灵（本条的种子选择器），其中冻结迁移层有 3 只带数据。',
  }),
]);

/** 引用表：先验里的 evidence / distribution 只能引用这里登记过的来源。 */
export const EVIDENCE_REFS = Object.freeze({
  'doc-13-3': Object.freeze({
    ledger_entry: '13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3',
    ref: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: '13 号文档 §3 把「毒、翼王、陨星、萌化、冰、沙暴、武」写成版本 archetype seed：'
      + '“社区资料提出主 C、副 C、拦截、协防等常见职能，但系统把它们作为 multi-label feature，'
      + '不把「一主一副两拦截两协防」写成硬规则……是否仍强由版本数据和评测决定”。',
  }),
  'doc-13-4': Object.freeze({
    ledger_entry: '13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §4',
    ref: 'docs/roadmap/handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: '13 号文档 §4 规定了未知对手时的五个口径：expected_meta_value / worst_archetype / CVaR-robustness /'
      + ' matchup_spread / execution_tolerance / coverage_confidence，并要求“不输出伪精确胜率”。',
  }),
  'ledger-EV-TYPE-MULTIPLIER': Object.freeze({
    ledger_entry: 'EV-TYPE-MULTIPLIER',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'COMMUNITY_CURRENT',
    claim: '台账 EV-TYPE-MULTIPLIER（topic type.multiplier）：当前 BWIKI 条目可观察到 ×3、×2、×0.5、×0.25 四档，'
      + '不再沿用旧资料「所有双弱 ×4」。这是本先验的 coverage / synergy 判据所依赖的那种倍率。',
  }),
  'ledger-EV-ENERGY-MAX': Object.freeze({
    ledger_entry: 'EV-ENERGY-MAX',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'CROSS_SOURCE_SUPPORTED',
    claim: '台账 EV-ENERGY-MAX（topic energy.max）：外部资料多处支持常规上限 10、聚能 +5；'
      + '仓库引擎 ENERGY_MAX = 6 是 ENGINE_HYPOTHESIS，不得表述为游戏事实。',
  }),
  'ledger-EV-PVP-FAINT-MANA-LOSS': Object.freeze({
    ledger_entry: 'EV-PVP-FAINT-MANA-LOSS',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'CROSS_SOURCE_SUPPORTED',
    claim: '台账 EV-PVP-FAINT-MANA-LOSS：力竭通常扣 1 点魔力（来源只有 17173 转载里「额外损失1点魔力」间接支持），'
      + '等级 CROSS_SOURCE_SUPPORTED，风险已在台账 notes 里如实登记。',
  }),
  'ledger-EV-ENERGY-ENDTURN-REGEN': Object.freeze({
    ledger_entry: 'EV-ENERGY-ENDTURN-REGEN',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: '台账 EV-ENERGY-ENDTURN-REGEN：没有找到「每条在场精灵回合末自动 +1」的证据，'
      + '仓库的 ENERGY_REGEN_PER_TURN = 1 与多源材料冲突，属于 ENGINE_HYPOTHESIS。',
  }),
  'ledger-EV-TRAITS-TRIGGER-COMPLEXITY': Object.freeze({
    ledger_entry: 'EV-TRAITS-TRIGGER-COMPLEXITY',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'COMMUNITY_CURRENT',
    claim: '台账 EV-TRAITS-TRIGGER-COMPLEXITY：公开特性已覆盖入场、离场、回合结束、每受到攻击、克制后、'
      + '按技能系别、按队伍组成、能量上限突破、迅捷赋予、印记、连击等触发面；'
      + '全量精确模拟的主要工作量在 trigger/effect 语义，不在精灵表行数。',
  }),
  'ledger-EV-LEAVE-SEMANTICS': Object.freeze({
    ledger_entry: 'EV-LEAVE-SEMANTICS',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'COMMUNITY_CURRENT',
    claim: '台账 EV-LEAVE-SEMANTICS：「离场」包括主动更换或触发脱离效果，不包括力竭后下场；'
      + 'ACTIVE_SWITCH != SKILL_LEAVE != FAINT_REPLACEMENT。',
  }),
  'ledger-EV-TURN-ORDER-MECHANISMS-EXIST': Object.freeze({
    ledger_entry: 'EV-TURN-ORDER-MECHANISMS-EXIST',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'CROSS_SOURCE_SUPPORTED',
    claim: '台账 EV-TURN-ORDER-MECHANISMS-EXIST：应对是真实核心机制、技能存在先手 +1、主动换精灵是战斗动作、'
      + '速度参与同层级先后——四件机制**存在**。',
  }),
  'ledger-EV-TURN-ORDER-STRICT': Object.freeze({
    ledger_entry: 'EV-TURN-ORDER-STRICT',
    ref: 'data/roco/evidence/rule-evidence-ledger.json',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: '台账 EV-TURN-ORDER-STRICT：「应对 > 换宠 > 先手 > 速度」的**严格总序**本轮没找到同等强度的官方文字，'
      + '引擎的确定性排序键只是有界实现，不是游戏规则。',
  }),
  'ledger-EV-POWER-NOT-PROVIDED': Object.freeze({
    ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: '冻结层每个技能自注 effect_support = unsupported（「效果原语未实现；本轮只做静态数据导入，'
      + '未验证触发条件与时序」），且来源没给静态威力的技能记 power_status = not_provided_by_source；'
      + '所以本先验的任何特征轴都只能报结构，不能报威力或可用性。',
  }),
  'pack-v2': Object.freeze({
    ref: 'data/roco/game-data-pack/v2/pack.json',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: 'GameDataPack v2 是本先验核对「种子物种真实存在」的唯一数据面：622 个 pet 实体（460 pet_record + 162 pet_form），'
      + '全部来自冻结层 data/roco/normalized/roco-world-s4-2026-09-10。它是索引，不是证据。',
  }),
  'rc302-criteria': Object.freeze({
    ref: 'src/coach/team-gaps.js',
    date: '2026-09-21',
    confidence: 'ENGINE_HYPOTHESIS',
    claim: 'RC-302 的 DIMENSION_CRITERIA 登记了 coverage / speed / energy / respond / pivot / synergy / cost 七维的可复算判据；'
      + '本先验的 feature_axes[].criterion 直接引用这些键，不新造判据。',
  }),
});

/**
 * 一条证据 = 引用表里那一项 + **从台账现读的等级与首要来源**。
 *
 * 为什么等级要从台账现读，而不是抄进引用表：抄一份就会漂移。台账改了等级而先验没跟着改，
 * 先验就会拿一个已经过期的等级继续对外说话。这里现读现比，不一致就直接炸（fail closed）。
 * `ref` 同样以台账为准：台账把首要来源从 URL 换成仓内文件，先验必须跟着换。
 */
const evidence = (id, ledger) => {
  const row = EVIDENCE_REFS[id];
  if (!row) throw new Error(`引用表里没有 ${id}`);
  // `doc-*` 是**文档锚点**（引用表自己记的章节号），不是台账条目；`EV-*` 才要去台账现读。
  if (!row.ledger_entry || !String(row.ledger_entry).startsWith('EV-')) return {...row};
  const entry = arr(ledger?.entries).find((item) => item?.id === row.ledger_entry);
  if (!entry) throw new Error(`台账里没有 ${row.ledger_entry}（引用表 ${id} 指着它）`);
  const primary = arr(entry.sources).find((source) => typeof source?.url === 'string' && source.url.trim());
  const resolved = {
    ...row,
    confidence: entry.confidence,
    ref: primary ? primary.url : row.ref,
    date: primary?.date && /^\d{4}-\d{2}-\d{2}$/.test(primary.date) ? primary.date : row.date,
  };
  if (row.confidence !== entry.confidence) {
    throw new Error(`引用表 ${id} 抄的等级 ${row.confidence} 与台账 ${row.ledger_entry} 的 ${entry.confidence} 不一致：等级只有台账那一份`);
  }
  return resolved;
};

/** 把选择器真的跑一遍（只读数据面），选出种子物种。 */
export function selectSeeds(selector, repo, defaultSeeds) {
  if (!selector) return [];
  if (selector.kind === 'named_in_authority') {
    return [...(selector.names || [])].filter((name) => repo.petNames.has(name)).sort();
  }
  if (selector.kind === 'name_contains') {
    return [...repo.petNames].filter((name) => name.includes(selector.text)).sort();
  }
  if (selector.kind === 'type_tag_main_forms') {
    return repo.petRecords
      .filter((entity) => arr(entity?.tags?.types).includes(selector.type))
      .map((entity) => entity.name)
      .sort();
  }
  if (selector.kind === 'learnable_move_keyword') {
    // 学招池在冻结迁移层（12 只）。这条选择器只覆盖那一层，报告里如实写出口径。
    const root = repo.root;
    const skills = readJson(join(root, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10', 'skills.json'));
    const learnsets = readJson(join(root, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10', 'learnsets.json'));
    const pets = readJson(join(root, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10', 'pets.json'));
    const skillRows = skills?.skills || {};
    const targets = new Set(Object.values(skillRows)
      .filter((skill) => String(skill?.desc || '').includes(selector.keyword))
      .map((skill) => skill.skill_id));
    const names = new Map(Object.entries(pets?.pets || {}).map(([id, row]) => [id, row?.name]));
    const matched = [];
    for (const [petId, row] of Object.entries(learnsets?.learnsets || {})) {
      const pool = new Set();
      for (const key of ['native_skills', 'blood_skills', 'skill_stones']) {
        for (const item of arr(row?.[key])) {
          if (item && typeof item === 'object' && item.skill_id) pool.add(item.skill_id);
        }
      }
      if ([...pool].some((skillId) => targets.has(skillId))) matched.push(names.get(petId) || petId);
    }
    return matched.filter((name) => repo.petNames.has(name)).sort();
  }
  return [...(defaultSeeds || [])];
}

/**
 * 构建 v1.json 的内容。**纯函数**：同一份输入两次调用逐字节相同（没有挂钟字段；
 * 时间信息只来自 `as_of` 与各来源的 date）。
 */
export function buildMetaPrior({repo, asOf = '2026-09-21'} = {}) {
  const data = repo ?? loadRepoData();
  const scope = data.pack?.ruleset_binding || {};
  const archetypes = ARCHETYPE_SEEDS.map((seed) => {
    const selected = selectSeeds(seed.selector, data, seed.defaultSeeds);
    const noneAvailable = seed.selector?.outcome === 'none_available' || selected.length === 0;
    const seeds = noneAvailable ? [] : (selected.length ? selected : [...seed.defaultSeeds]);
    const evidenceRows = seed.evidenceRefs.map((id) => evidence(id, data.ledger));
    return {
      archetype_id: seed.archetype_id,
      label: seed.label,
      label_source: seed.label_source,
      seed_species: seeds,
      seed_selection: {
        source: noneAvailable ? 'none_available' : seed.selector.kind,
        selector: seed.selector,
        note: noneAvailable
          ? `本仓现有的可核对面里找不到载体：${seed.selector.keyword} 相关技能没有任何冻结迁移层精灵学得到。`
            + '按契约显式声明 none_available，并挂上 needs_recording，不静默降级成空体系。'
          : `种子按选择器 ${seed.selector.kind} 在本仓数据上复算得到 ${seeds.length} 个，全部在 pack 的 pet 实体里逐字命中；`
            + '`default_seeds` 只是人工挑出的代表元，机器可复算的那份是这里的 selector（先验不写死榜单）。',
        default_seeds: [...seed.defaultSeeds],
        selected_count: seeds.length,
      },
      feature_axes: seed.axes.map((row) => ({...row})),
      evidence: evidenceRows,
      confidence: weakerOf(evidenceRows.map((row) => row.confidence)),
      needs_recording: [...seed.needsRecording],
      notes: seed.notes,
    };
  });

  const derivedPaths = DERIVED_FROM_REQUIRED.map((row) => row).concat([
    {role: 'pack_schema', path: 'data/roco/game-data-pack/v2/schema.json'},
  ]);
  const derivedFrom = derivedPaths.map((row) => {
    const absolute = join(data.root, row.path);
    if (!existsSync(absolute)) throw new Error(`derived_from 引用的文件不存在：${row.path}`);
    return {path: row.path, sha256: sha256(readFileSync(absolute, 'utf8')), role: row.role};
  });

  const document = {
    schema: META_PRIOR_SCHEMA,
    meta_prior_id: null,
    version_scope: {
      season: 'S4「月涌狂想」',
      season_id: data.ledger?.ruleset_id ?? scope.ruleset_id ?? null,
      ruleset_id: scope.ruleset_id ?? data.ledger?.ruleset_id ?? null,
      ruleset_config_id: scope.ruleset_config_id ?? null,
      ruleset_config_path: scope.ruleset_config_path ?? null,
      ruleset_config_note: scope.ruleset_config_is_default === true
        ? 'legacy_sim_v1 是**默认**配置，但它的能量上限 6 被台账判为 ENGINE_HYPOTHESIS；'
          + 'mobile_s4_candidate_v2 是候选配置。本先验不替 RC-101 做规则选择，只把当前绑定如实写下来。'
        : null,
      as_of: asOf,
    },
    claim: {
      contains: [
        '这一版环境里有哪些**可复算识别**的体系（archetype_id + 中文 label + 种子物种 + RC-302 判据构成的 feature_axes）',
        '每个体系现在已经有的、逐条可核对的依据（evidence[]：url 或仓内文件 + 日期 + 台账六级等级）',
        '每个体系**还缺什么实机证据**（needs_recording[]）',
        '各体系在环境里的占比目前是 measured 还是 unknown，以及为什么（distribution[]）',
        'RC-304 消费这份先验时的输入口径（usage.inputs）',
      ],
      does_not_contain: [
        '任何胜率、强度分、期望值、榜单名次——本先验**不产出**这类结论，也没有任何真实对局数据可以支撑它们',
        '任何体系的占比数值：当前没有任何可核对的来源，distribution 全部是 unknown + value: null + reason',
        '「哪个体系强」的判断：本先验只说清「哪些体系可以被识别、凭什么识别」，强弱要等离线评测与真实对局校准',
        '任何绕过台账六级的新置信等级',
      ],
    },
    derived_from: derivedFrom,
    archetypes,
    distribution: archetypes.map((archetype) => ({
      archetype_id: archetype.archetype_id,
      value: null,
      unit: null,
      source: 'unknown',
      sources: [],
      reason: `体系「${archetype.label}」：${TOTAL_UNKNOWN_REASON}${PER_ARCHETYPE_UNKNOWN_REASON}`,
      needs_recording: archetype.needs_recording.length
        ? `该体系还缺 ${archetype.needs_recording.length} 条实机证据，逐条见 archetypes[].needs_recording`
        : '该体系当前没有登记缺什么实机证据（这本身值得复核）',
    })),
    usage: {
      consumer: 'RC-304（对未知对手的队伍强度口径）。本先验是它的**唯一**版本化环境输入：没有先验就无法把「队伍强不强」写成对环境的期望，只能退化成对单只精灵的描述。',
      fields: 'usage.inputs 里每个口径都写成**字段说明**，不是散文：definition 说它是什么，inputs 说它吃先验与 RC-302/RC-303 的哪些字段，honesty 说它在什么条件下必须 fail closed。',
      inputs: {
        expected_meta_value: {
          consumer_field: 'expected_meta_value',
          definition: '六宠队伍对**版本对手分布**的期望表现。它必须先有一个分布，再谈期望；分布现在是 unknown，所以这个口径现在**算不出来**，只能如实返回 unknown 而不是拿一个数代填。',
          inputs: [
            'distribution[].source / value（当前全部 unknown ⇒ 期望无定义）',
            'archetypes[].archetype_id 与 feature_axes（用来把一支队伍归到体系上）',
            'RC-303 的 ranker_status（没有版本化 ranker 时只能是 missing，退化成规则相对排序）',
          ],
          honesty: '分布 unknown 时禁止输出任何数值型期望：要么标 unknown，要么只给**相对排序**并附上 ENGINE_HYPOTHESIS。',
        },
        worst_archetype: {
          consumer_field: 'worst_archetype',
          definition: '最怕的主流体系：对每个 archetype 分别算队伍的相对表现，取最差的那个。它需要一个「主流」的定义，而主流 = 分布，分布现在是 unknown。',
          inputs: [
            'archetypes[].archetype_id / seed_species / feature_axes',
            'distribution[].source（判断哪个体系算「主流」）',
            'RC-302 的 coverage / synergy 诊断（可持续复算的那部分）',
          ],
          honesty: '分布 unknown 时只能输出「按**结构判据**算最吃亏的体系」，并明确标注这不是「最主流」，也不构成胜率结论。',
        },
        matchup_spread: {
          consumer_field: 'matchup_spread',
          definition: '对局分布散不散：一支队伍是不是严重依赖撞到特定阵容。散度是对分布的矩，分布未知时它同样无定义。',
          inputs: [
            'distribution[]（分母）',
            '逐体系的表现估计（当前不存在：没有离线联赛产物、没有 matchups bank）',
            'archetypes[].feature_axes（把对手归体系的判据）',
          ],
          honesty: '没有 matchup bank 时禁止报散度数值；只能报「无法计算」并列出缺失产物。',
        },
        execution_tolerance: {
          consumer_field: 'execution_tolerance',
          definition: '次优操作下掉多少：同一支队伍在非最优操作下的表现衰减。它需要一套可复跑的对局采样，本仓现在没有。',
          inputs: [
            '离线入口 buildOfflineLabelPlan（RC-303 离线段）产出的工作单',
            'RC-102/RC-103 的出手顺序规则（台账里严格总序仍是 ENGINE_HYPOTHESIS）',
            'ruleset 配置：energy.max 等量在候选配置与默认配置之间不一致',
          ],
          honesty: '规则本身还在 candidate 阶段时，容错数值一定是伪精确：只能报告「本版不可测」，不许给百分比。',
        },
        coverage_confidence: {
          consumer_field: 'coverage_confidence',
          definition: '六宠 build 的规则与数据覆盖：属性倍率、速度档、能耗、应对、换入离场这些判据里，有多少有真实数据支撑、多少是 unknown。',
          inputs: [
            'version_scope.ruleset_config_id（按哪套规则算）',
            'derived_from[] 的 sha256（先验引用有没有漂移）',
            'RC-302 的 CONFIDENCE_LEVELS 与 LEDGER_QUANTITIES（哪些量在台账里就是未知）',
            'archetypes[].confidence（逐体系的证据等级）',
          ],
          honesty: '这是当前**唯一**能立刻算出来的口径：它是自我描述（我们知道自己知道多少），不是实力判断。覆盖率低时必须 fail closed 到「本先验只能用来定义体系与特征轴」。',
        },
      },
      not_in_scope: '不在范围内：不输出胜率、不排名、不输出上分效率与单只精灵的强弱、不采信社区攻略里的榜单名次。',
      honesty: '这份先验**不能用来排序队伍**：它没有任何真实对局数据，distribution 全部是 unknown。'
        + '它现在能做的只有三件事：定义这一版环境里有哪些可识别的体系、给出每个体系的可复算特征轴、'
        + '把「我们还缺什么实机证据」列清楚。任何拿它当强度榜用的做法，都越过了它自己写下的边界。',
    },
  };
  document.meta_prior_id = computeMetaPriorId(document);
  return document;
}

/** 把 v1.json 的内容按 --check 的方式重算一遍，返回 `{ok, reason}`。 */
export function checkAgainstBuild({built, onDisk}) {
  const a = typeof built === 'string' ? built : stableStringify(built);
  const b = typeof onDisk === 'string' ? onDisk : stableStringify(onDisk);
  if (a === b) return {ok: true, reason: '磁盘上的 v1.json 与重新构建的结果逐字节一致'};
  const at = a.split('\n');
  const bt = b.split('\n');
  const at2 = at.findIndex((line, index) => line !== bt[index]);
  return {
    ok: false,
    reason: `磁盘上的 v1.json 与重新构建的结果不一致：第 ${at2 + 1} 行起不同\n`
      + `  重建：${JSON.stringify(at[at2] ?? null)}\n  磁盘：${JSON.stringify(bt[at2] ?? null)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// --selftest：这个校验器自己的正反用例
// ─────────────────────────────────────────────────────────────────────────
//
// 一个总是报绿的检查会被当成「已经查过了」。所以这里既有正向（真先验必须过），
// 也有必红方向：把正确产出**改坏**之后，校验必须报出**具体**问题（不只是 ok=false）。
//
// 改坏的是**内存副本**，不落盘改真产物：一份会被测试改脏的先验，比没有先验更糟。

const clone = (value) => JSON.parse(JSON.stringify(value));

export function selftest({root = ROOT} = {}) {
  const cases = [];
  const repo = loadRepoData({root});
  const baseline = buildMetaPrior({repo});
  const validation = validateMetaPrior(baseline, {root, repo});
  const check = (patch) => {
    const mutated = clone(baseline);
    patch(mutated);
    return validateMetaPrior(mutated, {root, repo});
  };
  const run = (name, fn) => {
    try {
      const result = fn();
      cases.push({name, passed: result.passed, want: result.want, got: result.got});
    } catch (error) {
      cases.push({name, passed: false, want: '不抛异常', got: `抛了：${error.message}`});
    }
  };
  const firstArchetype = () => baseline.archetypes[0].archetype_id;
  const rowsOf = (report, code) => report.problems.filter((row) => row.code === code);

  run('正向：真先验必须过（0 条问题）', () => ({
    passed: validation.ok === true,
    want: 'ok=true，0 条问题',
    got: `ok=${validation.ok}，问题 ${validation.problems.length} 条：${validation.problems.map(formatProblem).join(' | ') || '(无)'}`,
  }));

  run(`反证①：给体系填一个胜率字段必须红（BANNED_KEY）`, () => {
    const report = check((doc) => { doc.archetypes[0].win_rate = 0.52; });
    const hits = rowsOf(report, 'BANNED_KEY');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 BANNED_KEY',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证②：distribution 缺来源却写成 measured 必须红（DISTRIBUTION）', () => {
    const report = check((doc) => {
      doc.distribution[0].source = 'measured';
      doc.distribution[0].value = 0.3;
    });
    const hits = rowsOf(report, 'DISTRIBUTION');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 DISTRIBUTION（缺来源的数值一律非法）',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证③：unknown 却带非 null value 必须红（DISTRIBUTION）', () => {
    const report = check((doc) => { doc.distribution[1].value = 0.25; });
    const hits = rowsOf(report, 'DISTRIBUTION');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 DISTRIBUTION',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证④：seed_species 引用不存在的精灵必须红（SEED_SPECIES）', () => {
    const report = check((doc) => { doc.archetypes[0].seed_species = ['并不存在的精灵']; });
    const hits = rowsOf(report, 'SEED_SPECIES');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 SEED_SPECIES',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑤：confidence 用了台账之外的等级必须红（CONFIDENCE）', () => {
    const report = check((doc) => { doc.archetypes[0].confidence = 'VERIFIED_OFFICIAL'; });
    const hits = rowsOf(report, 'CONFIDENCE');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 CONFIDENCE',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑥：evidence 的 ref 不可核对必须红（EVIDENCE）', () => {
    const report = check((doc) => { doc.archetypes[0].evidence[0].ref = 'docs/roco/不存在的文档.md'; });
    const hits = rowsOf(report, 'EVIDENCE');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 EVIDENCE',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑦：version_scope 缺赛季或 ruleset 必须红（SCHEMA）', () => {
    const report = check((doc) => {
      delete doc.version_scope.season;
      delete doc.version_scope.ruleset_id;
    });
    const hits = rowsOf(report, 'SCHEMA').filter((row) => /version_scope/.test(row.where));
    return {
      passed: report.ok === false && hits.length >= 2,
      want: 'ok=false，且 version_scope 的 season 与 ruleset_id 各报一条',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑧：构建器两次运行结果必须逐字节一致（含排序）', () => {
    const again = buildMetaPrior({repo});
    const a = stableStringify(baseline);
    const b = stableStringify(again);
    return {
      passed: a === b,
      want: '两次 stableStringify 逐字节相同',
      got: a === b ? `相同（长度 ${a.length}，meta_prior_id=${baseline.meta_prior_id}）`
        : `不同：第一次 ${a.length} 字节 / 第二次 ${b.length} 字节`,
    };
  });

  run('反证⑨：derived_from 的 sha256 与磁盘不一致必须红（DERIVED_FROM）', () => {
    const report = check((doc) => {
      const row = doc.derived_from.find((item) => item.role === 'rule_evidence_ledger');
      row.sha256 = '0'.repeat(64);
    });
    const hits = rowsOf(report, 'DERIVED_FROM').filter((row) => /sha256/.test(row.where));
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 DERIVED_FROM 的 sha256 不一致',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑩：feature_axes 用自创判据（形容词）必须红（CRITERION）', () => {
    const report = check((doc) => {
      doc.archetypes[0].feature_axes[0].criterion = '压制力强';
      doc.archetypes[0].feature_axes[0].axis = '压制力强';
    });
    const hits = rowsOf(report, 'CRITERION');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 CRITERION',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑪：改了正文却不更新 meta_prior_id 必须红（SCHEMA）', () => {
    const report = check((doc) => { doc.archetypes[0].label = '换了个名字'; });
    const hits = rowsOf(report, 'SCHEMA').filter((row) => row.where === 'meta_prior_id');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 meta_prior_id 与正文对不上',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑫：usage.inputs 缺一个 RC-304 口径必须红（USAGE）', () => {
    const report = check((doc) => { delete doc.usage.inputs.execution_tolerance; });
    const hits = rowsOf(report, 'USAGE');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 USAGE',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑬：没有种子的体系却不声明 none_available 必须红（SEED_SPECIES）', () => {
    const report = check((doc) => {
      const row = doc.archetypes.find((item) => item.archetype_id === 'sandstorm_weather');
      row.seed_selection.source = 'learnable_move_keyword';
      row.needs_recording = [];
    });
    const hits = rowsOf(report, 'SEED_SPECIES');
    return {
      passed: report.ok === false && hits.length > 0,
      want: 'ok=false，且报出 SEED_SPECIES',
      got: `ok=${report.ok}；命中 ${hits.length} 条：${hits.map(formatProblem).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑭：真写了「这只的胜率是 62%」这类正面结论必须进弱判据（BANNED_WORD）', () => {
    const report = check((doc) => { doc.archetypes[0].notes = '这只的胜率是 62%。'; });
    const hits = report.soft_problems.filter((row) => row.code === 'BANNED_WORD');
    return {
      passed: hits.length > 0,
      want: 'soft_problems 里出现 BANNED_WORD',
      got: `soft_problems ${report.soft_problems.length} 条：${hits.map((row) => `${row.where} → ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑮：磁盘上的 v1.json 与重新构建的结果必须逐字节一致', () => {
    const onDisk = readFileSync(join(root, DEFAULT_META_PRIOR_PATH), 'utf8');
    const compared = checkAgainstBuild({built: baseline, onDisk});
    return {
      passed: compared.ok,
      want: '逐字节一致',
      got: compared.reason,
    };
  });

  const failed = cases.filter((row) => !row.passed);
  return {
    ok: failed.length === 0,
    cases,
    failed: failed.length,
    baseline: {
      schema: baseline.schema,
      meta_prior_id: baseline.meta_prior_id,
      archetypes: baseline.archetypes.length,
      first_archetype: firstArchetype(),
      distribution_source: validation.summary.distribution_source,
    },
  };
}
