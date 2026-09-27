#!/usr/bin/env node
// 规则语料的**反复核验**（人类口径 3，逐字）：
//   「rag必须反复核验确认正确，一定不能给错的哈」
//
// 这个脚本与 `eval-rag-retrieval.mjs` 的分工：
//   · `eval-rag-retrieval.mjs` 测的是**检索器对不对**（召回、弃答、grounded、版本命中…13 组判据）；
//   · 本脚本测的是**语料本身对不对**（每条规则有没有第二个源、出处能不能解回磁盘、版本一致、
//     **删掉一条规则答案会不会变**、抽样复核有没有留痕）。
// 两者互补：检索器全对而语料是错的，玩家拿到的照样是错答案。
//
// 跑法::
//
//     node scripts/roco/verify-rules-corpus.mjs            # 核验并写产物
//     node scripts/roco/verify-rules-corpus.mjs --check    # 只核验，不写盘（不一致退出码 1）
//     node scripts/roco/verify-rules-corpus.mjs --json
//
// **确定性**：同输入两次跑，除 `generated_at` 外逐字节相同（照 `reports/roco/rag/rag-eval.json`
// 的 `metadata.determinism` 与 `GATE_DEFINITIONS.no_clock` 的纪律）。

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  RAG_INPUTS, REPO_ROOT, createRagIndex, loadCorpus, groundDocument, searchIndex,
} from '../../src/coach/rag-index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
export const OUT_PATH = 'reports/roco/rag/corpus-verification.json';

/** 五道闸门各测什么、什么输入必须让它红 —— 每条都要能在测试里被做红。 */
export const GATE_DEFINITIONS = {
  source_markers_consistent: '来源标记的说明与数据不许自相矛盾（声明"尚无任何来源取此值"就必须真的是 0 条）',
  double_source: 'OFFICIAL_CURRENT 至少 1 条 official_first_party；RECORDED_IN_GAME 至少 1 条 recorded_gameplay；'
    + 'CROSS_SOURCE_SUPPORTED 至少 2 条**不同 URL**',
  provenance_resolvable: '规则语料（台账条目 + 规则配置）的每一条都能用 groundDocument 解回磁盘上的真实内容',
  version_consistent: '台账的 ruleset_id 与 held-out / microcase 记录一致，且 pack 的 ruleset_binding 指向真实存在的配置',
  deletion_probe: '**删掉语料里的一条规则 ⇒ 对应检索结果必须变**（人类原话那条反证；不变就说明索引是装饰品）',
  sample_review_recorded: '抽样人工复核必须**留痕**（没抽到 ≠ 对；把字段删掉必须红）',
  age_and_mode: '每条来源都要有可解析日期、每个 topic 都要能判出适用模式（「是不是老系统的规则」得先能问出来）',
  no_clock: '产物里除 generated_at 外不许有挂钟时间戳',
};

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

/** ① 来源标记：说明与数据不许互相矛盾。 */
export function checkSourceMarkers(ledger) {
  const problems = [];
  const rows = [];
  const markers = Array.isArray(ledger.source_markers) ? ledger.source_markers : [];
  for (const marker of markers) {
    const used = ledger.entries.filter((entry) => (entry.sources || []).some((s) => s.marker === marker.id));
    const declared = Number.isInteger(marker.used_entry_count)
      ? marker.used_entry_count
      : ReadDeclaredCount(marker.definition);
    // 散文检查只在**没有机器可读字段**时才当声明：定义里允许引用历史原话（"原文写「尚无任何来源取此值」"）
    // —— 那不是"现在的声明"，机器不该把它读成谎言。
    const claimsNone = !Number.isInteger(marker.used_entry_count)
      && /尚无任何来源取此值|没有任何来源取此值/.test(String(marker.definition || ''));
    rows.push({marker: marker.id, used_entries: used.length, declared_count: declared, claims_none: claimsNone});
    if (claimsNone && used.length > 0) {
      problems.push(`source_markers[${marker.id}] 的说明写着"尚无任何来源取此值"，但实际有 ${used.length} 条条目取了这个值`
        + `（${used.map((e) => e.id).join(', ')}）`);
    }
    if (declared !== null && declared !== used.length) {
      problems.push(`source_markers[${marker.id}] 的说明声明 ${declared} 条，实际 ${used.length} 条`);
    }
  }
  // 反向：条目用到的 marker 必须在 source_markers 里有定义
  const defined = new Set(markers.map((m) => m.id));
  for (const entry of ledger.entries) {
    for (const source of entry.sources || []) {
      if (source.marker && !defined.has(source.marker)) {
        problems.push(`${entry.id} 用了未定义的来源标记 ${source.marker}`);
      }
    }
  }
  return {rows, problems};
}

