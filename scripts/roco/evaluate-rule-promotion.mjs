#!/usr/bin/env node
// RC-102 后半：规则 promotion gate。
//
// 背景：RC-101 把「候选规则」与「逐位冻结的默认基线」分成了两份配置，并给每个字段
// 挂了 `confidence` / `evidence_id` / `microcase_id` / `value_status`。但那一步只做到
// **登记**「这个值还没被实机验证」；它没有回答施工层真正会问的那个问题：
//
//     这个字段现在**可不可以** promotion？如果不可以，**缺哪一条**证据？
//
// 一条边界如果没有可执行的判据，它真正的状态仍然是「没人知道」。所以这个脚本把
// 「没有实机证据不许 promotion」从散文变成一份逐字段的判决书：
//
//     PROMOTABLE       —— 该字段的每一条门槛都被真实记录顶住了（本阶段不该出现）
//     NOT_PROMOTABLE   —— 缺记录 / 等级不足 / 判据未满足 / 引用不可核对 / 记录过期 / 字段本身仍是假设
//     REFUTED          —— 记录里的观测值与候选值**不一致**（记录说候选值是错的）
//
// 边界（最容易被顺手越过的一条）：
//   **本脚本只报告，不写配置。** 它读 `data/roco/rulesets/*.json` 与两份证据文件，
//   只写 `reports/roco/flagship-upgrade/rule-promotion.json`。哪怕某个字段被判 REFUTED，
//   它也**不会**去改候选配置里的那个值——改配置是人的决定（并要连带改台账与回归产物），
//   脚本擅自「修正」只会把一次取证变成一次静默改规则。报告里的 `config_unchanged`
//   用 sha256 前后对比把这条边界变成机器可核对的证据。
//
// 跑法：
//
//     node scripts/roco/evaluate-rule-promotion.mjs              # 写报告文件
//     node scripts/roco/evaluate-rule-promotion.mjs --json       # 同时把报告打到 stdout
//     node scripts/roco/evaluate-rule-promotion.mjs --selftest   # 自带正反用例（含 ≥6 条反证）
//     node scripts/roco/evaluate-rule-promotion.mjs --no-write   # 只评判，不落盘
//     node scripts/roco/evaluate-rule-promotion.mjs --config data/roco/rulesets/mobile-s4-candidate-v2.json \
//         --ledger data/roco/evidence/rule-evidence-ledger.json \
//         --recordings data/roco/evidence/microcase-recordings.json
//
// `--config` / `--ledger` / `--recordings` 是给**取证**用的：报告里要贴「换成一份坏输入
// 之后真实的报错原文」，而反证不许写盘改真数据。把改坏的副本写到 /tmp，再用这些开关指过去。

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  CONFIDENCE_ORDER, LEDGER_PATH as LEDGER_REL, PROMOTABLE_LEVELS, RECORDS_PATH as CASE_RECORDS_REL,
  formatIssues, readJson, sha256,
} from './evidence-ledger-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');

/** 输入（仓库相对路径；测试与取证可以覆盖）。 */
export const CANDIDATE_CONFIG_REL = 'data/roco/rulesets/mobile-s4-candidate-v2.json';
export const RECORDINGS_REL = 'data/roco/evidence/microcase-recordings.json';
/** 输出：只写这一个报告文件，不碰任何配置 / 轨迹 / SFT / 模型产物。 */
export const REPORT_REL = 'reports/roco/flagship-upgrade/rule-promotion.json';
/** RC-101 的影响报告：本报告指回它，避免出现两份互不相干的「影响清单」。 */
export const RC101_REPORT_REL = 'reports/roco/flagship-upgrade/rc-101-rule-config.json';

export const REPORT_SCHEMA = 'roco-rule-promotion-report/v1';
export const RECORDINGS_SCHEMA = 'roco-microcase-recordings/v1';
export const ACCEPTED_RECORD_CONFIDENCE = Object.freeze(['RECORDED_IN_GAME', 'OFFICIAL_CURRENT']);
export const ACCEPTED_SOURCE_KINDS = Object.freeze(['recorded_gameplay', 'official_first_party']);
/** 记录的最长保鲜期（天）：再旧的录像对应的可能是另一个游戏版本，不能顶 promotion。 */
export const DEFAULT_MAX_RECORD_AGE_DAYS = 548;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 每个 microcase 的 `pass_criteria` 会被折算成**必须观测到的量**。
 *
 * 为什么要有这张表，而不是只看「记录存在」：
 * 一条记录只要写个 `{"microcase_id": "MC-E01"}` 就能存在。真正的问题是「录到的够不够
 * 回答 pass_criteria」。所以这里把每条判据里的关键量写成**可复算**的键：
 * 记录的 `observations` 少一个键，这个 case 就没满足判据。
 *
 * 键名与 `data/roco/evidence/rule-evidence-microcase-records.json` 里每条 case 的
 * `pass_criteria` 原文一一对应，`from_pass_criteria` 就是那句原文。
 */
export const REQUIRED_OBSERVATIONS = Object.freeze({
  'MC-E01': {
    from_pass_criteria: '录到一次能量读数达到的**最大值本身就是答案**：…若在 9 点时聚能后停在 10，则「聚能 +5 且不突破上限」成立',
    requires: [
      {key: 'energy_max_observed', kind: 'positive_int', why: '录到的能量读数最大值'},
      {key: 'charge_energy_delta', kind: 'int', why: '同一次录制里聚能前后的读数差'},
    ],
  },
  'MC-E02': {
    from_pass_criteria: '一次聚能的能量差值就是答案（+5 或其它）；若在上限时聚能读数不变，则「不能突破上限」成立',
    requires: [
      {key: 'charge_energy_delta', kind: 'int', why: '一次聚能的能量差值'},
      {key: 'charge_beyond_cap', kind: 'boolean', why: '能量已满时再聚能读数是否变化'},
    ],
  },
  'MC-E03': {
    from_pass_criteria: '对照组的差值就是答案：无特性组若每回合结束读数不变，则「默认自然回能 +1」被证伪',
    requires: [
      {key: 'regen_per_turn_delta', kind: 'int', why: '无回能特性精灵的回合末能量增量'},
    ],
  },
  'MC-E04': {
    from_pass_criteria: '四段录像给出四个具体整数；本轮引擎的「入场初始 2」只有在第一段读数确为 2 时才成立',
    requires: [
      {key: 'initial_energy_observed', kind: 'int', why: '开场第一只精灵入场时的读数'},
      {key: 'entry_inherits_leftover', kind: 'boolean', why: '再次入场是否继承离场时的剩余能量'},
    ],
  },
  'MC-E05': {
    from_pass_criteria: '每一段录像只要能指出谁先动，就能在四段里定出两两强弱…同速那一段的判据是「先手方是否固定」',
    requires: [
      {key: 'order_observed', kind: 'string[]', why: '四段对抗里逐段读出的先后（应对/换宠/先手/速度）'},
      {key: 'speed_tie_deterministic', kind: 'boolean', why: '同速多次录像是否总是同一侧先动'},
    ],
  },
});

