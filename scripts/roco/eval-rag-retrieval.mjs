// RC-204 held-out 检索评测 runner。
//
// 它回答四个问题，每个问题都必须能被**单独证伪**：
//   ① 这套 held-out 查询集真的 held-out 吗？（泄漏检查 + 与既有 fixture 的交集判据）
//   ② 每条期望值真的能从语料推出来吗？（derived_from 的引用与锚点逐条核对）
//   ③ 检索指标是多少？（Recall@K / MRR / 实体命中 / 版本命中 / grounded precision / 冲突弃答）
//   ④ 换成**现有实现原样**会怎样？（基线必须一起报，不许只报对自己有利的那一套）
//
// 用法：
//   node scripts/roco/eval-rag-retrieval.mjs            写报告 + 打印对照表
//   node scripts/roco/eval-rag-retrieval.mjs --baseline 只打印三套检索器的对照表
//   node scripts/roco/eval-rag-retrieval.mjs --json     打印完整报告 JSON
//   node scripts/roco/eval-rag-retrieval.mjs --check    重算并与磁盘报告逐字节比较（忽略 metadata.generated_at）
//   node scripts/roco/eval-rag-retrieval.mjs --selftest 跑 6 条必红反证的注入自检
//
// 判据实现全部导出：tests/roco-rag-eval.test.js 与 --selftest 跑的是**同一份代码**。
// 判据写两遍就会各自漂移，最后谁也不知道哪份算数。

import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve as resolvePath} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  ABSTAIN,
  EVIDENCE_LEVELS,
  RAG_INPUTS,
  REPO_ROOT,
  SCORE_FLOOR,
  createRagIndex,
  evidenceRank,
  groundDocument,
  loadCorpus,
  searchIndex,
  tokenize,
} from '../../src/coach/rag-index.js';
import {CONFIDENCE_ORDER} from './evidence-ledger-lib.mjs';
import {searchKnowledge, tokens as strategistTokens} from '../../src/coach/strategist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolvePath(HERE, '..', '..');
export const HELDOUT_PATH = join(ROOT, RAG_INPUTS.heldout);
export const REPORT_PATH = join(ROOT, RAG_INPUTS.report);

/** 五类，每类至少这么多条。少一条就要红。 */
export const CATEGORY_MIN = 8;
export const TOTAL_MIN = 40;
/** 查询与语料单条文档允许的最长逐字重合（字符数）。 */
export const LEAK_SPAN_LIMIT = 8;
export const CATEGORY_ORDER = ['entity_alias', 'skill_mechanic', 'rule_version', 'conflict_abstain', 'lineup_counter'];
export const CATEGORY_LABELS = {
  entity_alias: '① 实体/别名',
  skill_mechanic: '② 技能/机制语义',
  rule_version: '③ 规则与版本',
  conflict_abstain: '④ 冲突/证据不足（必须弃答）',
  lineup_counter: '⑤ 阵容/克制',
};

export const RETRIEVERS = [
  {
    id: 'baseline_searchKnowledge',
    label: '基线A：现有 searchKnowledge 原样',
    id_space: 'tactic_card',
    note: 'strategist.js 的既有卡片检索（90 张战术/参考卡），返回的是卡片 id（tactic:* / rule:skill:*）。它与 pack 的 1446 条实体键不是同一套 id 空间，所以实体/版本类指标天然为 0；这一套的价值是「既有能力能覆盖哪一类问题」。',
  },
  {
    id: 'baseline_lexical_pack',
    label: '基线B：同语料、只换词法层',
    id_space: 'rag_corpus',
    note: '在**同一份语料**上复刻 strategist 的检索配方：同一个分词器、同一个「字段加权 tf、按出现与否二值计分、无 idf、无长度归一」打分，但没有别名表、没有结构化过滤、没有 evidence/版本 rerank、也不会弃答。这一套用于把「新索引多出来的那几层」单独拎出来看。',
  },
  {
    id: 'rag_index',
    label: '新版：rag-index（别名 + 过滤 + BM25 + rerank + 弃答）',
    id_space: 'rag_corpus',
    note: 'RC-204 新增的索引层。',
  },
];

export const GATE_DEFINITIONS = {
  coverage: `五类各 ≥${CATEGORY_MIN} 条、总计 ≥${TOTAL_MIN} 条`,
  leakage: `查询不得逐字出现在语料里：单条文档最长逐字重合 ≤${LEAK_SPAN_LIMIT} 字符且不被完全包含`,
  fixture_intersection: '与 tests/evals/retrieval*.json 的查询文本归一化后交集为空',
  derivation: '每条期望值都能在语料里追到出处（ref 存在 + anchors 命中；absence 类做全语料反向扫描）',
  abstain_consistency: 'ABSTAIN 不许被算成命中：弃答的查询 hit@K 必须为 false',
  conflict_abstention: '④ 类弃答率 = 1.0',
  grounded: 'grounded precision = 1.0（每条返回结果的 provenance/证据都能追到磁盘）',
  version_hit: '新索引在版本类查询上的版本命中率 = 1.0',
  evidence_level: '每条查询声明的证据等级都在台账六级内，且答案类查询的证据等级不弱于期望',
  baselines_reported: '三套检索器（含现有实现原样）都有完整指标',
  query_manifest: '查询集清单（总数 / 分类计数 / id+文本 sha256）与声明一致；删改一条查询必须被发现',
  probe_reported: '探针集（写完后只跑一次、不回调措辞）存在且 ≥10 条，逐条给出命中与否（失败也如实登记）',
  no_clock: '报告正文不含挂钟时间戳（时间只许在 metadata 里）',
};

// ── 文本工具 ──────────────────────────────────────────────────────────────

export function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\u3000]+/g, '');
}

/**
 * 查询集清单：总数 / 分类计数 / id+文本的 sha256。
 * 这是「删一条查询」能被发现的唯一办法：闸门比的是**声明值**与**重算值**，
 * 两边都从同一份数据现算就会永远相等，删掉一条谁都看不出来。
 */
export function queryManifest(queries) {
  const ids = queries.map((query) => query.id).sort();
  const byCategory = {};
  for (const query of queries) byCategory[query.category] = (byCategory[query.category] ?? 0) + 1;
  const digest = createHash('sha256')
    .update(ids.map((id) => {
      const query = queries.find((item) => item.id === id);
      return `${id}\t${query.query}`;
    }).join('\n'))
    .digest('hex');
  return {
    total: queries.length,
    by_category: Object.fromEntries(Object.keys(byCategory).sort().map((key) => [key, byCategory[key]])),
    ids_sha256: digest,
  };
}