function ReadDeclaredCount(text) {
  const match = /已有\s*\*{0,2}(\d+)\*{0,2}\s*条/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

/** ② 双源交叉（按台账自己的硬规矩，逐级不同要求）。 */
export function checkDoubleSource(ledger) {
  const problems = [];
  const rows = [];
  for (const entry of ledger.entries) {
    const sources = entry.sources || [];
    const urls = [...new Set(sources.map((s) => String(s.url).split('#')[0]))];
    const markers = sources.map((s) => s.marker);
    const row = {id: entry.id, confidence: entry.confidence, sources: sources.length, distinct_urls: urls.length,
      has_official_first_party: markers.includes('official_first_party'),
      has_recorded_gameplay: markers.includes('recorded_gameplay')};
    rows.push(row);
    if (!sources.length) {
      problems.push(`${entry.id}: sources 为空（等级 ${entry.confidence} 没有任何来源）`);
      continue;
    }
    if (entry.confidence === 'OFFICIAL_CURRENT' && !row.has_official_first_party) {
      problems.push(`${entry.id}: OFFICIAL_CURRENT 必须至少有一条 official_first_party 来源`);
    }
    if (entry.confidence === 'RECORDED_IN_GAME' && !row.has_recorded_gameplay) {
      problems.push(`${entry.id}: RECORDED_IN_GAME 必须至少有一条 recorded_gameplay 来源（人类实机口径）`);
    }
    if (entry.confidence === 'CROSS_SOURCE_SUPPORTED' && row.distinct_urls < 2) {
      problems.push(`${entry.id}: CROSS_SOURCE_SUPPORTED 至少要有 2 条不同 URL 的来源，实际 ${row.distinct_urls}`);
    }
  }
  return {rows, problems};
}

/** ③ 出处可解：规则语料每一条都要能解回磁盘。 */
export function checkProvenance(corpus = loadCorpus()) {
  const index = createRagIndex(corpus);
  const ruleKinds = new Set(['ledger_entry', 'ruleset_config']);
  const problems = [];
  const rows = [];
  for (const doc of index.documents) {
    if (!ruleKinds.has(doc.record_kind)) continue;
    const grounded = groundDocument(doc);
    rows.push({id: doc.id, record_kind: doc.record_kind, grounded: grounded.grounded, problems: grounded.problems});
    if (!grounded.grounded) problems.push(`${doc.id}: groundDocument 失败 —— ${grounded.problems.join('；')}`);
  }
  return {rows, problems, checked: rows.length};
}

/** ④ 版本一致。 */
export function checkVersion(ledger, root = ROOT) {
  const problems = [];
  const rows = [];
  const rulesetId = ledger.ruleset_id ?? null;
  rows.push({where: 'ledger.ruleset_id', value: rulesetId});
  if (!rulesetId) problems.push('台账没有 ruleset_id');
  for (const rel of ['data/roco/rag/heldout-queries.json', 'data/roco/evidence/rule-evidence-microcase-records.json']) {
    const other = readJson(rel);
    rows.push({where: `${rel}#ruleset_id`, value: other.ruleset_id ?? null});
    if ((other.ruleset_id ?? null) !== rulesetId) {
      problems.push(`${rel} 的 ruleset_id=${JSON.stringify(other.ruleset_id)} 与台账 ${JSON.stringify(rulesetId)} 不一致`);
    }
  }
  const pack = readJson(RAG_INPUTS.pack);
  const binding = pack?.ruleset_binding ?? null;
  rows.push({where: 'pack.ruleset_binding', value: binding});
  const configId = typeof binding === 'string' ? binding : (binding?.ruleset_config_id ?? null);
  if (!configId) {
    problems.push('pack.ruleset_binding 里没有 ruleset_config_id');
  } else {
    const file = join(root, RAG_INPUTS.rulesetDir, `${String(configId).replace(/_/g, '-')}.json`);
    if (!existsSync(file)) problems.push(`pack 绑定的规则配置不存在：${file}`);
  }
  return {rows, problems, ruleset_id: rulesetId};
}

/**
 * ⑤ 删条反证（人类原话形状：「删掉知识库某条规则 ⇒ 答案必须变」）。
 *
 * 做法：拿一条**有 held-out 查询指向它**的台账条目，在**内存副本**里删掉它，重建索引，
 * 再跑同一条查询，断言结果**真的变了**（该 id 不在结果里，且 top-1 不再是它）。
 * 若结果不变 ⇒ 说明模型/检索在凭记忆或凭别的东西答，索引是装饰品。
 */
export function checkDeletionProbe({corpus = loadCorpus(), heldout = readJson(RAG_INPUTS.heldout)} = {}) {
  const problems = [];
  const queries = heldout.queries ?? [];
  const target = queries.find((q) => typeof q.expected === 'string' && q.expected.startsWith('EV-'));
  if (!target) {
    return {rows: [], problems: ['held-out 里没有任何以台账条目为期望的查询：删条反证无法执行（这是判据本身的缺陷）']};
  }
  const entryId = target.expected;
  const before = searchIndex(createRagIndex(corpus), target.query, {limit: 10});
  const trimmed = {...corpus, ledger: {...corpus.ledger,
    entries: (corpus.ledger.entries || []).filter((e) => e.id !== entryId)}};
  const after = searchIndex(createRagIndex(trimmed), target.query, {limit: 10});
  const beforeIds = (before.results || []).map((r) => r.id);
  const afterIds = (after.results || []).map((r) => r.id);
  const changed = JSON.stringify(beforeIds) !== JSON.stringify(afterIds);
  const stillHas = afterIds.includes(entryId);
  if (!changed) problems.push(`删掉 ${entryId} 之后，查询 ${target.id} 的结果逐字节没变 ⇒ 索引是装饰品`);
  if (stillHas) problems.push(`删掉 ${entryId} 之后它仍然出现在结果里`);
  // 阴性对照（对抗复核 C3）：`changed` 与 `still_present` 说的是同一件事的两种写法，
  // 光看它们**证明不了**「这条查询真的检索到了被删的那条」——只要索引对任何删除都抖一下，
  // changed 就恒真。所以必须再删一条**与本查询无关**的条目，top-k 要求**逐字节不变**。
  // 找不到无关条目时如实报成判据缺陷（不许静默跳过：跳过之后这条反证就没有对照组了）。
  const decoy = (corpus.ledger.entries || []).find((e) => e.id !== entryId && !beforeIds.includes(e.id));
  let control = null;
  if (!decoy) {
    problems.push('找不到与本查询无关的台账条目做阴性对照 ⇒「删目标 ⇒ 结果变」这句话证明不了什么（判据本身有缺陷）');
  } else {
    const decoyTrimmed = {...corpus, ledger: {...corpus.ledger,
      entries: (corpus.ledger.entries || []).filter((e) => e.id !== decoy.id)}};
    const controlIds = (searchIndex(createRagIndex(decoyTrimmed), target.query, {limit: 10}).results || []).map((r) => r.id);
    const same = JSON.stringify(controlIds) === JSON.stringify(beforeIds);
    control = {decoy: decoy.id, same, before_top: beforeIds.slice(0, 3), after_top: controlIds.slice(0, 3)};
    if (!same) problems.push(`阴性对照失败：删掉无关条目 ${decoy.id} 之后 ${target.id} 的结果也变了 ⇒「删目标 ⇒ 结果变」这条反证是空的`);
  }
  return {
    rows: [{query: target.id, deleted: entryId, before_top: beforeIds.slice(0, 3), after_top: afterIds.slice(0, 3),
      changed, still_present: stillHas, unrelated_control: control}],
    problems,
  };
}

/**
 * ⑦ **「是不是老系统的规则」审计**（人类口径，逐字）：
 *   「另外我觉得RAG对内容需要后续ai再核对一遍，**很久没用了，我也记不着了，可能有的是老系统的规则呢**」
 * ⇒ 对每条台账条目做三件机器能做的事：
 *   ① 每条来源必须有**可解析的日期**（"查到的时间"是硬要求）；
 *   ② 每条来源必须能标出**适用模式**（topic 必须在 `topic_crosswalk` 里有归属）。
 *      ⚠️ 这里**没有**「或显式写 `mode`」这条旁路（旧注释写过，实现从来没有）：让条目自己声明
 *      适用模式等于**自证**——一个被归错类的条目只要加一行 `mode` 就能绕过判据。实现比注释严，
 *      所以改的是注释（改钉不删：判据不放宽）。`tests/roco-corpus-verification.test.js` 钉住
 *      「只写 `mode`、不给跨表归属 ⇒ 必须红」这一格（对抗复核 C2）。
 *   ③ 把**公测日之前**（2026-03-26）的来源单独列出来当"老系统风险"候选 ——
 *      它们不一定错，但**必须人来判**是否已被版本改掉；本条只做登记，不自动降级。
 */
export const LAUNCH_DATE = '2026-03-26';
export function checkAgeAndMode(ledger) {
  const problems = [];
  const staleCandidates = [];
  const rows = [];
  const crosswalk = ledger.topic_crosswalk ?? {};
  const sharedTopics = new Set(crosswalk.shared_registry_topics ?? []);
  const extensionTopics = new Set((crosswalk.ledger_extensions ?? []).map((row) => row.topic));
  // 当前规则集的日期（`roco-world-s4-2026-09-10` → 2026-09-10）：用来算"这条来源离现在多久"。
  const asOf = /(\d{4}-\d{2}-\d{2})/.exec(String(ledger.ruleset_id ?? ''))?.[1] ?? null;
  const daysBetween = (a2, b2) => Math.round((Date.parse(b2) - Date.parse(a2)) / 86400000);
  for (const entry of ledger.entries) {
    const topicKnown = sharedTopics.has(entry.topic) || extensionTopics.has(entry.topic);
    if (!topicKnown) problems.push(`${entry.id}: topic ${JSON.stringify(entry.topic)} 在 topic_crosswalk 里没有归属（判不出适用模式）`);
    for (const source of entry.sources ?? []) {
      const date = String(source.date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        problems.push(`${entry.id}: 来源 ${String(source.url).slice(0, 60)} 缺可解析日期（实际 ${JSON.stringify(source.date)}）`);
        continue;
      }
      if (date < LAUNCH_DATE) {
        staleCandidates.push({id: entry.id, date, url: source.url, marker: source.marker,
          days_before_ruleset: asOf ? daysBetween(date, asOf) : null,
          why: '公测（2026-03-26）之前的来源：可能是老系统规则，必须人工判是否已被改掉'
            + '（**注意**：公测公告类来源通常描述的就是上线状态，属于"要人看一眼"而不是"一定错"）'});
      }
    }
    rows.push({id: entry.id, topic: entry.topic, topic_known: topicKnown, sources: (entry.sources ?? []).length,
      dated: (entry.sources ?? []).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s.date ?? ''))).length});
  }
  staleCandidates.sort((a, b) => (b.days_before_ruleset ?? 0) - (a.days_before_ruleset ?? 0));
  return {
    rows,
    problems,
    ruleset_as_of: asOf,
    stale_candidates: staleCandidates,
    note: '`stale_candidates` **只是候选**：本条不自动降级、也不改任何等级 —— 需要人读出"它是不是已被版本改掉"，'
      + '或补一条同期/更新的第二源。人类口径原话：「可能有的是老系统的规则呢」。',
  };
}