/**
 * 每条 microcase 的「观测值 ↔ 候选值」比较器。
 *
 * 没有比较器的 case（例如 MC-E05 的严格总序要四段录像互相印证）只能做到「判据满足」，
 * 判据满足**不代表**可以 promotion：这里如实写出缺口，而不是假装它被核过了。
 */
const COMPARATORS = Object.freeze({
  'MC-E01': (observations, field) => {
    if (field.path !== 'energy.max') return null;
    return exact('观测到的能量读数最大值 energy_max_observed', observations.energy_max_observed, field.value);
  },
  'MC-E02': (observations, field) => {
    if (field.path !== 'energy.charge') return null;
    // 聚能是否可突破上限：候选配置没有断言（在 unknowns 里），所以只比差值这一条。
    return exact('观测到的聚能能量差 charge_energy_delta', observations.charge_energy_delta, field.value);
  },
  'MC-E03': (observations, field) => {
    if (field.path !== 'energy.regen.per_turn') return null;
    const perTurn = observations.regen_per_turn_delta;
    if (perTurn > 0 && field.value === 0) {
      return {
        ok: false,
        text: `观测值 regen_per_turn_delta=${perTurn}（回合末确实有自然回能）与候选值 energy.regen.per_turn=${JSON.stringify(field.value)}（默认不发生）不一致`,
      };
    }
    return {
      ok: true,
      text: `观测值 regen_per_turn_delta=${perTurn}；候选值 ${JSON.stringify(field.value)} 表示「默认无自然回能」——`
        + `只有观测为 0 才与它相容（相容≠已证实：该字段仍须先把 confidence 提到可 promotion 的等级）`,
    };
  },
  'MC-E04': (observations, field) => {
    if (field.path !== 'energy.initial') return null;
    if (field.value === null) {
      return {
        ok: true,
        text: `观测到 initial_energy_observed=${observations.initial_energy_observed}，但候选配置里 energy.initial 仍是 null（UNKNOWN，等 MC-E04）——`
          + '记录存在只说明「有数可填」，填不填、填几仍是人的决定，脚本不代填',
      };
    }
    return exact('观测到的入场初始能量 initial_energy_observed', observations.initial_energy_observed, field.value);
  },
});

function exact(label, observed, expected) {
  if (observed === expected) return {ok: true, text: `${label}=${JSON.stringify(observed)} 与候选值一致`};
  return {ok: false, text: `${label}=${JSON.stringify(observed)} 与候选值 ${JSON.stringify(expected)} 不一致`};
}

function valueKind(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 观测值本身的形状判据：一个 `null` 或 `NaN` 的「读数」不算录到了。 */
function shapeProblem(requirement, value) {
  const where = `observations.${requirement.key}`;
  if (value === undefined) return `${where} 缺失（本条 microcase 的 pass_criteria 要求录到：${requirement.why}）`;
  switch (requirement.kind) {
    case 'positive_int':
      if (!Number.isInteger(value) || value <= 0) return `${where} 必须是正整数读数，实际 ${JSON.stringify(value)}`;
      return null;
    case 'int':
      if (!Number.isInteger(value)) return `${where} 必须是整数读数，实际 ${JSON.stringify(value)}`;
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return `${where} 必须是布尔，实际 ${JSON.stringify(value)}`;
      return null;
    case 'string[]':
      if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
        return `${where} 必须是非空字符串数组，实际 ${JSON.stringify(value)}`;
      }
      return null;
    default:
      return `${where} 的判据类型 ${JSON.stringify(requirement.kind)} 未定义`;
  }
}

