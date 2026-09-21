// 规则证据台账（evidence ledger）的检查库。
//
// 为什么单独成库：`verify-evidence-ledger.mjs --selftest` 与
// `tests/roco-evidence-ledger.test.js` 必须**跑同一条判据**。
// 判据如果能被复制成两份，两份就会各自漂移，最后谁也不知道哪份算数。
//
// 这个库只回答一件事：**台账有没有把它自己的证据说清楚**。
// 它不判断“这条规则对不对”（那要靠实机 microcase），也不联网核对 URL。
//
// 一条判据如果没有必红方向，它真正的状态是“没人知道”。
// 所以每条规则下面都写了「什么输入必须让它红」。

import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 台账本体（机器可读）。 */
export const LEDGER_PATH = join(ROOT, 'data', 'roco', 'evidence', 'rule-evidence-ledger.json');
/** 微观实证 case 的录屏清单（needs_microcase 的落点）。 */
export const RECORDS_PATH = join(ROOT, 'data', 'roco', 'evidence', 'rule-evidence-microcase-records.json');
/** 仓库已有的规则 microcase 计划：本系列的 `plan_case` 必须指回它。 */
export const PLAN_PATH = join(ROOT, 'tests', 'evals', 'roco', 'cases', 'microcases-v1.jsonl');

export const LEDGER_SCHEMA = 'roco-rule-evidence-ledger/v1';
export const RECORDS_SCHEMA = 'roco-rule-evidence-microcase-records/v1';
export const EXPECTED_RULESET = 'roco-world-s4-2026-09-10';
export const EXPECTED_GAME = 'roco_world_mobile';

/**
 * 六个等级，以及它们的**强度顺序**（强 → 弱）。
 *
 * 顺序在库里定死，理由是那条反向检查：“把任意一条等级人为升一级，校验必须变红”。
 * “升一级”必须有唯一含义，不能由台账里的对象字面量顺序决定——
 * 否则改一下 JSON 里两行的先后，这条反向检查就悄悄失效了。
 * 台账声明的顺序必须与这里一致（见 checkLedger 的 levels_order 判据）。
 */
export const CONFIDENCE_ORDER = Object.freeze([
  'OFFICIAL_CURRENT',
  'RECORDED_IN_GAME',
  'COMMUNITY_CURRENT',
  'CROSS_SOURCE_SUPPORTED',
  'ENGINE_HYPOTHESIS',
  'UNKNOWN',
]);

/** 只有前两级能直接成为 current 规则（10 号文档的硬要求）。 */
export const PROMOTABLE_LEVELS = Object.freeze(['OFFICIAL_CURRENT', 'RECORDED_IN_GAME']);

/** 来源标记 → 中文定义。台账里的 `source_markers` 必须逐条覆盖这些 id。 */
export const SOURCE_MARKERS = Object.freeze({
  official_first_party: '官方一手：官方公告 / 官方账号发布页。',
  official_reproduction: '官方公告的媒体或转述转载；**不计入前两级**。',
  recorded_gameplay: '项目自己保存的可复核实机证据（录屏 / 截图 / 实测台账）。',
  community: '社区页面 / 社区归档 / 社区攻略。',
  repo_internal: '本仓库内部事实源（代码 / 快照数据 / 待验计划）。',
  product_context: '产品设计前提，不是游戏规则证据。',
});

/**
 * 能让 OFFICIAL_CURRENT / RECORDED_IN_GAME 成立的来源标记集合。
 *
 * `official_reproduction` 被**刻意排除**：17173 之类的全文转载无法证明与原公告逐字一致，
 * 它只能支撑 CROSS_SOURCE_SUPPORTED。这条是本台账最容易被人情压力放宽的地方，
 * 所以把它写成常量而不是注释。
 */
export const OFFICIAL_MARKERS = Object.freeze(['official_first_party']);
export const RECORDED_MARKERS = Object.freeze(['recorded_gameplay']);

const ENTRY_REQUIRED = ['id', 'topic', 'claim', 'confidence', 'sources',
  'needs_microcase', 'microcase_id', 'affected_artifacts', 'notes'];
const SOURCE_REQUIRED = ['url', 'date', 'level', 'marker', 'quote'];