export function bigramsOf(text) {
  const normalized = normalizeText(text);
  const out = new Set();
  for (let i = 0; i + 1 < normalized.length; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}

/** 字符级最长公共子串长度。 */
export function longestCommonSubstring(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  if (!s || !t) return 0;
  let best = 0;
  let previous = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    const current = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j += 1) {
      if (s[i - 1] === t[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** 最长公共子串的**内容**（和长度同一次 DP，输出给报告用，方便人核对是不是真抄了）。 */
export function longestCommonSubstringText(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  if (!s || !t) return '';
  let best = 0;
  let bestEnd = 0;
  let previous = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    const current = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j += 1) {
      if (s[i - 1] === t[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) {
          best = current[j];
          bestEnd = i;
        }
      }
    }
    previous = current;
  }
  return s.slice(bestEnd - best, bestEnd);
}

// ── 语料文本（泄漏检查的比对对象） ────────────────────────────────────────

/** 索引里每条文档的完整可搜索文本。泄漏检查比的就是它。 */
export function indexTexts(index) {
  return index.documents.map((doc) => ({
    id: doc.id,
    text: [doc.fields.name, doc.fields.alias, doc.fields.body].filter(Boolean).join(' \n '),
  }));
}

// ── 判据①：泄漏 ─────────────────────────────────────────────────────────

/**
 * held-out 的核心含义：查询不能是语料里抄来的一句。
 * 两个方向都查：
 *   a) 完全包含：某条文档的文本包含整条查询 → 红；
 *   b) 最长逐字重合：与任一条文档的最长公共子串 > LEAK_SPAN_LIMIT → 红。
 * 为了不做 45×1678 次字符级 DP，(b) 先用 bigram 倒排缩小候选 ——
 * 共享长度 ≥2 的连续子串必然共享 bigram，所以这是**上界完备**的筛选，不漏。
 */
/**
 * ASCII 标识符（配置 id / status / 证据 id / 编号）在查询里必须原样出现才算结构化查找，
 * 这不算「从语料抄句子」。所以：
 *   a) 完全包含判据在**未屏蔽**的归一化文本上做（整句照抄一定红）；
 *   b) 最长逐字重合判据在**屏蔽掉 ASCII 标识符之后**的中文串上做，
 *      避免 LEGACY_BASELINE_BIT_EXACT 这种枚举值把「查询是否抄袭散文」这件事带偏。
 */
export function maskIdentifiers(text) {
  return String(text ?? '').replace(/[A-Za-z0-9_]+/g, '§');
}

export function checkLeakage(queries, texts) {
  const inverted = new Map();
  texts.forEach((entry, position) => {
    for (const gram of bigramsOf(entry.text)) {
      if (!inverted.has(gram)) inverted.set(gram, []);
      inverted.get(gram).push(position);
    }
  });
  const rows = [];
  const problems = [];
  for (const query of queries) {
    const normalized = normalizeText(query.query);
    const containedIn = [];
    const candidates = new Set();
    for (const gram of bigramsOf(normalized)) {
      for (const position of inverted.get(gram) ?? []) candidates.add(position);
    }
    let maxLcs = 0;
    let maxLcsDoc = null;
    let maxLcsText = null;
    const maskedQuery = normalizeText(maskIdentifiers(query.query));
    for (const position of candidates) {
      const entry = texts[position];
      if (entry.text.includes(query.query) || normalizeText(entry.text).includes(normalized)) containedIn.push(entry.id);
      const maskedDoc = normalizeText(maskIdentifiers(entry.text));
      const lcs = longestCommonSubstring(maskedQuery, maskedDoc);
      if (lcs > maxLcs) {
        maxLcs = lcs;
        maxLcsDoc = entry.id;
        maxLcsText = longestCommonSubstringText(maskedQuery, maskedDoc);
      }
    }
    const leak = containedIn.length > 0 || maxLcs > LEAK_SPAN_LIMIT;
    rows.push({
      id: query.id,
      query: query.query,
      query_length: normalized.length,
      contained_in: containedIn.slice(0, 5),
      max_lcs: maxLcs,
      max_lcs_doc: maxLcsDoc,
      max_lcs_text: maxLcsText,
      leak,
    });
    if (leak) {
      problems.push(`${query.id} 泄漏：contained_in=${JSON.stringify(containedIn.slice(0, 3))} max_lcs=${maxLcs}（限 ${LEAK_SPAN_LIMIT}）`);
    }
  }
  return {rows, problems, limit: LEAK_SPAN_LIMIT};
}

// ── 判据②：与既有 fixture 的交集 ─────────────────────────────────────────

export function loadFixtures({root = ROOT} = {}) {
  const out = [];
  for (const relative of RAG_INPUTS.evalFixtures) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const queries = Array.isArray(parsed) ? parsed : parsed.queries ?? [];
    for (const query of queries) out.push({fixture: relative, id: query.id, q: query.q ?? query.query});
  }
  return out;
}

export function checkFixtureIntersection(queries, fixtures) {
  const fixtureSet = new Map(fixtures.map((row) => [normalizeText(row.q), row]));
  const intersection = [];
  let maxJaccard = {value: 0, heldout: null, fixture: null};
  for (const query of queries) {
    const normalized = normalizeText(query.query);
    if (fixtureSet.has(normalized)) {
      intersection.push({heldout: query.id, fixture: fixtureSet.get(normalized).id, query: query.query});
    }
    const a = bigramsOf(normalized);
    for (const fixture of fixtures) {
      const b = bigramsOf(fixture.q);
      if (!a.size || !b.size) continue;
      let shared = 0;
      for (const gram of a) if (b.has(gram)) shared += 1;
      const jaccard = shared / (a.size + b.size - shared);
      if (jaccard > maxJaccard.value) maxJaccard = {value: Number(jaccard.toFixed(4)), heldout: query.id, fixture: fixture.id};
    }
  }
  return {
    fixture_query_count: fixtures.length,
    heldout_query_count: queries.length,
    intersection,
    max_token_jaccard: maxJaccard,
    problems: intersection.length
      ? intersection.map((row) => `${row.heldout} 与既有 fixture ${row.fixture} 逐字相同：${row.query}`)
      : [],
  };
}

// ── 判据③：期望值的出处 ─────────────────────────────────────────────────

function docSearchText(doc) {
  return [doc.id, doc.fields.name, doc.fields.alias, doc.fields.body].filter(Boolean).join(' \n ');
}

/**
 * 每条期望值必须能在语料里追到出处。
 * - ref 形如 pack:<entity_key> / ledger:<id> / ruleset:<相对路径> / owned:<instance_id> / pack:<conflict_id> / absence:<词>
 * - anchors 必须出现在被引用记录的文本里；
 * - absence:<词> 反过来：该词不许出现在**任何**文档的 name/title 里（缺席证明）。
 */
export function checkDerivation(queries, {index, corpus, root = ROOT} = {}) {
  const entityKeys = new Set(index.documents.map((doc) => doc.id));
  const ledgerIds = new Set((corpus.ledger.entries ?? []).map((entry) => entry.id));
  const conflictIds = new Set((corpus.pack.conflicts?.items ?? []).map((item) => item.conflict_id));
  const ownedIds = new Set((corpus.owned.instances ?? []).map((item) => item.instance_id));
  const rulesetFiles = new Set(corpus.rulesets.map((item) => item.file));
  const rows = [];
  const problems = [];
  for (const query of queries) {
    const derived = query.derived_from ?? {};
    const ref = String(derived.ref ?? '');
    const anchors = derived.anchors ?? [];
    const kind = derived.kind ?? '';
    const detail = {id: query.id, kind, ref, anchors, ok: true, target: null, missing_anchors: []};
    if (kind === 'pack_absence') {
      const word = ref.replace(/^absence:/, '');
      const hits = index.documents.filter((doc) => `${doc.name} ${doc.title}`.includes(word)).map((doc) => doc.id);
      detail.target = `absence:${word}`;
      detail.absence_hits = hits;
      if (hits.length) {
        detail.ok = false;
        problems.push(`${query.id} 声称语料里没有「${word}」，但命中了 ${hits.slice(0, 3).join(',')}`);
      }
    } else {
      let target = null;
      if (ref.startsWith('pack:')) {
        const key = ref.slice(5);
        if (key.startsWith('CF-')) {
          detail.ok = conflictIds.has(key) ? detail.ok : false;
          target = conflictIds.has(key) ? `conflict::${key}` : null;
        } else if (key.startsWith('conflicts.')) {
          target = key;
        } else {
          target = entityKeys.has(key) ? key : null;
        }
      } else if (ref.startsWith('ledger:')) {
        const key = ref.slice(7);
        target = ledgerIds.has(key) ? key : null;
      } else if (ref.startsWith('ruleset:')) {
        const key = ref.slice(8);
        target = rulesetFiles.has(key) ? key : null;
      } else if (ref.startsWith('owned:')) {
        const key = ref.slice(6);
        target = ownedIds.has(key) ? `owned::${key}` : null;
      }
      detail.target = target;
      if (!target) {
        detail.ok = false;
        problems.push(`${query.id} 的出处 ${ref} 在语料里不存在`);
      }
      if (target && anchors.length) {
        if (ref.startsWith('ruleset:')) {
          // 配置文件的文本不在索引里；改为在「该配置的所有文档」上找锚点。
          const docs = index.documents.filter((doc) => doc.ruleset_config_id
            && doc.id.includes(`::${target.split('/').pop().replace(/\.json$/, '').replace(/-/g, '_')}`));
          const text = docs.map(docSearchText).join(' \n ');
          const missing = anchors.filter((anchor) => !text.includes(anchor));
          detail.missing_anchors = missing;
          if (missing.length) {
            detail.ok = false;
            problems.push(`${query.id} 的锚点 ${JSON.stringify(missing)} 不在 ${ref} 的文档里`);
          }
        } else if (ref.startsWith('pack:') && ref.slice(5).startsWith('conflicts.')) {
          const doc = index.byId.get('conflict_policy::pack');
          const text = doc ? docSearchText(doc) : '';
          const missing = anchors.filter((anchor) => !text.includes(anchor));
          detail.missing_anchors = missing;
          if (missing.length) {
            detail.ok = false;
            problems.push(`${query.id} 的锚点 ${JSON.stringify(missing)} 不在冲突政策文档里`);
          }
        } else {
          const doc = index.byId.get(target);
          const text = doc ? docSearchText(doc) : '';
          const missing = anchors.filter((anchor) => !text.includes(anchor));
          detail.missing_anchors = missing;
          if (missing.length) {
            detail.ok = false;
            problems.push(`${query.id} 的锚点 ${JSON.stringify(missing)} 不在 ${target} 的文档里`);
          }
        }
      }
    }
    rows.push(detail);
  }
  return {rows, problems};
}

// ── 检索器 ───────────────────────────────────────────────────────────────

/** 预期 id 与返回 id 的匹配：根文档与它的字段段落视为同一条配置的不同粒度。 */
export function idMatches(id, key) {
  if (id === key) return true;
  return id.startsWith(`${key}#`) || key.startsWith(`${id}#`);
}

function acceptedHit(ids, keys) {
  for (let rank = 0; rank < ids.length; rank += 1) {
    for (const key of keys) if (idMatches(ids[rank], key)) return {hit: true, rank};
  }
  return {hit: false, rank: -1};
}

/** 基线A：现有 searchKnowledge 原样。 */
export function retrieveBaselineCards(query) {
  const result = searchKnowledge(query, {limit: 10, budget: 6000});
  return {ids: result.cards.map((card) => card.id), abstained: false, reason_code: null, detail: result.cards.map((card) => ({
    id: card.id, score: card.score, record_kind: 'tactic_card', evidence_level: 'COMMUNITY_CURRENT',
  }))};
}

/**
 * 基线B：同一份语料 + strategist 的分词与加权配方（按出现与否二值、无 idf、无长度归一）。
 * 它刻意**不**做别名、过滤、rerank、弃答 —— 这样差值是这几层的贡献，而不是「语料不同」。
 */
export function retrieveBaselineLexical(query, index, {limit = 10} = {}) {
  const terms = strategistTokens(query);
  const scored = index.documents.map((doc) => {
    let score = 0;
    for (const term of terms) {
      if (doc.tokens.name.includes(term)) score += 3;
      else if (doc.tokens.alias.includes(term)) score += 1;
      else if (doc.tokens.body.includes(term)) score += 1;
    }
    return {doc, score};
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, limit);
  return {
    ids: scored.map((row) => row.doc.id),
    abstained: false,
    reason_code: null,
    detail: scored.map((row) => ({
      id: row.doc.id, score: row.score, record_kind: row.doc.record_kind, evidence_level: row.doc.evidence_level,
    })),
  };
}

/** 新版：rag-index。 */
export function retrieveRagIndex(query, index) {
  const spec = typeof query === 'string' ? {query} : query;
  const result = searchIndex(index, spec.query, {
    limit: 10,
    requireLevel: spec.min_evidence_level ?? null,
    requireRulesetConfigId: spec.requires_ruleset_config_id ?? null,
  });
  return {
    ids: result.results.map((row) => row.id),
    abstained: result.abstained,
    reason_code: result.reason_code,
    reason: result.reason,
    intent: result.intent,
    detail: result.results.map((row) => ({
      id: row.id,
      score: row.score,
      record_kind: row.record_kind,
      evidence_level: row.evidence_level,
      matched_aliases: row.matched_aliases,
    })),
  };
}

// ── 评测 ─────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 *   queries  held-out 查询（可被注入改动）
 *   index    索引
 *   treatAbstainAsHit 反证用：把 ABSTAIN 也当成命中（正常评测绝不开）
 */
export function evaluateRetrieval({queries, index, treatAbstainAsHit = false} = {}) {
  const raw = {};
  for (const retriever of RETRIEVERS) raw[retriever.id] = [];
  const perQuery = [];
  for (const query of queries) {
    const answerable = query.expected !== ABSTAIN;
    const keys = [query.expected, ...(query.acceptable_entity_keys ?? [])].filter((key) => key && key !== 'ABSTAIN');
    const entry = {
      id: query.id,
      category: query.category,
      query: query.query,
      expected: query.expected,
      evidence_level_expected: query.evidence_level_expected,
      min_evidence_level: query.min_evidence_level ?? null,
      requires_ruleset_config_id: query.requires_ruleset_config_id ?? null,
      why: query.why,
      answerable,
      retrievers: {},
    };
    for (const retriever of RETRIEVERS) {
      const outcome = retriever.id === 'baseline_searchKnowledge'
        ? retrieveBaselineCards(query.query)
        : retriever.id === 'baseline_lexical_pack'
          ? retrieveBaselineLexical(query.query, index)
          : retrieveRagIndex(query, index);
      const top = outcome.ids.slice(0, 10);
      const accepted = acceptedHit(top, keys);
      const hits = {
        hit_at_1: answerable && top.slice(0, 1).some((id) => keys.some((key) => idMatches(id, key))),
        hit_at_3: answerable && top.slice(0, 3).some((id) => keys.some((key) => idMatches(id, key))),
        hit_at_10: answerable && accepted.hit,
      };
      let rr = 0;
      if (answerable && accepted.hit) rr = 1 / (accepted.rank + 1);
      const abstained = outcome.abstained === true;
      const countedAsHit = treatAbstainAsHit && abstained && !answerable;
      const versionRequired = query.requires_ruleset_config_id ?? null;
      const topId = top[0] ?? null;
      const topDoc = topId ? index.byId.get(topId) : null;
      const versionHit = versionRequired
        ? Boolean(topId && (idMatches(topId, versionRequired)
          || (topDoc && topDoc.ruleset_config_id === versionRequired)))
        : null;
      const evidenceLevelMatch = !answerable ? null
        : Boolean(topDoc && evidenceRank(topDoc.evidence_level) <= evidenceRank(query.evidence_level_expected));
      const row = {
        ids: top,
        abstained,
        reason_code: outcome.reason_code ?? null,
        reason: outcome.reason ?? null,
        intent: outcome.intent ?? null,
        hits: countedAsHit ? {hit_at_1: true, hit_at_3: true, hit_at_10: true} : hits,
        counted_as_hit_by_injection: countedAsHit,
        reciprocal_rank: countedAsHit ? 1 : rr,
        version_hit: versionHit,
        evidence_level_match: evidenceLevelMatch,
        top3: (outcome.detail ?? []).slice(0, 3),
        top_evidence_level: topDoc ? topDoc.evidence_level : null,
      };
      entry.retrievers[retriever.id] = row;
      raw[retriever.id].push({query, row});
    }
    entry.rag_index = entry.retrievers.rag_index;
    perQuery.push(entry);
  }

  const metrics = {};
  for (const retriever of RETRIEVERS) {
    const rows = raw[retriever.id];
    const answerable = rows.filter((item) => item.query.expected !== ABSTAIN);
    const abstainExpected = rows.filter((item) => item.query.expected === ABSTAIN);
    const versionRows = rows.filter((item) => item.query.requires_ruleset_config_id);
    const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    metrics[retriever.id] = {
      label: retriever.label,
      id_space: retriever.id_space,
      note: retriever.note,
      answerable_queries: answerable.length,
      abstain_expected_queries: abstainExpected.length,
      recall_at_1: mean(answerable.map((item) => (item.row.hits.hit_at_1 ? 1 : 0))),
      recall_at_3: mean(answerable.map((item) => (item.row.hits.hit_at_3 ? 1 : 0))),
      recall_at_10: mean(answerable.map((item) => (item.row.hits.hit_at_10 ? 1 : 0))),
      mrr: mean(answerable.map((item) => item.row.reciprocal_rank)),
      entity_hit_rate: mean(answerable.map((item) => (item.row.hits.hit_at_10 ? 1 : 0))),
      version_hit_rate: versionRows.length ? mean(versionRows.map((item) => (item.row.version_hit ? 1 : 0))) : null,
      version_queries: versionRows.length,
      conflict_abstention_rate: abstainExpected.length
        ? mean(abstainExpected.map((item) => (item.row.abstained ? 1 : 0))) : null,
      abstain_precision: (() => {
        const abstained = rows.filter((item) => item.row.abstained);
        if (!abstained.length) return null;
        return mean(abstained.map((item) => (item.query.expected === ABSTAIN ? 1 : 0)));
      })(),
      evidence_level_match_rate: mean(rows.filter((item) => item.row.evidence_level_match !== null)
        .map((item) => (item.row.evidence_level_match ? 1 : 0))),
      recall_by_category: Object.fromEntries(CATEGORY_ORDER.map((category) => {
        const subset = answerable.filter((item) => item.query.category === category);
        return [category, {
          n: subset.length,
          recall_at_1: mean(subset.map((item) => (item.row.hits.hit_at_1 ? 1 : 0))),
          recall_at_3: mean(subset.map((item) => (item.row.hits.hit_at_3 ? 1 : 0))),
          recall_at_10: mean(subset.map((item) => (item.row.hits.hit_at_10 ? 1 : 0))),
          mrr: mean(subset.map((item) => item.row.reciprocal_rank)),
        }];
      })),
    };
  }
  return {perQuery, metrics};
}

// ── grounded precision ───────────────────────────────────────────────────

/** 抽样 = 每条查询的 top-1（含弃答时被引用的那条候选），逐条判 provenance/证据。 */
export function groundSample({perQuery, index, root = ROOT} = {}) {
  const rows = [];
  for (const entry of perQuery) {
    const id = entry.retrievers.rag_index.ids[0];
    if (!id) continue;
    const doc = index.byId.get(id);
    if (!doc) {
      rows.push({query_id: entry.id, id, grounded: false, problems: [`索引里没有 ${id}`], checks: []});
      continue;
    }
    const verdict = groundDocument(doc, {root});
    rows.push({query_id: entry.id, id, record_kind: doc.record_kind, ...verdict});
  }
  const grounded = rows.filter((row) => row.grounded).length;
  return {
    sample_size: rows.length,
    grounded,
    grounded_precision: rows.length ? grounded / rows.length : null,
    rows,
  };
}

// ── 报告 ─────────────────────────────────────────────────────────────────

export function loadHeldout({root = ROOT} = {}) {
  return JSON.parse(readFileSync(join(root, RAG_INPUTS.heldout), 'utf8'));
}

export function computeReport({corpus = loadCorpus(), heldout = loadHeldout(), root = ROOT} = {}) {
  // 六级常量必须与台账库逐字一致；不一致就直接抛，不许悄悄各用一套。
  if (JSON.stringify([...EVIDENCE_LEVELS]) !== JSON.stringify([...CONFIDENCE_ORDER])) {
    throw new Error(`证据等级顺序与 evidence-ledger-lib 的 CONFIDENCE_ORDER 不一致：${EVIDENCE_LEVELS} vs ${CONFIDENCE_ORDER}`);
  }
  const queries = heldout.queries;
  const index = createRagIndex(corpus);
  const texts = indexTexts(index);
  const leak = checkLeakage(queries, texts);
  const fixtures = loadFixtures({root});
  const fixtureIntersection = checkFixtureIntersection(queries, fixtures);
  const derivation = checkDerivation(queries, {index, corpus, root});
  const {perQuery, metrics} = evaluateRetrieval({queries, index});
  const grounded = groundSample({perQuery, index, root});
  // 探针集：另外写的查询，只跑一次、不回调措辞。指标不过闸门，失败也登记。
  const manifestComputed = queryManifest(queries);
  const manifestDeclared = heldout.query_manifest ?? null;
  const manifestMatch = Boolean(manifestDeclared)
    && manifestDeclared.total === manifestComputed.total
    && JSON.stringify(manifestDeclared.by_category) === JSON.stringify(manifestComputed.by_category)
    && manifestDeclared.ids_sha256 === manifestComputed.ids_sha256;
  const probeQueries = heldout.probe_queries ?? [];
  const probeEvaluation = probeQueries.length
    ? evaluateRetrieval({queries: probeQueries, index})
    : {perQuery: [], metrics: {rag_index: null}};
  const probeRows = probeEvaluation.perQuery.map((entry) => ({
    id: entry.id,
    category: entry.category,
    query: entry.query,
    expected: entry.expected,
    abstained: entry.rag_index.abstained,
    reason_code: entry.rag_index.reason_code,
    hit_at_1: entry.rag_index.hits.hit_at_1,
    hit_at_10: entry.rag_index.hits.hit_at_10,
    verdict: (entry.expected === ABSTAIN)
      ? (entry.rag_index.abstained ? 'ok' : 'MISMATCH：该弃答却给了结果')
      : (entry.rag_index.hits.hit_at_1 ? 'ok' : (entry.rag_index.hits.hit_at_10 ? 'PARTIAL：top-1 未中、top-10 命中' : 'MISMATCH：top-10 都没中')),
    top3: entry.rag_index.top3,
  }));

  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => {
    const subset = queries.filter((query) => query.category === category);
    return [category, {label: CATEGORY_LABELS[category], count: subset.length, ids: subset.map((query) => query.id)}];
  }));

  // 门槛标定证据：相关候选的最低分 vs 无对应实体时最高的分。
  const answerableTop = perQuery
    .filter((entry) => entry.answerable)
    .map((entry) => entry.retrievers.rag_index.top3[0]?.score ?? 0);
  // 门槛只在**普通路径**（没有强意图把答案空间钉死）上生效，所以标定只看这些查询。
  const plainTop = perQuery
    .filter((entry) => entry.answerable && entry.retrievers.rag_index.intent?.strong !== true)
    .map((entry) => entry.retrievers.rag_index.top3[0]?.score ?? 0);
  const filteredFallback = perQuery
    .filter((entry) => entry.retrievers.rag_index.intent?.filter_fallback === true)
    .map((entry) => entry.id);
  const absenceQuery = queries.find((query) => (query.derived_from?.kind) === 'pack_absence');
  const absenceTop = absenceQuery
    ? (searchIndex(index, absenceQuery.query, {limit: 1, floor: 0}).results[0]?.score ?? 0)
    : null;

  const corpusCounts = {};
  for (const doc of index.documents) corpusCounts[doc.record_kind] = (corpusCounts[doc.record_kind] ?? 0) + 1;

  return {
    metadata: {
      report: 'rag-eval',
      schema: 'roco-rag-eval/v1',
      scope: 'RC-204 held-out 检索评测：内部一致性 + 可追溯性判据。不是端到端回答质量、不是玩家体验、不是独立盲评。',
      determinism: '报告正文不含挂钟时间戳；generated_at 单独放在 metadata 里。同输入两次运行正文逐字节相同。',
      heldout_path: RAG_INPUTS.heldout,
      report_path: RAG_INPUTS.report,
      vector_retrieval: 'NOT_IMPLEMENTED（无本地嵌入模型、不联网；接口留在 rag-index.searchIndex 的 vector 选项上）',
      score_floor: SCORE_FLOOR,
      leak_span_limit: LEAK_SPAN_LIMIT,
      evaluators: ['baseline_searchKnowledge', 'baseline_lexical_pack', 'rag_index'],
    },
    corpus: {
      documents: index.documents.length,
      by_record_kind: corpusCounts,
      ruleset_config_ids: index.ruleset_config_ids,
      unresolved_conflict_entities: [...index.unresolved.keys()].sort(),
    },
    heldout: {
      total: queries.length,
      manifest: {declared: manifestDeclared, computed: manifestComputed, match: manifestMatch},
      categories,
      leak,
      fixture_intersection: fixtureIntersection,
      derivation,
    },
    metrics,
    probe: probeQueries.length ? {
      definition: heldout.probe_definition ?? null,
      count: probeQueries.length,
      metrics: probeEvaluation.metrics.rag_index,
      failures: probeRows.filter((row) => row.verdict !== 'ok'),
      rows: probeRows,
    } : null,
    grounded,
    score_calibration: {
      floor: SCORE_FLOOR,
      path: 'SCORE_FLOOR 只作用于**普通路径**；命中强意图词（哪条台账/哪套配置/我的个体/冲突）的查询把答案空间钉死到 2～100 条文档，走 floor=0，不再设相关性门槛。',
      min_plain_answerable_top_score: plainTop.length ? Math.min(...plainTop) : null,
      min_answerable_top_score_all_paths: answerableTop.length ? Math.min(...answerableTop) : null,
      max_absence_top_score: absenceTop,
      filter_fallback_queries: filteredFallback,
      note: '门槛取在「普通路径上相关候选的最低分」与「无对应实体时最高分」之间；强意图路径的两个数字都低于门槛，是因为那条路径根本不看门槛（这是设计，不是巧合）。',
    },
    queries: perQuery,
  };
}