/** 收集一份配置里所有带 confidence 的叶子（路径 + 叶子 + 该叶子直接引用的案例）。 */
export function configLeaves(config) {
  const out = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if ('value' in node && 'confidence' in node) {
      out.push({path, leaf: node});
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(config, '');
  return out;
}

function microcaseIdsOf(config) {
  const ids = new Set();
  for (const {leaf} of configLeaves(config)) {
    if (typeof leaf.microcase_id === 'string' && leaf.microcase_id) ids.add(leaf.microcase_id);
  }
  for (const item of config.unknowns ?? []) {
    if (typeof item?.microcase_id === 'string' && item.microcase_id) ids.add(item.microcase_id);
  }
  return [...ids].sort();
}

/** `YYYY-MM-DD` / ISO 日期时间 → 毫秒；解析不出来返回 null。 */
export function parseRecordDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return null;
  const stamp = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * 一条记录的 `media_ref` 可不可核对。
 *
 * 可核对的两种形态：http(s) 链接（外部归档），或**仓库里真实存在**的相对路径。
 * 其余（空、`/tmp/...`、不存在的路径、file://）都算「不可核对」——一份指不到东西的
 * 引用和没登记是一样的，只是看起来更像有证据。
 */
export function checkMediaRef(mediaRef, {root = ROOT} = {}) {
  const raw = typeof mediaRef === 'string' ? mediaRef.trim() : '';
  if (!raw) return {ok: false, detail: 'media_ref 为空'};
  if (/^https?:\/\//i.test(raw)) return {ok: true, kind: 'url', detail: `外部链接 ${raw}`};
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return {ok: false, detail: `media_ref 协议不可核对（只接受 http(s) 或仓库内路径）：${raw}`};
  }
  const rel = raw.replace(/^\.\//, '');
  const absolute = isAbsolute(rel) ? rel : join(root, rel);
  if (existsSync(absolute)) return {ok: true, kind: 'repo_path', detail: `仓库内文件 ${rel}`};
  return {ok: false, detail: `media_ref 既不是 http(s) 链接，也不是仓库里存在的文件：${JSON.stringify(raw)}`};
}

/**
 * 把「一份登记表」或「一个记录数组」都归一成登记表对象。
 *
 * 为什么要容错：自检与测试里最顺手的写法是直接塞一个记录数组。如果只接受整份文档，
 * 一个**纯内存**的数组会被判成「登记表不是对象」，于是所有反证都会退化成同一句
 * 「缺记录」——那样这些反证就什么都没证明（它们只证明了输入被丢掉了）。
 */
function asRecordingsDoc(recordings) {
  if (Array.isArray(recordings)) {
    return {
      schema: RECORDINGS_SCHEMA,
      generated_by: '（内存副本：来自 evaluatePromotion 的数组入参，不落盘）',
      recordings,
      in_memory: true,
    };
  }
  return recordings;
}

/** 结构化校验登记表本身（schema / 顶层字段 / 逐条形状）。 */
export function validateRecordings(recordings, {root = ROOT} = {}) {
  const issues = [];
  const add = (microcase_id, rule, detail) => issues.push({microcase_id, rule, detail});
  if (!recordings || typeof recordings !== 'object' || Array.isArray(recordings)) {
    add('(登记表)', 'schema.shape', '登记表不是对象');
    return {ok: false, issues, records: []};
  }
  if (recordings.schema !== RECORDINGS_SCHEMA) {
    add('(登记表)', 'schema.value', `schema 是 ${JSON.stringify(recordings.schema)}，应为 ${RECORDINGS_SCHEMA}`);
  }
  if (typeof recordings.generated_by !== 'string' || !recordings.generated_by.trim()) {
    add('(登记表)', 'generated_by', '缺少非空 generated_by（这份登记是谁维护的）');
  }
  if (!Array.isArray(recordings.recordings)) {
    add('(登记表)', 'recordings.array', `recordings 必须是数组，实际 ${JSON.stringify(recordings.recordings ?? null)}`);
    return {ok: false, issues, records: []};
  }
  const seen = new Set();
  for (const [index, record] of recordings.recordings.entries()) {
    const id = typeof record?.microcase_id === 'string' && record.microcase_id ? record.microcase_id : `(第 ${index} 条缺 microcase_id)`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      add(id, 'record.shape', '记录不是对象');
      continue;
    }
    if (!/^MC-E\d{2}$/.test(String(record.microcase_id ?? ''))) {
      add(id, 'record.microcase_id', `microcase_id 必须形如 MC-E01，实际 ${JSON.stringify(record.microcase_id ?? null)}`);
    }
    if (seen.has(record.microcase_id)) add(id, 'record.unique', `同一 microcase 出现多条记录：${record.microcase_id}`);
    seen.add(record.microcase_id);
    if (!ACCEPTED_RECORD_CONFIDENCE.includes(record.confidence)) {
      add(id, 'record.confidence',
        `confidence 只允许 ${ACCEPTED_RECORD_CONFIDENCE.join(' / ')}，实际 ${JSON.stringify(record.confidence ?? null)}`
        + '（社区页面 / 官方转载 / 仓库内部事实源都不能顶这里）');
    }
    if (!ACCEPTED_SOURCE_KINDS.includes(record.source_kind)) {
      add(id, 'record.source_kind',
        `source_kind 只允许 ${ACCEPTED_SOURCE_KINDS.join(' / ')}，实际 ${JSON.stringify(record.source_kind ?? null)}`);
    }
    if (parseRecordDate(record.recorded_at) === null) {
      add(id, 'record.recorded_at', `recorded_at 不是可解析的 ISO 日期(时间)：${JSON.stringify(record.recorded_at ?? null)}`);
    }
    const media = checkMediaRef(record.media_ref, {root});
    if (!media.ok) add(id, 'record.media_ref', media.detail);
    if (!record.observations || typeof record.observations !== 'object' || Array.isArray(record.observations)) {
      add(id, 'record.observations', `observations 必须是「字段 → 观测值」的对象，实际 ${JSON.stringify(record.observations ?? null)}`);
    }
    if (typeof record.notes !== 'string' || !record.notes.trim()) {
      add(id, 'record.notes', 'notes 不能为空（这条记录录的是哪个版本 / 有没有干扰因素）');
    }
  }
  return {ok: issues.length === 0, issues, records: recordings.recordings};
}

/**
 * 逐字段判决。**纯函数**：同样的输入 → 同样的输出，不读盘、不写盘。
 *
 * `options.caseRecords` 是 `rule-evidence-microcase-records.json`（带 pass_criteria 的计划表）；
 * `options.configPath` 只是为了在报告里登记被评判的是哪份文件。
 */
export function evaluatePromotion(options) {
  const {
    config, ledger, recordings, caseRecords,
    configPath = CANDIDATE_CONFIG_REL,
    // 报告里的路径一律写成仓库相对路径：绝对路径会把本机目录写进报告，换台机器就对不上。
    ledgerPath = LEDGER_REL,
    caseRecordsPath = CASE_RECORDS_REL,
    recordingsPath = RECORDINGS_REL,
    now = Date.now(),
    maxRecordAgeDays = DEFAULT_MAX_RECORD_AGE_DAYS,
    root = ROOT,
  } = options;

  const ledgerEntries = new Map((ledger?.entries ?? []).map((entry) => [entry.id, entry]));
  const caseById = new Map((caseRecords?.cases ?? []).map((row) => [row.id, row]));
  // 配置的 `unknowns[]` 也是「这个字段要录哪条 case」的登记处（RC-101 就是这么写 energy.initial 的）。
  // 叶子本身没有 microcase_id 时，按路径去 unknowns 里找——否则报告会说「无 microcase」，
  // 而配置里其实白纸黑字写着 MC-E04，那就成了一份自相矛盾的报告。
  const unknownCaseByPath = new Map(
    (config?.unknowns ?? [])
      .filter((row) => row?.path && row?.microcase_id)
      .map((row) => [row.path, {microcase_id: row.microcase_id, reason: row.reason ?? null}]),
  );
  const validation = validateRecordings(asRecordingsDoc(recordings), {root});
  const recordByCase = new Map();
  for (const record of validation.records) {
    if (record?.microcase_id && !recordByCase.has(record.microcase_id)) recordByCase.set(record.microcase_id, record);
  }

  const fields = [];
  for (const {path, leaf} of configLeaves(config)) {
    const reasons = [];
    const evidenceId = leaf.evidence_id ?? null;
    const entry = evidenceId ? ledgerEntries.get(evidenceId) : null;
    const unknownCase = unknownCaseByPath.get(path) ?? null;
    const microcaseId = typeof leaf.microcase_id === 'string' && leaf.microcase_id
      ? leaf.microcase_id
      : (entry?.microcase_id ?? unknownCase?.microcase_id ?? null);
    const microcaseFrom = typeof leaf.microcase_id === 'string' && leaf.microcase_id ? 'leaf'
      : entry?.microcase_id ? 'ledger' : unknownCase ? 'config.unknowns' : null;
    const valueKnown = !(leaf.value === null && leaf.confidence === 'UNKNOWN');
    const record = microcaseId ? recordByCase.get(microcaseId) : undefined;
    let status = 'PROMOTABLE';
    let pendingLedgerBump = null;

    const fail = (text) => { status = 'NOT_PROMOTABLE'; reasons.push({gate: 'evidence', text}); };
    const refute = (text) => { status = 'REFUTED'; reasons.push({gate: 'consistency', text}); };

    // ① 这个字段到底是不是「待 promotion 的候选值」。
    if (!valueKnown) {
      fail(`字段本身还是 ${leaf.confidence}=null：没有候选值可 promotion，先等 `
        + `${microcaseId ? `${microcaseId} 录出读数` : '对应 microcase 录出读数'}，再由人决定填什么`
        + `${unknownCase?.reason ? `（配置 unknowns 里写的理由：${unknownCase.reason}）` : ''}`);
    }
    if (PROMOTABLE_LEVELS.includes(leaf.confidence) && leaf.evidence_role !== 'supports') {
      fail(`字段 confidence=${leaf.confidence}（可 promotion 的等级）却把 ${evidenceId} 当 ${leaf.evidence_role} 用：`
        + '拿一条反证顶 promotion 是把两件事混在一起，先按台账拆开登记');
    }

    // ② 没有对应 microcase 记录 → NOT_PROMOTABLE（说清缺哪条 MC-E）。
    if (!microcaseId) {
      fail('没有对应的 microcase：这个字段既不在 microcase-records 的 case 里，也没有 unknowns 里的 microcase_id，'
        + '「录什么才能 promotion」没有落点');
    } else if (!caseById.has(microcaseId)) {
      fail(`${microcaseId} 不在 rule-evidence-microcase-records.json 里：要录什么、录到什么算通过都还没定义`);
    } else if (!record) {
      fail(`缺 ${microcaseId} 记录：microcase-recordings.json 里没有这条实机/官方记录（本阶段 recordings 为空）`);
    } else {
      // ③ 记录等级 —— 记录本身必须已经站在可 promotion 的那两级上。
      if (!ACCEPTED_RECORD_CONFIDENCE.includes(record.confidence)) {
        fail(`${microcaseId} 记录的 confidence=${JSON.stringify(record.confidence)} 不是 `
          + `${ACCEPTED_RECORD_CONFIDENCE.join(' / ')}：这一级不足以 promotion`);
      }
      // ③b 台账引用必须存在（记录要升级的是**哪一条**结论）。
      //
      // 注意这里**不**要求台账当前等级已经是前两级：一次实机记录只能证明「够资格升级」，
      // 把台账那条改成 RECORDED_IN_GAME 是人随 promotion 一起做的动作（脚本不代做）。
      // 所以台账当前等级只作为 `pending_ledger_bump` 记账，不当作「缺证据」——
      // 否则这条判据会永远为假，而一条永远为假的判据等于没有判据。
      if (!evidenceId) {
        fail('字段没有 evidence_id：记录即使存在，也不知道该升级台账里的哪一条（先补台账引用）');
      } else if (!entry) {
        fail(`evidence_id=${evidenceId} 不在证据台账里：引用无效，先修台账`);
      } else if (!PROMOTABLE_LEVELS.includes(entry.confidence)) {
        pendingLedgerBump = {
          evidence_id: evidenceId,
          from: entry.confidence,
          to: record.confidence,
          text: `台账 ${evidenceId} 现在是 ${entry.confidence}；本次记录是 ${record.confidence}。`
            + 'promotion 时台账那条必须一并改成 RECORDED_IN_GAME/OFFICIAL_CURRENT —— 改台账是人的决定，本脚本不代做',
        };
        reasons.push({gate: 'pending_ledger_bump', text: pendingLedgerBump.text});
      }
      // ④ 观测值与候选值是否一致（不一致 = REFUTED）。
      const comparator = COMPARATORS[microcaseId];
      if (comparator) {
        const result = comparator(record.observations ?? {}, {path, value: leaf.value});
        if (result) {
          if (result.ok) reasons.push({gate: 'consistency', text: result.text});
          else refute(result.text);
        }
      } else {
        fail(`${microcaseId} 没有「观测值 ↔ 候选值」比较器：本脚本无法判断记录是否支持这个字段，`
          + '只能停在「判据未闭」——审计者必须人工读录像');
      }
      // ⑤ pass_criteria 折算出来的必观测项有没有录全。
      const required = REQUIRED_OBSERVATIONS[microcaseId];
      if (!required) {
        fail(`${microcaseId} 没有登记可复算的观测判据（REQUIRED_OBSERVATIONS 里缺这一条）`);
      } else {
        for (const requirement of required.requires) {
          const problem = shapeProblem(requirement, (record.observations ?? {})[requirement.key]);
          if (problem) fail(`pass_criteria 未满足：${problem}`);
        }
      }
      // ⑥ 记录是否过期（旧录像可能对应另一个游戏版本）。
      const stamp = parseRecordDate(record.recorded_at);
      if (stamp === null) {
        fail(`recorded_at=${JSON.stringify(record.recorded_at)} 无法解析成日期，无法判断记录是否过期`);
      } else {
        const ageDays = Math.floor((now - stamp) / DAY_MS);
        if (ageDays > maxRecordAgeDays) {
          fail(`记录过期：recorded_at=${record.recorded_at} 距今天 ${ageDays} 天，超过上限 ${maxRecordAgeDays} 天`
            + '（旧录像对应的可能是另一个游戏版本，必须重录）');
        }
      }
      // ⑦ media_ref 可不可核对 —— 这里再查一次，好让理由出现在**这个字段**下面。
      const media = checkMediaRef(record.media_ref, {root});
      if (!media.ok) fail(`记录引用不可核对：${media.detail}`);
    }

    if (status === 'PROMOTABLE') {
      reasons.push({
        gate: 'verdict',
        text: `每一条门槛都被 ${microcaseId} 的 ${record?.confidence} 记录顶住了（记录 ${record?.recorded_at}，引用 ${record?.media_ref}）——`
          + '本脚本只能证明「证据形式齐了」，值本身仍要人读录像确认',
      });
      if (pendingLedgerBump) {
        reasons.push({
          gate: 'pending_ledger_bump',
          text: `${pendingLedgerBump.evidence_id} 现在还是 ${pendingLedgerBump.from}：promotion 时台账那一行必须一并改成 ${pendingLedgerBump.to}，`
            + '否则配置的 confidence 会高于台账（build-rule-configs.mjs --check 会立刻判红）',
        });
      }
    }

    fields.push({
      path,
      config: config.ruleset_config_id,
      value: leaf.value === undefined ? null : leaf.value,
      value_kind: valueKind(leaf.value ?? null),
      confidence: leaf.confidence,
      evidence_id: evidenceId,
      evidence_role: leaf.evidence_role ?? null,
      ledger_confidence: entry?.confidence ?? null,
      needs_microcase: entry?.needs_microcase === true,
      microcase_id: microcaseId,
      microcase_from: microcaseFrom,
      value_status: leaf.value_status ?? null,
      promotion_status: status,
      pending_ledger_bump: pendingLedgerBump,
      reasons,
      deciding_gate: reasons[0]?.gate ?? null,
    });
  }

  // ⑧ candidate_config_can_be_default —— **永远是 false**。
  //
  // 这一条不是「本次恰好没有证据」，而是 RC-101/RC-102 的硬要求：候选配置在
  // 「所有 promotion 门槛都过 + 人类显式批准」之前都不许成为默认。脚本不实现「自动转默认」
  // 那条路：一个能把候选悄悄变成默认的判据，本身就是这一整轮要防的事。
  const allPromotable = fields.length > 0 && fields.every((field) => field.promotion_status === 'PROMOTABLE');
  const candidateCanBeDefault = false;

  const requiredCaseIds = microcaseIdsOf(config);
  const recordedCaseIds = new Set(recordByCase.keys());
  const missingRecordings = requiredCaseIds
    .filter((id) => !recordedCaseIds.has(id))
    .map((id) => ({
      microcase_id: id,
      title: caseById.get(id)?.title ?? null,
      plan_case: caseById.get(id)?.plan_case ?? null,
      pass_criteria: caseById.get(id)?.pass_criteria ?? null,
      required_observations: (REQUIRED_OBSERVATIONS[id]?.requires ?? []).map((row) => row.key),
      blocks_fields: fields.filter((field) => field.microcase_id === id).map((field) => field.path),
    }));

  const configText = readFileSync(configPath.startsWith('/') ? configPath : join(root, configPath));
  const configSha = sha256(configText.toString('utf8'));
  const report = {
    schema: REPORT_SCHEMA,
    generated_by: 'scripts/roco/evaluate-rule-promotion.mjs',
    task: 'RC-102 promotion gate：没有实机证据就不许 promotion（本脚本只报告，不写配置）',
    writes_config: false,
    inputs: {
      candidate_config: {path: configPath, sha256: configSha},
      ledger: {path: ledgerPath, sha256: sha256(JSON.stringify(ledger ?? {}))},
      recordings: {path: recordingsPath, sha256: sha256(JSON.stringify(recordings ?? {})), count: validation.records.length},
      case_records: {path: caseRecordsPath, cases: caseById.size},
      rc101_impact: {path: RC101_REPORT_REL},
    },
    inputs_valid: validation.ok && Array.isArray(caseRecords?.cases),
    input_issues: validation.issues,
    required_microcases: requiredCaseIds,
    recorded_microcases: [...recordedCaseIds].sort(),
    missing_recordings: missingRecordings,
    fields,
    summary: {
      fields: fields.length,
      PROMOTABLE: fields.filter((field) => field.promotion_status === 'PROMOTABLE').length,
      NOT_PROMOTABLE: fields.filter((field) => field.promotion_status === 'NOT_PROMOTABLE').length,
      REFUTED: fields.filter((field) => field.promotion_status === 'REFUTED').length,
      recordings: validation.records.length,
    },
    candidate_config_can_be_default: candidateCanBeDefault,
    candidate_config_can_be_default_reason: candidateCanBeDefault
      ? '（这条分支不该存在）'
      : '候选配置在「每个字段都 PROMOTABLE」之前不得作为默认；本脚本不实现自动转默认，'
        + `当前 ${fields.filter((f) => f.promotion_status === 'PROMOTABLE').length}/${fields.length} 个字段可 promotion`
        + `（all_promotable=${allPromotable}），且即便全绿也需要人类显式批准，所以恒为 false`,
    all_fields_promotable: allPromotable,
  };
  report.config_unchanged = report.inputs.candidate_config.sha256 === sha256(
    readFileSync(configPath.startsWith('/') ? configPath : join(root, configPath)).toString('utf8'));
  return report;
}

/** 人读版本：整份报告压成能直接贴进汇报的文本。 */
export function formatReport(report) {
  const lines = [];
  lines.push(`promotion gate（${report.schema}）· 候选配置 ${report.inputs.candidate_config.path}`);
  lines.push(`  记录 ${report.summary.recordings} 条 / 待录 microcase ${report.required_microcases.length} 条`
    + ` / 登记表合规 ${report.inputs_valid}`);
  lines.push(`  判决：PROMOTABLE ${report.summary.PROMOTABLE} · NOT_PROMOTABLE ${report.summary.NOT_PROMOTABLE} · REFUTED ${report.summary.REFUTED}`);
  for (const field of report.fields) {
    lines.push(`  [${field.promotion_status}] ${field.path} = ${JSON.stringify(field.value)}`
      + `（${field.confidence}${field.microcase_id ? ` · ${field.microcase_id}` : ' · 无 microcase'}）`);
    for (const reason of field.reasons) lines.push(`      · <${reason.gate}> ${reason.text}`);
  }
  if (report.input_issues.length) {
    lines.push(`  登记表问题 ${report.input_issues.length} 条：`);
    for (const issue of report.input_issues) lines.push(`      · [${issue.rule}] ${issue.microcase_id} — ${issue.detail}`);
  }
  lines.push(`  candidate_config_can_be_default = ${report.candidate_config_can_be_default}`
    + `（原因：${report.candidate_config_can_be_default_reason}）`);
  lines.push(`  配置未被改写：${report.config_unchanged}（sha256 ${report.inputs.candidate_config.sha256.slice(0, 16)}…）`);
  return `${lines.join('\n')}\n`;
}

// ── --selftest：自带正反用例 ─────────────────────────────────────────────
//
// 一个总是报 NOT_PROMOTABLE 的判据「看起来」很安全，但它其实什么都没判。所以这里
// 既有正向（真仓库必须全 NOT_PROMOTABLE + 配置 sha256 不变），也有必红方向：
// 每条门槛各喂一份**内存副本**，它必须报出**具体**的那条理由。
// 所有假记录只活在内存里，绝不写进 data/。
export function selftest({root = ROOT} = {}) {
  const cases = [];
  const run = (name, fn) => {
    try {
      const result = fn();
      cases.push({name, passed: result.passed, want: result.want, got: result.got});
    } catch (error) {
      cases.push({name, passed: false, want: '不抛异常', got: `抛了：${error.message}`});
    }
  };

  const abs = (rel) => (isAbsolute(rel) ? rel : join(root, rel));
  const load = () => ({
    config: readJson(abs(CANDIDATE_CONFIG_REL)),
    ledger: readJson(abs(LEDGER_REL)),
    recordings: readJson(abs(RECORDINGS_REL)),
    caseRecords: readJson(abs(CASE_RECORDS_REL)),
  });
  const base = load();
  /** 造一条**只存在于内存**的合法记录（演示用；落盘一律禁止）。 */
  const legalRecord = (overrides = {}) => ({
    microcase_id: 'MC-E01',
    recorded_at: '2026-09-21',
    confidence: 'RECORDED_IN_GAME',
    source_kind: 'recorded_gameplay',
    media_ref: 'https://example.invalid/roco/mc-e01.mp4',
    observations: {energy_max_observed: 10, charge_energy_delta: 5},
    notes: '自检用内存记录：不写盘、不代表任何真实录制。',
    ...overrides,
  });
  const withRecordings = (recordings) => ({
    ...base.recordings,
    recordings,
    status: 'SELFTEST_IN_MEMORY_ONLY',
  });
  const evalWith = (recordings, extra = {}) => evaluatePromotion({
    ...base,
    recordings,
    configPath: abs(CANDIDATE_CONFIG_REL),
    ledgerPath: abs(LEDGER_REL),
    recordingsPath: abs(RECORDINGS_REL),
    root,
    ...extra,
  });
  const fieldOf = (report, path) => report.fields.find((field) => field.path === path);

  run('正向：真仓库（recordings 为空）必须每个字段都 NOT_PROMOTABLE', () => {
    const report = evalWith(base.recordings.recordings);
    const statuses = [...new Set(report.fields.map((field) => field.promotion_status))];
    return {
      passed: base.recordings.recordings.length === 0
        && report.summary.NOT_PROMOTABLE === report.fields.length
        && report.summary.PROMOTABLE === 0 && report.summary.REFUTED === 0,
      want: '0 条记录 → PROMOTABLE 0 / REFUTED 0，其余全部 NOT_PROMOTABLE',
      got: `记录 ${report.summary.recordings} 条；判决 ${JSON.stringify(report.summary)}；出现过的状态 ${JSON.stringify(statuses)}`,
    };
  });

  run('正向：真仓库的候选配置在评判前后 sha256 不变（脚本只报告不写配置）', () => {
    const before = sha256(readFileSync(abs(CANDIDATE_CONFIG_REL)).toString('utf8'));
    const report = evalWith(base.recordings.recordings);
    const after = sha256(readFileSync(abs(CANDIDATE_CONFIG_REL)).toString('utf8'));
    return {
      passed: before === after && report.config_unchanged === true && report.writes_config === false,
      want: '前后 sha256 相同，且报告里 writes_config=false / config_unchanged=true',
      got: `before=${before.slice(0, 16)}… after=${after.slice(0, 16)}… writes_config=${report.writes_config} config_unchanged=${report.config_unchanged}`,
    };
  });

  run('反证①：缺记录 → 缺哪条 MC-E 必须写在理由里（逐个字段都点到名）', () => {
    const report = evalWith([]);
    const blind = report.fields.filter((field) => !field.reasons.some((reason) => /MC-E\d{2}|没有对应的 microcase/.test(reason.text)));
    const sample = fieldOf(report, 'energy.max');
    return {
      passed: blind.length === 0,
      want: '每个字段的理由都点名了具体的 MC-E 编号（或写明「没有对应的 microcase」）',
      got: `说到不点名的字段 ${blind.length} 条：${blind.map((f) => f.path).join('/') || '(无)'}；`
        + `示例 energy.max → ${sample?.reasons[0]?.text ?? '(无理由)'}`,
    };
  });

  run('反证②：一条合法记录（内存）必须让对应字段变 PROMOTABLE —— 判据不是恒假', () => {
    const report = evalWith([legalRecord()]);
    const field = fieldOf(report, 'energy.max');
    const others = report.fields.filter((f) => f.path !== 'energy.max' && f.promotion_status === 'PROMOTABLE');
    return {
      passed: field?.promotion_status === 'PROMOTABLE' && field.reasons.some((r) => r.gate === 'verdict')
        && report.candidate_config_can_be_default === false && others.length === 0,
      want: 'energy.max=PROMOTABLE（其余字段仍不可），candidate_config_can_be_default 仍为 false',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons?.map((r) => `${r.gate}:${r.text.slice(0, 40)}`))}；`
        + `其它字段被误判可 promotion：${others.length} 条；can_be_default=${report.candidate_config_can_be_default}`,
    };
  });

  run('反证③：观测值与候选值冲突 → REFUTED（且不改配置）', () => {
    const report = evalWith([legalRecord({observations: {energy_max_observed: 12, charge_energy_delta: 5}})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'REFUTED'
        && field.reasons.some((r) => r.gate === 'consistency' && r.text.includes('不一致'))
        && report.config_unchanged === true,
      want: 'energy.max=REFUTED，理由里贴出观测值与候选值，且配置 sha256 前后一致',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}；config_unchanged=${report.config_unchanged}`,
    };
  });

  run('反证④：记录等级不足（COMMUNITY_CURRENT）→ NOT_PROMOTABLE', () => {
    const report = evalWith([legalRecord({confidence: 'COMMUNITY_CURRENT'})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'NOT_PROMOTABLE'
        && field.reasons.some((r) => r.text.includes('COMMUNITY_CURRENT')),
      want: 'energy.max=NOT_PROMOTABLE，理由点名 confidence=COMMUNITY_CURRENT 不足',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}`,
    };
  });

  run('反证⑤：media_ref 不可核对 → NOT_PROMOTABLE', () => {
    const report = evalWith([legalRecord({media_ref: '/tmp/does-not-exist/mc-e01.mp4'})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'NOT_PROMOTABLE'
        && field.reasons.some((r) => r.text.includes('不可核对')),
      want: 'energy.max=NOT_PROMOTABLE，理由写明 media_ref 指不到东西',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}`,
    };
  });

  run('反证⑥：pass_criteria 要求的量少录一个 → NOT_PROMOTABLE', () => {
    const report = evalWith([legalRecord({observations: {energy_max_observed: 10}})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'NOT_PROMOTABLE'
        && field.reasons.some((r) => r.text.includes('charge_energy_delta')),
      want: 'energy.max=NOT_PROMOTABLE，理由指明缺 observations.charge_energy_delta',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}`,
    };
  });

  run('反证⑦：记录过期（早于保鲜期上限）→ NOT_PROMOTABLE', () => {
    const report = evalWith([legalRecord({recorded_at: '2020-01-01'})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'NOT_PROMOTABLE'
        && field.reasons.some((r) => r.text.includes('记录过期')),
      want: 'energy.max=NOT_PROMOTABLE，理由写明记录距今天数超过上限',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}`,
    };
  });

  run('反证⑧：recorded_at 不是可解析日期 → NOT_PROMOTABLE', () => {
    const report = evalWith([legalRecord({recorded_at: '上个月'})]);
    const field = fieldOf(report, 'energy.max');
    return {
      passed: field?.promotion_status === 'NOT_PROMOTABLE'
        && (field.reasons.some((r) => r.text.includes('无法解析')) || report.input_issues.some((i) => i.rule === 'record.recorded_at')),
      want: 'energy.max=NOT_PROMOTABLE，理由写明 recorded_at 不可解析（或登记表校验报 record.recorded_at）',
      got: `energy.max=${field?.promotion_status}；理由 ${JSON.stringify(field?.reasons.map((r) => r.text))}；`
        + `登记表问题 ${JSON.stringify(report.input_issues.map((i) => i.rule))}`,
    };
  });

  run('反证⑨：登记表 schema 写错 → 登记表判不合规（但仍逐字段判决，不静默当成空表）', () => {
    const bad = {...withRecordings([legalRecord()]), schema: 'roco-microcase-recordings/v0'};
    const report = evaluatePromotion({...base, recordings: bad, configPath: abs(CANDIDATE_CONFIG_REL), ledgerPath: abs(LEDGER_REL), recordingsPath: abs(RECORDINGS_REL), root});
    return {
      passed: report.inputs_valid === false
        && report.input_issues.some((issue) => issue.rule === 'schema.value')
        && fieldOf(report, 'energy.max')?.promotion_status === 'PROMOTABLE',
      want: 'inputs_valid=false 且报 schema.value；记录本身仍按内容参与判决（不许因为 schema 写错就改答案）',
      got: `inputs_valid=${report.inputs_valid}；问题 ${JSON.stringify(report.input_issues.map((i) => i.rule))}；`
        + `energy.max=${fieldOf(report, 'energy.max')?.promotion_status}`,
    };
  });

  run('反证⑩：把能顶的字段都顶绿 → candidate_config_can_be_default 仍然恒为 false', () => {
    // 真候选配置里 battle_mode.team_size / active_count 这类模式参数**没有** microcase 落点，
    // 「全字段全绿」在结构上就不可达（那本身也是要报出来的事实）。所以这一条要证明的是
    // **更强**的那件事：即便已有字段都被合法记录顶成 PROMOTABLE，脚本也不给出「可以转默认」。
    const records = [];
    const observations = {
      'MC-E01': {energy_max_observed: 10, charge_energy_delta: 5},
      'MC-E02': {charge_energy_delta: 5, charge_beyond_cap: false},
      'MC-E03': {regen_per_turn_delta: 0},
      'MC-E04': {initial_energy_observed: 2, entry_inherits_leftover: false},
      'MC-E05': {order_observed: ['respond', 'switch', 'priority', 'speed'], speed_tie_deterministic: true},
    };
    for (const [id, obs] of Object.entries(observations)) {
      records.push(legalRecord({microcase_id: id, media_ref: `https://example.invalid/roco/${id.toLowerCase()}.mp4`, observations: obs}));
    }
    const real = evalWith(records);
    const realPromotable = real.fields.filter((field) => field.promotion_status === 'PROMOTABLE').map((field) => field.path);
    // 再用一份**合成**配置把所有叶子（含模式参数）都换成有 case、有观测的叶子，
    // 验「全绿也不转默认」这条边界本身。
    const synthetic = {
      ...base.config,
      battle_mode: {
        ...base.config.battle_mode,
        team_size: {value: 6, confidence: 'CROSS_SOURCE_SUPPORTED', evidence_id: 'EV-PVP-STANDARD-TEAM-SIZE', evidence_role: 'supports', microcase_id: 'MC-E07'},
        active_count: {value: 1, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null, reason: '自检合成字段：只为验证「全绿也不转默认」', microcase_id: null},
      },
      energy: {
        max: {value: 10, confidence: 'CROSS_SOURCE_SUPPORTED', evidence_id: 'EV-ENERGY-MAX', evidence_role: 'supports', microcase_id: 'MC-E01'},
        regen: {per_turn: {value: 0, confidence: 'ENGINE_HYPOTHESIS', evidence_id: 'EV-ENERGY-ENDTURN-REGEN', evidence_role: 'supports', microcase_id: 'MC-E03'}},
        charge: {value: 5, confidence: 'CROSS_SOURCE_SUPPORTED', evidence_id: 'EV-ENERGY-CHARGE', evidence_role: 'supports', microcase_id: 'MC-E02'},
      },
      unknowns: [],
    };
    const syntheticReport = evaluatePromotion({
      ...base, config: synthetic, recordings: withRecordings(records),
      configPath: abs(CANDIDATE_CONFIG_REL), ledgerPath: abs(LEDGER_REL), recordingsPath: abs(RECORDINGS_REL), root,
    });
    return {
      passed: real.candidate_config_can_be_default === false && syntheticReport.candidate_config_can_be_default === false
        && realPromotable.length >= 2 && syntheticReport.summary.NOT_PROMOTABLE > 0,
      want: '真配置被顶绿若干字段后 can_be_default 仍 false；合成配置也 false（且必须有字段真的变绿，否则这条判据是恒假）',
      got: `真配置：${JSON.stringify(real.summary)}，变绿字段 ${JSON.stringify(realPromotable)}，can_be_default=${real.candidate_config_can_be_default}；`
        + `合成配置：${JSON.stringify(syntheticReport.summary)}，can_be_default=${syntheticReport.candidate_config_can_be_default}`,
    };
  });

  const failed = cases.filter((row) => !row.passed);
  return {ok: failed.length === 0, cases, failed: failed.length};
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    } else {
      for (const row of result.cases) {
        process.stdout.write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n`);
        process.stdout.write(`      期望：${row.want}\n      实际：${row.got}\n`);
      }
      process.stdout.write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n`
        : `自带用例失败 ${result.failed} 条\n`);
    }
    return result.ok ? 0 : 1;
  }

  const flagValue = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  const abs = (rel) => (isAbsolute(rel) ? rel : join(ROOT, rel));
  // 报告里一律写**仓库相对路径**：把本机绝对路径写进报告，换台机器就对不上，
  // 而且会让「这份报告对应哪些输入」变成一条机器不可复算的声明。
  const asReported = (rel) => {
    const absolute = abs(rel);
    const relativeToRoot = relative(ROOT, absolute);
    return relativeToRoot.startsWith('..') ? absolute : relativeToRoot;
  };
  const configRel = asReported(flagValue('--config') || CANDIDATE_CONFIG_REL);
  const ledgerRel = asReported(flagValue('--ledger') || LEDGER_REL);
  const recordingsRel = asReported(flagValue('--recordings') || RECORDINGS_REL);
  for (const rel of [configRel, ledgerRel, recordingsRel]) {
    if (!existsSync(abs(rel))) {
      process.stderr.write(`找不到输入文件：${rel}\n`);
      return 2;
    }
  }

  const report = evaluatePromotion({
    config: readJson(abs(configRel)),
    ledger: readJson(abs(ledgerRel)),
    recordings: readJson(abs(recordingsRel)),
    caseRecords: readJson(abs(CASE_RECORDS_REL)),
    configPath: configRel,
    ledgerPath: ledgerRel,
    caseRecordsPath: asReported(CASE_RECORDS_REL),
    recordingsPath: recordingsRel,
  });

  if (!argv.includes('--no-write')) {
    const target = join(ROOT, REPORT_REL);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatReport(report));
  if (!argv.includes('--no-write')) process.stdout.write(`报告已写入 ${REPORT_REL}\n`);
  if (report.input_issues.length && !argv.includes('--json')) {
    process.stdout.write(`登记表问题原文 ${report.input_issues.length} 条：\n${formatIssues(report.input_issues)}\n`);
  }
  // 退出码：判决里有 REFUTED → 2（有反证，必须有人看）；证据不全 → 1；全绿 → 0。
  if (report.summary.REFUTED > 0) return 2;
  if (report.summary.NOT_PROMOTABLE > 0) return 1;
  return 0;
}

const invoked = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (invoked) process.exit(main(process.argv.slice(2)));

export {main, ROOT as root};