export const MICROCASE_ID_RE = /^MC-E\d{2}$/;
export const PLAN_CASE_ID_RE = /^MC-\d{3}$/;

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 把来源的 `url` 解析成仓库内路径；不是仓库内路径（例如 http(s)）返回 null。
 * 台账允许把来源写成仓库内文件，但那必须**真的存在**——“我们记在某个文档里了”
 * 如果那个文档根本不存在，和没记是一样的。
 */
export function repoRelativeSource(url, {root = ROOT} = {}) {
  const raw = String(url || '').split('#')[0];
  if (!raw || /^https?:\/\//.test(raw)) return null;
  if (raw.startsWith('/')) return {relative: raw, absolute: raw, exists: existsSync(raw)};
  return {relative: raw, absolute: join(root, raw), exists: existsSync(join(root, raw))};
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 台账里出现过的、`needs_microcase=true` 的条目所引用的 case id。 */
export function requiredMicrocaseIds(ledger) {
  const ids = [];
  for (const entry of ledger?.entries || []) {
    if (entry?.needs_microcase === true && entry.microcase_id) ids.push(entry.microcase_id);
  }
  return [...new Set(ids)].sort();
}

/**
 * 反向检查的工具：把某一条的等级**人为升到指定等级**，返回一份**内存副本**。
 *
 * 为什么不落盘：这条检查会在测试与 selftest 里跑很多次。
 * 一份会被测试改脏的台账，比没有台账更糟。
 *
 * 注意“升一级”的两种读法，第一种是**错的**：
 *   ① 按 CONFIDENCE_ORDER 往下退一格：CROSS_SOURCE_SUPPORTED → COMMUNITY_CURRENT，
 *      后者要求更宽松，校验当然还是绿的——那样这条反向检查会变成一个永远看不见的红灯。
 *   ② 升到某个**更强**的等级：例如 CROSS_SOURCE_SUPPORTED → OFFICIAL_CURRENT，
 *      来源够不够官方这一栏立刻就要打架。
 * 反向检查要问的是“等级被人为抬高时规则会不会拦”，所以用第二种读法，
 * 并把“任意一条都能被抬到 OFFICIAL_CURRENT 而变红”写成一条可跑的全量判据
 * （见 selftest 的反证①与 upgradeSweep）。
 */
export function upgradeTo(ledger, entryId, level) {
  if (!CONFIDENCE_ORDER.includes(level)) throw new Error(`目标等级 ${level} 不在六选一里`);
  const copy = structuredClone(ledger);
  const entry = (copy.entries || []).find((row) => row.id === entryId);
  if (!entry) throw new Error(`台账里没有条目 ${entryId}`);
  const from = CONFIDENCE_ORDER.indexOf(entry.confidence);
  const to = CONFIDENCE_ORDER.indexOf(level);
  if (from < 0) throw new Error(`条目 ${entryId} 的等级 ${entry.confidence} 不在六选一里`);
  if (to >= from) throw new Error(`条目 ${entryId} 当前是 ${entry.confidence}，${level} 不比它强，这不是“升一级”`);
  entry.confidence = level;
  return copy;
}

/** 「升一级」= 抬到比当前更强的**最弱**那一档（OFFICIAL_CURRENT 是天花板）。 */
export function promoteConfidence(ledger, entryId) {
  const entry = (ledger.entries || []).find((row) => row.id === entryId);
  if (!entry) throw new Error(`台账里没有条目 ${entryId}`);
  const index = CONFIDENCE_ORDER.indexOf(entry.confidence);
  if (index <= 0) throw new Error(`条目 ${entryId} 已经是最强等级，无法再升级`);
  return upgradeTo(ledger, entryId, CONFIDENCE_ORDER[index - 1]);
}

/** 任意内存改动，返回副本；调用方不要落盘。 */
export function mutateEntry(ledger, entryId, change) {
  const copy = structuredClone(ledger);
  const entry = (copy.entries || []).find((row) => row.id === entryId);
  if (!entry) throw new Error(`台账里没有条目 ${entryId}`);
  change(entry);
  return copy;
}

/**
 * 全量反向检查：把**每一条**抬到 OFFICIAL_CURRENT，校验都必须变红。
 *
 * 为什么是全量而不是挑一条：挑一条的话，只要那一条恰好能被它自己的来源顶住
 * （例如本来就带官方一手来源），这条判据就会静默失效。
 * 返回那些“抬上去竟然没红”的条目，空数组才代表这条判据真的成立。
 */
export function upgradeSweep(ledger, options = {}) {
  const survivors = [];
  for (const entry of ledger?.entries || []) {
    if (entry?.confidence === 'OFFICIAL_CURRENT') continue;
    let report;
    try {
      report = checkLedger(upgradeTo(ledger, entry.id, 'OFFICIAL_CURRENT'), options);
    } catch (error) {
      survivors.push({id: entry.id, detail: `升不上去：${error.message}`});
      continue;
    }
    if (report.ok) survivors.push({id: entry.id, detail: '抬到 OFFICIAL_CURRENT 之后校验仍然是绿的'});
  }
  return survivors;
}

/** 把问题清单压成可读的多行文本（报告与测试断言都用它）。 */
export function formatIssues(issues) {
  return issues.map((row) => `${row.evidence_id} · ${row.rule} · ${row.detail}`).join('\n');
}

function checkSource(source, {evidenceId, index, issues, root}) {
  const where = `sources[${index}]`;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    issues.push({evidence_id: evidenceId, rule: 'source.shape', detail: `${where} 不是对象`});
    return;
  }
  for (const field of SOURCE_REQUIRED) {
    if (typeof source[field] !== 'string' || !source[field].trim()) {
      issues.push({
        evidence_id: evidenceId,
        rule: 'source.required_field',
        detail: `${where} 缺少非空字段 ${field}（实际值：${JSON.stringify(source[field] ?? null)}）`,
      });
    }
  }
  if (typeof source.url === 'string' && source.url.trim() && !/^https?:\/\//.test(source.url)) {
    const repo = repoRelativeSource(source.url, {root});
    if (!repo?.exists) {
      issues.push({
        evidence_id: evidenceId,
        rule: 'source.url_resolvable',
        detail: `${where} 的 url 既不是 http(s)，也不是仓库里存在的文件：${JSON.stringify(source.url)}`,
      });
    }
  }
  if (typeof source.level === 'string' && source.level.trim()
      && !CONFIDENCE_ORDER.includes(source.level)) {
    issues.push({
      evidence_id: evidenceId,
      rule: 'source.level_legal',
      detail: `${where} 的 level 不在六选一里：${JSON.stringify(source.level)}`,
    });
  }
  if (typeof source.marker === 'string' && source.marker.trim()
      && !Object.hasOwn(SOURCE_MARKERS, source.marker)) {
    issues.push({
      evidence_id: evidenceId,
      rule: 'source.marker_legal',
      detail: `${where} 的 marker 未在 source_markers 里定义：${JSON.stringify(source.marker)}`,
    });
  }
}

/**
 * 逐条校验台账。返回 `{ok, issues, summary}`。
 *
 * `options.records` / `options.planCaseIds` 允许测试注入内存副本；
 * 不传时会去读仓库里的真实文件（缺失即算问题）。
 */
export function checkLedger(ledger, options = {}) {
  const issues = [];
  const add = (evidence_id, rule, detail) => issues.push({evidence_id, rule, detail});

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return {ok: false, issues: [{evidence_id: 'ledger', rule: 'schema', detail: '台账不是对象'}], summary: {}};
  }
  // ① 顶层字段。缺任何一个，这份台账都说不清“它管哪一版、依据谁”。
  if (ledger.schema !== LEDGER_SCHEMA) {
    add('ledger', 'schema', `schema 是 ${JSON.stringify(ledger.schema)}，应为 ${LEDGER_SCHEMA}`);
  }
  for (const field of ['ruleset_id', 'generated_by', 'game', 'source_id', 'provenance']) {
    if (ledger[field] === undefined || ledger[field] === null) {
      add('ledger', 'required_top_level', `缺少顶层字段 ${field}`);
    }
  }
  if (ledger.ruleset_id !== undefined && ledger.ruleset_id !== EXPECTED_RULESET) {
    add('ledger', 'ruleset_id', `ruleset_id 是 ${JSON.stringify(ledger.ruleset_id)}，应为 ${EXPECTED_RULESET}`);
  }
  if (ledger.game !== undefined && ledger.game !== EXPECTED_GAME) {
    add('ledger', 'game', `game 是 ${JSON.stringify(ledger.game)}，应为 ${EXPECTED_GAME}`);
  }

  // ② 六个等级的定义必须齐全，且顺序与 CONFIDENCE_ORDER 一致。
  const levels = Array.isArray(ledger.confidence_levels) ? ledger.confidence_levels : [];
  const levelIds = levels.map((row) => row?.id);
  for (const level of CONFIDENCE_ORDER) {
    if (!levelIds.includes(level)) {
      add('ledger', 'levels_complete', `confidence_levels 里缺少等级定义 ${level}`);
    }
  }
  const duplicated = levelIds.filter((id, index) => levelIds.indexOf(id) !== index);
  if (duplicated.length) {
    add('ledger', 'levels_unique', `confidence_levels 里等级重复：${duplicated.join('/')}`);
  }
  const declaredOrder = levels.map((row) => row?.id).filter((id) => CONFIDENCE_ORDER.includes(id));
  if (declaredOrder.join('>') !== CONFIDENCE_ORDER.join('>')) {
    add('ledger', 'levels_order',
      `confidence_levels 的声明顺序 ${declaredOrder.join('>')} 与判据里的强度顺序 ${CONFIDENCE_ORDER.join('>')} 不一致（“升一级”会因此失去唯一含义）`);
  }
  for (const row of levels) {
    if (typeof row?.definition !== 'string' || !row.definition.trim()) {
      add('ledger', 'level_definition', `等级 ${JSON.stringify(row?.id)} 缺 definition`);
    }
    const promotable = PROMOTABLE_LEVELS.includes(row?.id);
    if (row?.can_promote_to_current_rule !== promotable) {
      add('ledger', 'level_promotable',
        `等级 ${row?.id} 的 can_promote_to_current_rule 是 ${JSON.stringify(row?.can_promote_to_current_rule)}，应为 ${promotable}（只有前两级能直接成为 current 规则）`);
    }
  }
  const noteText = String(ledger.confidence_levels_note || '');
  if (!/只有前两级|前两级/.test(noteText)) {
    add('ledger', 'levels_note', 'confidence_levels_note 没有写明“只有前两级能直接成为 current 规则”');
  }

  // ③ 来源标记必须逐条定义。
  const markers = Array.isArray(ledger.source_markers) ? ledger.source_markers : [];
  const markerIds = markers.map((row) => row?.id);
  for (const marker of Object.keys(SOURCE_MARKERS)) {
    if (!markerIds.includes(marker)) {
      add('ledger', 'markers_complete', `source_markers 里缺少标记定义 ${marker}`);
    }
  }

  // ④ 逐条。
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (!entries.length) add('ledger', 'entries', 'entries 为空：没有任何一条规则被登记');
  const seenIds = new Set();
  const topicCount = new Map();
  for (const entry of entries) {
    const evidenceId = entry && typeof entry.id === 'string' && entry.id.trim() ? entry.id : '(缺 id)';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add(evidenceId, 'entry.shape', '条目不是对象');
      continue;
    }
    for (const field of ENTRY_REQUIRED) {
      if (entry[field] === undefined) {
        add(evidenceId, 'entry.required_field', `缺少字段 ${field}（实际值：undefined）`);
      }
    }
    if (seenIds.has(entry.id)) add(evidenceId, 'entry.unique_id', `id 重复：${entry.id}`);
    seenIds.add(entry.id);
    if (typeof entry.topic !== 'string' || !entry.topic.trim()) {
      add(evidenceId, 'entry.topic', `topic 必须是非空字符串，实际：${JSON.stringify(entry.topic ?? null)}`);
    } else {
      topicCount.set(entry.topic, (topicCount.get(entry.topic) || 0) + 1);
    }
    if (typeof entry.claim !== 'string' || entry.claim.trim().length < 8) {
      add(evidenceId, 'entry.claim', `claim 必须是一句说得清“按什么施工”的中文，实际：${JSON.stringify(entry.claim ?? null)}`);
    }
    if (!CONFIDENCE_ORDER.includes(entry.confidence)) {
      add(evidenceId, 'entry.confidence_legal',
        `confidence 不在六选一里：${JSON.stringify(entry.confidence ?? null)}`);
    }
    if (typeof entry.needs_microcase !== 'boolean') {
      add(evidenceId, 'entry.needs_microcase_bool',
        `needs_microcase 必须是布尔，实际：${JSON.stringify(entry.needs_microcase ?? null)}`);
    }
    // notes 不是可选装饰：每条都要写清“这条为什么是这个等级”。
    if (typeof entry.notes !== 'string' || entry.notes.trim().length < 8) {
      add(evidenceId, 'entry.notes', `notes 不能为空，实际：${JSON.stringify(entry.notes ?? null)}`);
    }
    // 不允许空 affected_artifacts：一条“改了谁都不影响”的规则不存在。
    if (!Array.isArray(entry.affected_artifacts) || entry.affected_artifacts.length === 0) {
      add(evidenceId, 'entry.affected_artifacts',
        `affected_artifacts 不能为空，实际：${JSON.stringify(entry.affected_artifacts ?? null)}`);
    }
    if (entry.needs_microcase === true) {
      if (typeof entry.microcase_id !== 'string' || !MICROCASE_ID_RE.test(entry.microcase_id)) {
        add(evidenceId, 'entry.microcase_id',
          `needs_microcase=true 时 microcase_id 必须形如 MC-E01，实际：${JSON.stringify(entry.microcase_id ?? null)}`);
      }
    } else if (entry.microcase_id !== null && entry.microcase_id !== undefined) {
      add(evidenceId, 'entry.microcase_id_unexpected',
        `needs_microcase=false 却带 microcase_id=${JSON.stringify(entry.microcase_id)}（要么补 case，要么删字段）`);
    }

    // 来源本身的形状。
    const sources = [];
    if (!Array.isArray(entry.sources)) {
      add(evidenceId, 'entry.sources_array', `sources 必须是数组，实际：${JSON.stringify(entry.sources ?? null)}`);
    } else {
      entry.sources.forEach((source, index) => {
        checkSource(source, {evidenceId, index, issues, root: options.root || ROOT});
        if (source && typeof source === 'object') sources.push(source);
      });
    }

    // 判据 A：每个等级至少一条来源。
    if (!sources.length) {
      add(evidenceId, 'sources_nonempty', `sources 为空：等级 ${entry.confidence} 没有任何来源`);
    }
    // 判据 B：等级合法时按等级追加要求。
    const markersOf = (list, wanted) => list.filter((source) => wanted.includes(source.marker));
    if (entry.confidence === 'OFFICIAL_CURRENT') {
      if (!markersOf(sources, OFFICIAL_MARKERS).length) {
        add(evidenceId, 'official_first_party_required',
          `OFFICIAL_CURRENT 必须至少有一条 official_first_party 来源；实际 marker 集合：${JSON.stringify(sources.map((s) => s.marker))}`);
      }
    }
    if (entry.confidence === 'RECORDED_IN_GAME') {
      if (!markersOf(sources, RECORDED_MARKERS).length) {
        add(evidenceId, 'recorded_gameplay_required',
          `RECORDED_IN_GAME 必须至少有一条 recorded_gameplay 来源；实际 marker 集合：${JSON.stringify(sources.map((s) => s.marker))}`);
      }
    }
    if (entry.confidence === 'CROSS_SOURCE_SUPPORTED') {
      const urls = [...new Set(sources.map((source) => source.url).filter(Boolean))];
      if (urls.length < 2) {
        add(evidenceId, 'cross_source_two_urls',
          `CROSS_SOURCE_SUPPORTED 至少需要两条 URL 不同的来源；实际 ${urls.length} 条：${JSON.stringify(urls)}`);
      }
    }
    if (entry.confidence === 'UNKNOWN' && sources.length) {
      add(evidenceId, 'unknown_no_sources',
        `UNKNOWN 不该挂来源（那会让“未知”看起来像有证据）；实际 ${sources.length} 条`);
    }
    // 判据 C：来源的等级不能**高于**它支撑的条目等级。
    // 一个标成 OFFICIAL_CURRENT 的条目带着一条 OFFICIAL_CURRENT 来源，
    // 说的就是“我们另有一条官方结论被挂在一条还没有官方结论的规则下面”——
    // 这条规则不可能成立，所以必须红。
    for (const source of sources) {
      const entryIndex = CONFIDENCE_ORDER.indexOf(entry.confidence);
      const sourceIndex = CONFIDENCE_ORDER.indexOf(source.level);
      if (entryIndex >= 0 && sourceIndex >= 0 && sourceIndex < entryIndex) {
        add(evidenceId, 'source.level_not_above_entry',
          `来源 ${source.url} 的 level=${source.level} 强于条目等级 ${entry.confidence}（来源最多只能与条目同级）`);
      }
    }
    // 判据 D：官方一手来源只能出现在 OFFICIAL_CURRENT 条目上。
    //
    // 这条是反证①-全量（每一条抬到 OFFICIAL_CURRENT 都必须红）能成立的前提，
    // 也修掉一个真实的自欺：把一条 OFFICIAL_CURRENT 来源挂在 ENGINE_HYPOTHESIS
    // 条目上（“这条官方材料只是参考”），读的人会以为该条目已经有官方支撑。
    // 真需要区分“官方材料说什么”和“我们打算怎么施工”时，拆成两条登记——
    // 让来源跟着它真正支撑的那一条走。
    if (entry.confidence !== 'OFFICIAL_CURRENT') {
      const officials = sources.filter((source) => OFFICIAL_MARKERS.includes(source.marker));
      if (officials.length) {
        add(evidenceId, 'official_source_on_weaker_entry',
          `等级 ${entry.confidence} 的条目带了 official_first_party 来源 ${JSON.stringify(officials.map((s) => s.url))}：`
          + '官方一手来源只能出现在 OFFICIAL_CURRENT 条目上（否则这条来源看起来像是在支撑它）');
      }
    }
    // 判据 E：前两级不许只靠“官方公告转载”顶。
    if (PROMOTABLE_LEVELS.includes(entry.confidence)
        && sources.length
        && !sources.some((source) => OFFICIAL_MARKERS.includes(source.marker) || RECORDED_MARKERS.includes(source.marker))) {
      add(evidenceId, 'reproduction_not_promotable',
        `等级 ${entry.confidence} 只能由 official_first_party / recorded_gameplay 支撑，官方公告转载不算`);
    }
  }

  // ⑤ 跨文件：needs_microcase 指向的 case 必须真的存在。
  const microIds = requiredMicrocaseIds(ledger);
  const records = options.records;
  const planCaseIds = options.planCaseIds;
  if (records === undefined) {
    add('ledger', 'records_available', `读不到录屏清单 ${RECORDS_PATH}`);
  } else {
    if (records.schema !== RECORDS_SCHEMA) {
      add('ledger', 'records_schema', `录屏清单 schema 是 ${JSON.stringify(records.schema)}，应为 ${RECORDS_SCHEMA}`);
    }
    const recordIds = (records.cases || []).map((row) => row?.id);
    for (const id of microIds) {
      if (!recordIds.includes(id)) {
        add('ledger', 'microcase_recorded', `台账引用了 ${id}，但录屏清单里没有这条 case（“要录什么”没有落点）`);
      }
    }
    for (const row of records.cases || []) {
      const caseId = row?.id || '(缺 id)';
      if (!MICROCASE_ID_RE.test(String(row?.id))) {
        add(caseId, 'record.id_shape', `case id 必须形如 MC-E01，实际：${JSON.stringify(row?.id ?? null)}`);
      }
      for (const field of ['title', 'for_rule', 'record', 'pass_criteria', 'template']) {
        const value = row?.[field];
        if (Array.isArray(value) ? value.length === 0 : (typeof value !== 'string' || !value.trim())) {
          add(caseId, 'record.required_field', `缺少非空字段 ${field}（实际值：${JSON.stringify(value ?? null)}）`);
        }
      }
      // 通过判据必须写清“看什么就是答案”，不能是“看起来对”。
      const criteria = String(row?.pass_criteria || '');
      if (criteria && !/(就是答案|为准|即答案|判据)/.test(criteria)) {
        add(caseId, 'record.pass_criteria_checkable',
          'pass_criteria 没有写清“录到哪个观测值就算通过”（缺“就是答案 / 为准 / 即答案 / 判据”这类可判定措辞）');
      }
      if (planCaseIds instanceof Set && row?.plan_case) {
        if (!PLAN_CASE_ID_RE.test(String(row.plan_case))) {
          add(caseId, 'record.plan_case_shape', `plan_case 必须形如 MC-007，实际：${JSON.stringify(row.plan_case)}`);
        } else if (!planCaseIds.has(row.plan_case)) {
          add(caseId, 'record.plan_case_exists', `plan_case ${row.plan_case} 不在 ${PLAN_PATH} 里`);
        }
      }
    }
  }

  // ⑥ 条目引用的 for_rule 必须真的在台账里（反向的孤儿 case 会让人误以为覆盖了）。
  if (records) {
    const ledgerIds = new Set(entries.map((entry) => entry?.id));
    for (const row of records.cases || []) {
      if (row?.for_rule && !ledgerIds.has(row.for_rule)) {
        add(row.id, 'record.for_rule_exists', `for_rule ${row.for_rule} 不在台账条目里`);
      }
    }
  }

  const summary = {
    entries: entries.length,
    confidence: CONFIDENCE_ORDER.reduce((acc, level) => {
      acc[level] = entries.filter((entry) => entry?.confidence === level).length;
      return acc;
    }, {}),
    needs_microcase: entries.filter((entry) => entry?.needs_microcase === true).length,
    microcase_ids: microIds,
    topics: [...topicCount.keys()].sort(),
    ledger_sha256: sha256(JSON.stringify(ledger)),
  };
  return {ok: issues.length === 0, issues, summary};
}