export function stripClock(report) {
  const clone = JSON.parse(JSON.stringify(report));
  if (clone.metadata) delete clone.metadata.generated_at;
  return clone;
}

export function canonical(report) {
  return `${JSON.stringify(stripClock(report), null, 1)}\n`;
}

// ── 判据（可被测试与 --selftest 复用） ───────────────────────────────────

export function runGates(report) {
  const checks = [];
  const push = (check, ok, detail, problems = []) => checks.push({check, ok, detail, problems});
  const metrics = report.metrics;

  const categories = report.heldout.categories;
  const short = Object.entries(categories).filter(([, value]) => value.count < CATEGORY_MIN);
  push('coverage',
    report.heldout.total >= TOTAL_MIN && short.length === 0,
    `总计 ${report.heldout.total} 条（≥${TOTAL_MIN}）；各 ${Object.entries(categories).map(([key, value]) => `${key}=${value.count}`).join(' ')}`,
    [...(report.heldout.total >= TOTAL_MIN ? [] : [`总数 ${report.heldout.total} < ${TOTAL_MIN}`]),
      ...short.map(([key, value]) => `${key} 只有 ${value.count} 条 < ${CATEGORY_MIN}`)]);

  const leaks = report.heldout.leak.rows.filter((row) => row.leak);
  push('leakage', report.heldout.leak.problems.length === 0,
    `${report.heldout.leak.rows.length} 条里最长逐字重合 = ${Math.max(...report.heldout.leak.rows.map((row) => row.max_lcs))} 字符（限 ${report.heldout.leak.limit}）`,
    report.heldout.leak.problems);

  push('fixture_intersection', report.heldout.fixture_intersection.intersection.length === 0,
    `与 ${report.heldout.fixture_intersection.fixture_query_count} 条既有 fixture 的交集 = ${report.heldout.fixture_intersection.intersection.length}；最高 token Jaccard = ${report.heldout.fixture_intersection.max_token_jaccard.value}`,
    report.heldout.fixture_intersection.problems);

  push('derivation', report.heldout.derivation.problems.length === 0,
    `${report.heldout.derivation.rows.length} 条期望值的出处在语料里逐条追到`,
    report.heldout.derivation.problems);

  const inconsistent = [];
  for (const entry of report.queries) {
    if (entry.expected === ABSTAIN && entry.rag_index.counted_as_hit_by_injection) {
      inconsistent.push(`${entry.id} 期望 ABSTAIN 却被算成命中`);
    }
    if (entry.rag_index.abstained && entry.rag_index.hits.hit_at_10 && !entry.rag_index.counted_as_hit_by_injection) {
      inconsistent.push(`${entry.id} 弃答了却记 hit@10`);
    }
  }
  push('abstain_consistency', inconsistent.length === 0,
    `弃答与命中口径一致：期望弃答 ${report.metrics.rag_index.abstain_expected_queries} 条，全部未被算成命中`,
    inconsistent);

  const abstention = metrics.rag_index.conflict_abstention_rate;
  push('conflict_abstention', abstention === 1,
    `④ 类弃答率 = ${abstention}（${metrics.rag_index.abstain_expected_queries} 条）`,
    abstention === 1 ? [] : [`弃答率 ${abstention} ≠ 1`]);

  const grounded = report.grounded.grounded_precision;
  push('grounded', grounded === 1,
    `grounded precision = ${grounded}（抽样 ${report.grounded.sample_size} 条 top-1）`,
    report.grounded.rows.filter((row) => !row.grounded).map((row) => `${row.query_id} → ${row.id}: ${row.problems.join(';')}`));

  const versionHit = metrics.rag_index.version_hit_rate;
  push('version_hit', versionHit === 1,
    `版本命中率 = ${versionHit}（${metrics.rag_index.version_queries} 条版本查询）`,
    versionHit === 1 ? [] : [`版本命中率 ${versionHit} ≠ 1`]);

  const badLevels = report.queries.filter((entry) => !EVIDENCE_LEVELS.includes(entry.evidence_level_expected));
  const levelMiss = report.queries.filter((entry) => entry.rag_index.evidence_level_match === false);
  push('evidence_level',
    badLevels.length === 0 && levelMiss.length === 0,
    `等级声明全部在六级内；等级不弱于期望的比例 = ${metrics.rag_index.evidence_level_match_rate}`,
    [...badLevels.map((entry) => `${entry.id} 等级 ${entry.evidence_level_expected} 不在六级内`),
      ...levelMiss.map((entry) => `${entry.id} top-1 等级 ${entry.rag_index.top_evidence_level} 弱于期望 ${entry.evidence_level_expected}`)]);

  const missing = ['baseline_searchKnowledge', 'baseline_lexical_pack', 'rag_index']
    .filter((id) => !metrics[id] || metrics[id].recall_at_10 === null);
  push('baselines_reported', missing.length === 0,
    `三套检索器都有指标：${Object.keys(metrics).join(', ')}`,
    missing.map((id) => `${id} 缺指标`));

  const manifest = report.heldout.manifest;
  push('query_manifest', manifest.match,
    manifest.match
      ? `清单一致：${manifest.computed.total} 条，sha256=${manifest.computed.ids_sha256.slice(0, 12)}…`
      : `清单不一致：声明 ${manifest.declared ? `${manifest.declared.total} 条/${JSON.stringify(manifest.declared.by_category)}` : '（缺）'}，重算 ${manifest.computed.total} 条/${JSON.stringify(manifest.computed.by_category)}`,
    manifest.match ? [] : ['查询集清单与声明不一致（增删改查询必须同步更新 query_manifest）']);

  const probe = report.probe;
  push('probe_reported', Boolean(probe) && probe.count >= 10 && probe.rows.length === probe.count,
    probe ? `探针 ${probe.count} 条；未按预期 ${probe.failures.length} 条（失败也登记，不过闸门）` : '缺探针集',
    probe ? [] : ['探针集不存在或条数不足']);

  const clock = /"generated_at"\s*:/.test(JSON.stringify(stripClock(report)));
  push('no_clock', !clock, '正文（除 metadata.generated_at）不含挂钟时间戳', clock ? ['正文里出现了 generated_at'] : []);

  return {ok: checks.every((check) => check.ok), checks, problems: checks.flatMap((check) => check.problems)};
}