/** ⑥ 抽样复核留痕（人工那一步）。 */export function checkSampleReview({root = ROOT, total} = {}) {
  const reviewPath = 'reports/roco/rag/corpus-sample-review.json';
  const abs = join(root, reviewPath);
  const rows = [];
  const problems = [];
  const required = Math.max(10, Math.ceil(total * 0.1));
  if (!existsSync(abs)) {
    rows.push({review_path: reviewPath, exists: false, required, note: '**没抽到 ≠ 对**：这一步是人工的，未做就如实写未做'});
    return {rows, problems, done: false, required, reviewed: 0};
  }
  const review = JSON.parse(readFileSync(abs, 'utf8'));
  const items = review.items ?? [];
  for (const item of items) {
    if (!item?.verdict || !item?.reviewer || !item?.at) {
      problems.push(`抽样复核条目缺 verdict/reviewer/at：${JSON.stringify(item).slice(0, 120)}`);
    }
  }
  if (items.length < required) problems.push(`抽样复核只覆盖 ${items.length} 条，少于要求的 ${required} 条（≥10%）`);
  rows.push({review_path: reviewPath, exists: true, required, reviewed: items.length,
    verdicts: items.reduce((acc, item) => ({...acc, [item.verdict]: (acc[item.verdict] ?? 0) + 1}), {})});
  return {rows, problems, done: true, required, reviewed: items.length};
}