/** 读仓库真实文件并校验。测试与 CLI 都走这里，避免两套读法。 */
export function checkRepo({root = ROOT, ledgerPath = null} = {}) {
  const problems = [];
  const ledgerFile = ledgerPath || join(root, 'data', 'roco', 'evidence', 'rule-evidence-ledger.json');
  const recordsPath = join(root, 'data', 'roco', 'evidence', 'rule-evidence-microcase-records.json');
  const planPath = join(root, 'tests', 'evals', 'roco', 'cases', 'microcases-v1.jsonl');
  if (!existsSync(ledgerFile)) {
    return {ok: false, issues: [{evidence_id: 'ledger', rule: 'exists', detail: `找不到台账：${ledgerFile}`}], summary: {}};
  }
  let ledger;
  try {
    ledger = readJson(ledgerFile);
  } catch (error) {
    return {ok: false, issues: [{evidence_id: 'ledger', rule: 'json', detail: `台账不是合法 JSON：${error.message}`}], summary: {}};
  }
  let records = null;
  if (existsSync(recordsPath)) {
    try {
      records = readJson(recordsPath);
    } catch (error) {
      problems.push({evidence_id: 'records', rule: 'json', detail: `录屏清单不是合法 JSON：${error.message}`});
    }
  }
  let planCaseIds = null;
  if (existsSync(planPath)) {
    planCaseIds = new Set(readFileSync(planPath, 'utf8').split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line).case_id; } catch { return null; }
      })
      .filter(Boolean));
  }
  const report = checkLedger(ledger, {records, planCaseIds, root});
  report.issues.unshift(...problems);
  report.ok = report.issues.length === 0;
  report.ledger_path = resolve(ledgerFile);
  return report;
}