// ── 必红反证（注入自检） ─────────────────────────────────────────────────

export function selftest() {
  const corpus = loadCorpus();
  const heldout = loadHeldout();
  const index = createRagIndex(corpus);
  const base = computeReport({corpus, heldout});
  const baseGates = runGates(base);
  const cases = [];
  const add = (id, name, ok, detail) => cases.push({id, name, expected_red: true, ok, detail});

  // ① 把某条查询的 expected 改成错实体 ⇒ 该条判错、指标下降
  const hitQuery = base.queries.find((entry) => entry.rag_index.hits.hit_at_1
    && entry.retrievers.rag_index.ids.length >= 1);
  const victim = hitQuery.id;
  const victimSpec = heldout.queries.find((query) => query.id === victim);
  const victimKeys = [victimSpec.expected, ...(victimSpec.acceptable_entity_keys ?? [])];
  const victimTop10 = new Set(hitQuery.retrievers.rag_index.ids);
  // 挑一条**既不在该条 top-10、也不属于它的可接受键**的文档当错答案。
  const wrongKey = index.documents
    .map((doc) => doc.id)
    .filter((id) => !victimTop10.has(id) && !victimKeys.some((key) => idMatches(id, key)))
    .sort()[0];
  const mutatedQueries = heldout.queries.map((query) => (query.id === victim
    ? {...query, expected: wrongKey, acceptable_entity_keys: [wrongKey]} : query));
  const mutated = evaluateRetrieval({queries: mutatedQueries, index});
  const mutatedEntry = mutated.perQuery.find((entry) => entry.id === victim);
  const recallDropped = mutated.metrics.rag_index.recall_at_1 < base.metrics.rag_index.recall_at_1;
  add('R1', `把 ${victim} 的 expected 改成 ${wrongKey}`,
    mutatedEntry.rag_index.hits.hit_at_1 === false && recallDropped,
    `该条 hit@1=${mutatedEntry.rag_index.hits.hit_at_1}（原 ${hitQuery.rag_index.hits.hit_at_1}）；Recall@1 ${base.metrics.rag_index.recall_at_1} → ${mutated.metrics.rag_index.recall_at_1}`);

  // ② 删掉一条 ④ 类查询 ⇒ 覆盖判据红、弃答分母变化
  const conflictQuery = heldout.queries.find((query) => query.category === 'conflict_abstain');
  const dropped = computeReport({
    corpus,
    heldout: {...heldout, queries: heldout.queries.filter((query) => query.id !== conflictQuery.id)},
  });
  const droppedGates = runGates(dropped);
  const manifestRed = droppedGates.checks.find((check) => check.check === 'query_manifest').ok === false;
  add('R2', `删掉 ④ 类查询 ${conflictQuery.id}`,
    manifestRed && dropped.metrics.rag_index.abstain_expected_queries === base.metrics.rag_index.abstain_expected_queries - 1,
    `清单判据=${manifestRed ? '红' : '绿'}（声明 ${base.heldout.manifest.declared?.total} 条 → 实际 ${dropped.heldout.manifest.computed.total} 条）；弃答分母 ${base.metrics.rag_index.abstain_expected_queries} → ${dropped.metrics.rag_index.abstain_expected_queries}`);

  // ③ 抹掉某条结果的 provenance ⇒ grounded precision 下降
  const groundedVictim = (() => {
    for (const entry of base.queries) {
      const id = entry.rag_index.ids[0];
      const doc = id ? index.byId.get(id) : null;
      if (doc && doc.record_kind === 'pet_form') return id;
    }
    return base.grounded.rows[0].id;
  })();
  const mutatedCorpus = JSON.parse(JSON.stringify(corpus));
  let erased = 0;
  for (const section of ['distributable', 'reference_only']) {
    for (const entity of mutatedCorpus.pack.sections?.[section]?.entities ?? []) {
      if (entity.entity_key === groundedVictim) {
        entity.provenance = [];
        erased += 1;
      }
    }
  }
  const erasedReport = computeReport({corpus: mutatedCorpus, heldout});
  const erasedGates = runGates(erasedReport);
  add('R3', `抹掉 ${groundedVictim} 的 provenance`,
    erased > 0 && erasedReport.grounded.grounded_precision < 1
      && erasedGates.checks.find((check) => check.check === 'grounded').ok === false,
    `grounded precision ${base.grounded.grounded_precision} → ${erasedReport.grounded.grounded_precision}；grounded 判据=${erasedGates.checks.find((c) => c.check === 'grounded').ok ? '绿' : '红'}`);

  // ④ 让 runner 把 ABSTAIN 算成命中 ⇒ 口径判据红
  const cheat = evaluateRetrieval({queries: heldout.queries, index, treatAbstainAsHit: true});
  const cheatReport = {...base, queries: cheat.perQuery, metrics: cheat.metrics};
  const cheatGates = runGates(cheatReport);
  add('R4', '把 ABSTAIN 也算成命中',
    cheatGates.checks.find((check) => check.check === 'abstain_consistency').ok === false,
    `abstain_consistency 判据=${cheatGates.checks.find((c) => c.check === 'abstain_consistency').ok ? '绿' : '红'}；问题=${cheatGates.checks.find((c) => c.check === 'abstain_consistency').problems.length} 条`);

  // ⑤ 把一条 query 原文塞进语料 ⇒ 泄漏判据红
  const leakTexts = [...indexTexts(index), {id: 'injected::leak', text: heldout.queries[0].query}];
  const leakCheck = checkLeakage(heldout.queries, leakTexts);
  add('R5', `把 ${heldout.queries[0].id} 的查询原文塞进语料`,
    leakCheck.problems.length > 0 && leakCheck.rows.find((row) => row.id === heldout.queries[0].id).leak === true,
    `泄漏条数=${leakCheck.problems.length}；${leakCheck.problems[0] ?? '（无）'}`);

  // ⑥ held-out 与既有 fixture 的交集非空 ⇒ 红
  const fixtures = loadFixtures();
  const injectedFixtures = [...fixtures, {fixture: 'injected', id: 'injected', q: heldout.queries[1].query}];
  const intersection = checkFixtureIntersection(heldout.queries, injectedFixtures);
  add('R6', `把既有 fixture 条目换成 ${heldout.queries[1].id} 的查询`,
    intersection.intersection.length === 1 && intersection.problems.length === 1,
    `交集=${intersection.intersection.length}：${intersection.problems[0] ?? '（无）'}`);

  return {
    ok: cases.every((row) => row.ok) && baseGates.ok,
    base_ok: baseGates.ok,
    cases,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function formatTable(report) {
  const lines = [];
  const pad = (text, width) => String(text).padEnd(width, ' ');
  const num = (value) => (value === null || value === undefined ? ' n/a ' : value.toFixed(3));
  lines.push('| 检索器 | Recall@1 | Recall@3 | Recall@10 | MRR | 实体命中 | 版本命中 | 冲突弃答 | 弃答精确率 | 等级匹配 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const retriever of RETRIEVERS) {
    const m = report.metrics[retriever.id];
    lines.push(`| ${retriever.label} | ${num(m.recall_at_1)} | ${num(m.recall_at_3)} | ${num(m.recall_at_10)} | ${num(m.mrr)} | ${num(m.entity_hit_rate)} | ${num(m.version_hit_rate)} | ${num(m.conflict_abstention_rate)} | ${num(m.abstain_precision)} | ${num(m.evidence_level_match_rate)} |`);
  }
  lines.push('');
  lines.push('分类 Recall@10 / MRR：');
  for (const category of CATEGORY_ORDER) {
    const cells = RETRIEVERS.map((retriever) => {
      const row = report.metrics[retriever.id].recall_by_category[category];
      return `${retriever.id}: n=${row.n} R@10=${num(row.recall_at_10)} MRR=${num(row.mrr)}`;
    });
    lines.push(`  ${CATEGORY_LABELS[category]} → ${cells.join(' | ')}`);
  }
  lines.push('');
  lines.push(`grounded precision = ${report.grounded.grounded_precision}（抽样 ${report.grounded.sample_size} 条）`);
  lines.push(`门槛标定：相关候选最低分 = ${report.score_calibration.min_answerable_top_score}；无对应实体时最高分 = ${report.score_calibration.max_absence_top_score}；门槛 = ${report.score_calibration.floor}`);
  lines.push(`泄漏：最长逐字重合 = ${Math.max(...report.heldout.leak.rows.map((row) => row.max_lcs))} 字符（限 ${report.heldout.leak.limit}）；与既有 fixture 交集 = ${report.heldout.fixture_intersection.intersection.length}`);
  lines.push('');
  lines.push('逐条明细（rag_index top-3 / 命中 / 弃答原因）：');
  for (const entry of report.queries) {
    const row = entry.rag_index;
    const top = row.top3.map((item, index) => `${index + 1}.${item.id}(${item.score})`).join(' ') || '（无结果）';
    const flag = row.abstained ? `ABSTAIN:${row.reason_code}` : (row.hits.hit_at_1 ? 'HIT@1' : row.hits.hit_at_3 ? 'HIT@3' : row.hits.hit_at_10 ? 'HIT@10' : 'MISS');
    lines.push(`  [${flag}] ${entry.id} ${entry.query} → ${top}`);
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const baseline = argv.includes('--baseline');
  const wantSelftest = argv.includes('--selftest');
  const refreshManifest = argv.includes('--refresh-manifest');

  if (refreshManifest) {
    const heldout = loadHeldout();
    const manifest = queryManifest(heldout.queries);
    const updated = {...heldout, query_manifest: manifest};
    writeFileSync(HELDOUT_PATH, `${JSON.stringify(updated, null, 2)}\n`);
    process.stdout.write(`[rag-eval] --refresh-manifest：已写入 ${RAG_INPUTS.heldout}，共 ${manifest.total} 条，sha256=${manifest.ids_sha256}\n`);
    return 0;
  }

  if (wantSelftest) {
    const result = selftest();
    for (const item of result.cases) {
      process.stdout.write(`[selftest] ${item.ok ? 'ok  ' : 'FAIL'} ${item.id} ${item.name} → ${item.detail}\n`);
    }
    process.stdout.write(`[selftest] 真产物判据=${result.base_ok ? '绿' : '红'}；注入反证 ${result.cases.filter((row) => row.ok).length}/${result.cases.length} 条按预期翻红\n`);
    return result.ok ? 0 : 1;
  }

  const report = computeReport();
  const gates = runGates(report);

  if (check) {
    if (!existsSync(REPORT_PATH)) {
      process.stderr.write(`[rag-eval] --check 失败：磁盘上没有 ${RAG_INPUTS.report}\n`);
      return 1;
    }
    const onDisk = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
    const same = canonical(onDisk) === canonical(report);
    process.stdout.write(`[rag-eval] --check ${same ? 'ok' : 'FAIL'}：磁盘报告与重算${same ? '逐字节相同' : '不一致'}\n`);
    if (!same) {
      for (const retriever of RETRIEVERS) {
        process.stdout.write(`  ${retriever.id} Recall@10 磁盘=${onDisk.metrics?.[retriever.id]?.recall_at_10} 重算=${report.metrics[retriever.id].recall_at_10}\n`);
      }
    }
    return same && gates.ok ? 0 : 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({...report, metadata: {...report.metadata, generated_at: new Date().toISOString()}}, null, 1)}\n`);
    return gates.ok ? 0 : 1;
  }

  if (baseline) {
    process.stdout.write(`${formatTable(report)}\n`);
    process.stdout.write(`[rag-eval] --baseline：只打印对照表，未写报告；判据${gates.ok ? '全部通过' : '有失败项'}\n`);
    return gates.ok ? 0 : 1;
  }

  const artifact = {...report, metadata: {...report.metadata, generated_at: new Date().toISOString()}};
  mkdirSync(dirname(REPORT_PATH), {recursive: true});
  writeFileSync(REPORT_PATH, `${JSON.stringify(artifact, null, 1)}\n`);
  process.stdout.write(`${formatTable(report)}\n\n`);
  for (const checkRow of gates.checks) {
    process.stdout.write(`[rag-eval] ${checkRow.ok ? 'ok  ' : 'FAIL'} ${checkRow.check}: ${checkRow.detail}\n`);
  }
  process.stdout.write(`[rag-eval] 判据 ${gates.checks.filter((row) => row.ok).length}/${gates.checks.length} 通过；报告写入 ${RAG_INPUTS.report}\n`);
  return gates.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[rag-eval] 运行失败：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  }
}