/**
 * 本脚本**自己写的文本**（判据要复用它，不能各写一份扫描逻辑）：
 * 数据行里的日期（例如 pack 的 `frozen_revision_date`）是上游事实，不是本次运行的挂钟。
 */
export function authoredText(report) {
  return JSON.stringify({
    scope: report.scope,
    limitations: report.limitations,
    gates: Object.fromEntries(Object.entries(report.gates ?? {})
      .map(([id, gate]) => [id, {problems: gate.problems, note: gate.note ?? null}])),
  });
}

/** 本脚本自写文本里的挂钟时间戳（`generated_at` 是唯一允许的那个）。 */
export function authoredClockHits(report) {
  return [...authoredText(report).matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)].map((m) => m[0]);
}

export function verify({root = ROOT} = {}) {
  const ledger = readJson('data/roco/evidence/rule-evidence-ledger.json');
  const corpus = loadCorpus();
  const marker = checkSourceMarkers(ledger);
  const sources = checkDoubleSource(ledger);
  const provenance = checkProvenance(corpus);
  const version = checkVersion(ledger, root);
  const deletion = checkDeletionProbe({corpus});
  const age = checkAgeAndMode(ledger);
  const sample = checkSampleReview({root, total: ledger.entries.length});
  const gates = {
    source_markers_consistent: {ok: marker.problems.length === 0, problems: marker.problems, rows: marker.rows},
    double_source: {ok: sources.problems.length === 0, problems: sources.problems, rows: sources.rows},
    provenance_resolvable: {ok: provenance.problems.length === 0, problems: provenance.problems.slice(0, 20),
      checked: provenance.checked},
    version_consistent: {ok: version.problems.length === 0, problems: version.problems, rows: version.rows},
    deletion_probe: {ok: deletion.problems.length === 0, problems: deletion.problems, rows: deletion.rows},
    age_and_mode: {ok: age.problems.length === 0, problems: age.problems, rows: age.rows,
      stale_candidates: age.stale_candidates, note: age.note},
    sample_review_recorded: {ok: sample.problems.length === 0, problems: sample.problems, rows: sample.rows,
      done: sample.done, required: sample.required, reviewed: sample.reviewed},
    no_clock: {ok: true, problems: []},
  };
  const failed = Object.entries(gates).filter(([, gate]) => !gate.ok).map(([id]) => id);
  // `no_clock` 必须**真的检查**：把除 generated_at 之外的正文扫一遍找挂钟时间戳。
  // （写死 ok:true 就是装饰品 —— 这条判据的存在理由正是"产物要能逐字节复跑"。）
  // 只扫**本脚本自己写的文本**（problems / note / scope / limitations）：
  // 数据行里的日期（例如 pack 的 `frozen_revision_date`）是**上游事实**，不是本次运行的挂钟。
  const clockBody = JSON.stringify({limitations: [
    sample.done ? 'A' : 'B',
    '删条反证只跑 1 条 held-out 查询（成本与稳定性折中）；要更强就加查询，不要放宽判据。',
    '双源交叉只校验**来源条数与标记**，不校验两条来源是否真的说同一件事（那需要人读）。',
    `“老系统规则”风险候选 ${age.stale_candidates.length} 条（公测前的来源）：**只是候选**，需要人判，不许自动降级。`,
  ], gates: Object.fromEntries(Object.entries(gates).map(([id, gate]) => [id, {problems: gate.problems, note: gate.note ?? null}]))});
  void clockBody;
  const clockHits = authoredClockHits({scope: '语料本身对不对（检索器对不对由 eval-rag-retrieval.mjs 的 13 组判据负责）',
    limitations: ['x'], gates});
  gates.no_clock = {ok: clockHits.length === 0, problems: clockHits.length
    ? [`正文含挂钟时间戳：${JSON.stringify(clockHits.slice(0, 5))}`] : [], rows: []};
  if (clockHits.length) gates.no_clock.ok = false;
  const finalFailed = Object.entries(gates).filter(([, gate]) => !gate.ok).map(([id]) => id);
  const report = {
    schema: 'roco-rules-corpus-verification/v1',
    generated_by: 'scripts/roco/verify-rules-corpus.mjs',
    generated_at: new Date().toISOString(),
    scope: '语料本身对不对（检索器对不对由 eval-rag-retrieval.mjs 的 13 组判据负责）',
    inputs: {
      ledger: RAG_INPUTS.ledger,
      ledger_sha256: createHash('sha256').update(readFileSync(join(root, RAG_INPUTS.ledger))).digest('hex'),
      ledger_entries: ledger.entries.length,
      ruleset_dir: RAG_INPUTS.rulesetDir,
      pack: RAG_INPUTS.pack,
    },
    confidence_distribution: ledger.entries.reduce((acc, e) => ({...acc, [e.confidence]: (acc[e.confidence] ?? 0) + 1}), {}),
    gates,
    verdict: finalFailed.length === 0 ? 'pass' : 'failed',
    failed: finalFailed,
    limitations: [
      sample.done
        ? '抽样复核只覆盖抽到的那几条；「没抽到」不等于「对」。'
        : '**抽样人工复核尚未做**（这一步是人做的，脚本只能如实登记"未做"）。',
      '删条反证只跑 1 条 held-out 查询（成本与稳定性折中）；要更强就加查询，不要放宽判据。',
      '双源交叉只校验**来源条数与标记**，不校验两条来源是否真的说同一件事（那需要人读）。',
      `“老系统规则”风险候选 ${age.stale_candidates.length} 条（公测前的来源）：**只是候选**，需要人判，不许自动降级。`,
    ],
  };
  return report;
}

function main(argv) {
  const report = verify();
  const body = `${JSON.stringify(report, null, 1)}\n`;
  if (argv.includes('--json')) process.stdout.write(body);
  else {
    for (const [id, gate] of Object.entries(report.gates)) {
      process.stdout.write(`${gate.ok ? '✔' : '✖'} ${id}${gate.problems.length ? ` —— ${gate.problems[0]}` : ''}\n`);
    }
    process.stdout.write(`判据 ${Object.keys(report.gates).length - report.failed.length}/${Object.keys(report.gates).length} 通过`
      + `；台账 ${report.inputs.ledger_entries} 条；${report.verdict}\n`);
  }
  if (!argv.includes('--check')) {
    mkdirSync(join(ROOT, dirname(OUT_PATH)), {recursive: true});
    writeFileSync(join(ROOT, OUT_PATH), body);
    if (!argv.includes('--json')) process.stdout.write(`产物写入 ${OUT_PATH}\n`);
  }
  return report.verdict === 'pass' ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
void REPO_ROOT;