// ── --selftest：这个检查器自己的正反用例 ────────────────────────────────
//
// 自带用例的理由和 verify-provenance.mjs 一样：一个总是报绿的检查会被当成
// “已经查过了”。所以这里既有正向（真台账必须过），也有必红方向
// （改坏之后必须报出**具体**问题，而不只是 ok=false）。
export function selftest() {
  const cases = [];
  const run = (name, fn) => {
    try {
      const result = fn();
      cases.push({name, passed: result.passed, want: result.want, got: result.got, detail: result.detail});
    } catch (error) {
      cases.push({name, passed: false, want: '不抛异常', got: `抛了：${error.message}`, detail: error.stack});
    }
  };

  const ledger = readJson(LEDGER_PATH);
  const records = readJson(RECORDS_PATH);
  const planCaseIds = new Set(readFileSync(PLAN_PATH, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).case_id));

  run('正向：真台账必须过', () => {
    const report = checkLedger(ledger, {records, planCaseIds});
    return {
      passed: report.ok === true,
      want: 'ok=true，0 条问题',
      got: `ok=${report.ok}，问题 ${report.issues.length} 条：${formatIssues(report.issues) || '(无)'}`,
    };
  });

  run('反证①：把一条 CROSS_SOURCE_SUPPORTED 抬成 OFFICIAL_CURRENT 必须红',
    () => {
      const tampered = upgradeTo(ledger, 'EV-ENERGY-MAX', 'OFFICIAL_CURRENT');
      const report = checkLedger(tampered, {records, planCaseIds});
      const hit = report.issues.filter((row) => row.rule === 'official_first_party_required'
        || row.rule === 'reproduction_not_promotable');
      return {
        passed: report.ok === false && hit.length > 0,
        want: 'ok=false，且报出 official_first_party_required / reproduction_not_promotable',
        got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
      };
    });

  run('反证①-全量：每一条抬到 OFFICIAL_CURRENT 都必须红（不许有幸存者）', () => {
    const survivors = upgradeSweep(ledger, {records, planCaseIds});
    return {
      passed: survivors.length === 0,
      want: '幸存者 0 条',
      got: `幸存者 ${survivors.length} 条：${survivors.map((row) => `${row.id}（${row.detail}）`).join(' | ') || '(无)'}`,
    };
  });

  run('反证①-转载：把只有官方公告转载的条目抬成 OFFICIAL_CURRENT 也必须红', () => {
    // EV-PVP-STANDARD-TEAM-SIZE 的来源 marker 是 community + official_reproduction。
    // 转载**不算**官方一手，所以抬上去必须被拦——这条防的正是“拿一篇转载当官方”。
    const tampered = upgradeTo(ledger, 'EV-PVP-STANDARD-TEAM-SIZE', 'OFFICIAL_CURRENT');
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'official_first_party_required');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 official_first_party_required',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证②：删掉 needs_microcase=true 条目的 microcase_id 必须红',
    () => {
      const tampered = mutateEntry(ledger, 'EV-ENERGY-CHARGE', (entry) => { delete entry.microcase_id; });
      const report = checkLedger(tampered, {records, planCaseIds});
      const hit = report.issues.filter((row) => row.rule === 'entry.required_field' || row.rule === 'entry.microcase_id');
      return {
        passed: report.ok === false && hit.length > 0,
        want: 'ok=false，且报出缺 microcase_id',
        got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
      };
    });

  run('反证③：把某条 sources 清空必须红', () => {
    const tampered = mutateEntry(ledger, 'EV-MARKS-PERSISTENCE', (entry) => { entry.sources = []; });
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'sources_nonempty');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 sources_nonempty',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证④：把一条 COMMUNITY_CURRENT 抬成 RECORDED_IN_GAME 必须红（没有录屏来源）', () => {
    const tampered = upgradeTo(ledger, 'EV-SWIFT-INJECTION', 'RECORDED_IN_GAME');
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'recorded_gameplay_required');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 recorded_gameplay_required',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑤：把 CROSS_SOURCE_SUPPORTED 降到只剩一条来源必须红', () => {
    const tampered = mutateEntry(ledger, 'EV-PVP-STANDARD-MANA', (entry) => { entry.sources = entry.sources.slice(0, 1); });
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'cross_source_two_urls');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 cross_source_two_urls',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑥：把 affected_artifacts 清空必须红', () => {
    const tampered = mutateEntry(ledger, 'EV-TYPE-MULTIPLIER', (entry) => { entry.affected_artifacts = []; });
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'entry.affected_artifacts');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 entry.affected_artifacts',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑦：把 confidence 写成不在六选一里的值必须红', () => {
    const tampered = mutateEntry(ledger, 'EV-ENERGY-MAX', (entry) => { entry.confidence = 'VERIFIED_OFFICIAL'; });
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'entry.confidence_legal');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 entry.confidence_legal',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑧：把台账引用到一个不存在的 microcase 必须红', () => {
    const tampered = mutateEntry(ledger, 'EV-ENERGY-MAX', (entry) => { entry.microcase_id = 'MC-E99'; });
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'microcase_recorded');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 microcase_recorded',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(无)'}`,
    };
  });

  run('反证⑨：给等级定义少写一个等级必须红', () => {
    const tampered = structuredClone(ledger);
    tampered.confidence_levels = tampered.confidence_levels.filter((row) => row.id !== 'UNKNOWN');
    const report = checkLedger(tampered, {records, planCaseIds});
    const hit = report.issues.filter((row) => row.rule === 'levels_complete');
    return {
      passed: report.ok === false && hit.length > 0,
      want: 'ok=false，且报出 levels_complete',
      got: `ok=${report.ok}；命中 ${hit.length} 条：${hit.map((row) => row.detail).join(' | ') || '(无)'}`,
    };
  });

  const failed = cases.filter((row) => !row.passed);
  return {ok: failed.length === 0, cases, failed: failed.length};
}
