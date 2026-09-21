#!/usr/bin/env node
// RC-201：把**冻结目录**与**公网快照**对账，产出四个桶 + 逐条证据 + 口径说明。
//
// 背景：两边的数字不一样，而且不是随便不一样——
//
//   冻结目录 data/roco/normalized/roco-world-s4-2026-09-10/
//     full-catalog.json  622 条精灵记录
//     skills.json        824 条技能记录（其中 245 条 category=特性，579 条是战斗技能）
//   公网快照 data/roco/live/<date>/public-index.json（BWIKI 三张索引页）
//     精灵图鉴 621 张卡 / 技能图鉴 579 张卡 / 特性图鉴 242 张卡
//
// 这个脚本的职责不是「把两边凑成一样」，而是：
//   ① 逐条给出 id / 名字（**不许只给总数**）；
//   ② 每条带 `record_kind` 与 `source_scope`，让「824 里有 245 条不是技能」这种口径差
//      一眼可见；
//   ③ 每个计数差都必须有**非空解释**；解释是从四个桶里**推出来的**，不是硬编码的标语。
//      ——推不出来（桶是空的但数字对不上）时 `reconciled` 必须是 false，
//      而不是发一句「已对账」蒙过去。
//
// 身份（identity）纪律
// -------------------
// 实体身份 = **(比较组, id)**，**不是名字**。冻结快照里有 3 组同名不同 id 的技能记录
// （腾挪/保卫/好象坏象 各两条，game_id 200236 vs 200281 这一类），
// 按名字对齐会把两条不同的记录悄悄并成一条。所以：
//   - `normalizeName()` 只抹掉**编码/排版**层面的差异（HTML 实体、全角半角、空白、零宽字符）；
//   - 它**不**剥掉后缀，因此「幽影树」与「幽影树（突变的样子）」永远是两个不同的名字；
//   - 对齐只走 id，名字只用来判 `changed`。
//
// 跑法
// ----
//   node scripts/roco/reconcile-catalog.mjs
//   node scripts/roco/reconcile-catalog.mjs --live data/roco/live/2026-09-21/public-index.json
//   node scripts/roco/reconcile-catalog.mjs --out reports/roco/reconciliation/catalog-reconciliation.json
//   node scripts/roco/reconcile-catalog.mjs --json     # 额外把报告打到 stdout
//
// 退出码：0=已对账（reconciled=true）；2=未对账（reconciled=false，报告照常产出）；3=运行异常

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

export const RECONCILER_VERSION = 'rc201-catalog-reconciler/1';
export const FROZEN_DIR = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');
export const LIVE_ROOT = join(ROOT, 'data', 'roco', 'live');
export const REPORT_PATH = join(ROOT, 'reports', 'roco', 'reconciliation', 'catalog-reconciliation.json');

/**
 * 比较组：**跨来源可比**的最小分类。
 * `record_kind` 是描述性的（两侧各自的索引给法不同），对账必须挂在这个组上，
 * 否则「冻结侧叫 pet_form、公网侧叫 pet_record」会让同一条实体会被算成两边的差集。
 */
export const COMPARISON_GROUPS = ['pet', 'battle_skill', 'trait'];

/** 公网页面的 key → 比较组。写成一个函数，避免三处各抄一遍映射。 */
export function comparisonGroupOfPageKey(key) {
  if (key === 'pet-index') return 'pet';
  if (key === 'skill-index') return 'battle_skill';
  if (key === 'trait-index') return 'trait';
  return null;
}

export const RECORD_KIND_VOCABULARY = {
  pet_record: '精灵图鉴条目（基础形态）',
  pet_form: '精灵的形态/分支记录（首领形态、地区形态、突变的样子……）',
  battle_skill: '战斗技能（攻击/防御/状态）',
  trait_record: '特性（技能的 category=特性）',
  skill_record: '**未在逐条产物里使用**。它是 `skills.json` 的**文件级**总称，'
    + '= battle_skill + trait_record（824 = 579 + 245），只在计数表里以 `frozen_skills_file_records` 出现。'
    + '之所以不拿它当逐条的 record_kind：逐条时它什么也没说清，还会和上面两个值重叠。',
};

// ── 名字归一化 ────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, '\u00a0');
}

/**
 * 比较用归一。**只**处理编码/排版差异：
 *   - HTML 实体解码（`&amp;` → `&`、`&nbsp;` → 空格）
 *   - NFKC（全角/半角、兼容字符；注意它**保留**括号后缀，不会把「（突变的样子）」吃掉）
 *   - 删除所有空白（含全角空格）与零宽字符
 *
 * 明确**不**做的事：不剥后缀、不去括号、不截断、不做拼音/繁简映射。
 * 这些都会把两个不同形态并成一个——那是造假，不是归一化。
 */
export function normalizeName(raw) {
  if (raw === null || raw === undefined) return null;
  let s = decodeEntities(raw);
  s = s.normalize('NFKC');
  s = s.replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  s = s.replace(/[\s\u3000]+/g, '');
  return s;
}

/**
 * **反例**：一个会把不同形态并起来的「坏归一化」。
 * 只用于测试证明「必红方向」——生产路径**绝不**调用它。
 */
export function badNormalizeNameStrippingFormSuffix(raw) {
  const base = normalizeName(raw);
  if (base === null) return null;
  return base.replace(/[（(][^（()）]*[)）]$/u, '');
}

/** 实体身份键：比较组 + id。名字不参与。 */
export function entityKey(group, id) {
  return `${group}::${id}`;
}

/** **反例**：按名字对齐的身份键。会抹掉「同名不同 id」的区分。 */
export function badEntityKeyByName(group, name) {
  return `${group}::name::${normalizeName(name)}`;
}

// ── 冻结侧 ────────────────────────────────────────────────────────────────

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 冻结目录 → 逐条记录。
 *
 * record_kind 规则（冻结侧口径，写进报告）：
 *   - full-catalog 的 pet：`title !== name` ⇒ 该记录的 title 带形态后缀（「XX（……的样子）」）
 *     ⇒ `pet_form`；否则 `pet_record`。实测 622 条里 162 条 `title !== name`，
 *     且这 162 条的 title 全部以「（」结尾的括号后缀收尾（0 例外）。
 *   - skills.json 的 skill：`category === '特性'` ⇒ `trait_record`；否则 `battle_skill`。
 */
export function buildFrozenRecords({catalog, skills, catalogPath, skillsPath}) {
  const records = [];
  const catalogRel = relative(ROOT, catalogPath);
  const skillsRel = relative(ROOT, skillsPath);

  catalog.pets.forEach((p, index) => {
    const isForm = p.title !== p.name;
    records.push({
      record_kind: isForm ? 'pet_form' : 'pet_record',
      group: 'pet',
      id: p.pet_id,
      name: p.name,
      title: p.title,
      normalized_name: normalizeName(p.name),
      normalized_title: normalizeName(p.title),
      source_scope: 'frozen_l1',
      attributes: {
        number: p.number === undefined ? null : String(p.number),
        game_id: p.game_id === undefined ? null : p.game_id,
        stage: p.stage === undefined ? null : p.stage,
        types: Array.isArray(p.types) ? p.types : null,
        class: p.class === undefined ? null : p.class,
        form_marker: isForm ? 'frozen:title!=name' : 'frozen:title==name',
      },
      evidence: {
        source_scope: 'frozen_l1',
        kind: 'file',
        file: catalogRel,
        pointer: `pets[${index}]`,
        id_field: 'pet_id',
      },
    });
  });

  for (const [id, s] of Object.entries(skills.skills)) {
    const isTrait = s.category === '特性' || s.is_trait === true;
    records.push({
      record_kind: isTrait ? 'trait_record' : 'battle_skill',
      group: isTrait ? 'trait' : 'battle_skill',
      id,
      name: s.name,
      normalized_name: normalizeName(s.name),
      source_scope: 'frozen_l1',
      attributes: {
        game_id: s.game_id === undefined ? null : s.game_id,
        category: s.category === undefined ? null : s.category,
        element: s.element === undefined ? null : s.element,
        energy: s.energy === undefined ? null : s.energy,
        damage_class: s.damage_class === undefined ? null : s.damage_class,
        power: s.power === undefined ? null : s.power,
        is_trait: isTrait,
      },
      evidence: {
        source_scope: 'frozen_l1',
        kind: 'file',
        file: skillsRel,
        pointer: `skills.${id}`,
        id_field: 'skill_id',
      },
    });
  }

  return records;
}

// ── 公网侧 ────────────────────────────────────────────────────────────────

/**
 * 公网快照 → 逐条记录。
 *
 * record_kind 规则（公网侧口径，写进报告）：
 *   - 精灵：页面用 `data-form` 标形态（main / lord / regional / main|regional / lord|regional）。
 *     `data-form === 'main'` ⇒ `pet_record`；其余 ⇒ `pet_form`。
 *   - 技能图鉴卡 ⇒ `battle_skill`；特性图鉴卡 ⇒ `trait_record`。
 *
 * 注意两侧的形态口径**不完全一致**（实测：161 条两边都算形态，426 条两边都算基础，
 * 34 条只有公网侧把 `data-form` 标成非 main）。这个差异写进 `convention_notes`，
 * **不**计入 changed——因为名字、编号、属性全都一致，差的只是「谁算形态」的标注习惯。
 */
export function buildLiveRecords(snapshot) {
  const records = [];
  const pages = (snapshot.result && snapshot.result.pages) || [];
  const htmlSha = {};
  for (const [key, meta] of Object.entries((snapshot.metadata && snapshot.metadata.pages) || {})) {
    htmlSha[key] = meta.sha256 || null;
  }

  for (const page of pages) {
    const group = page.key === 'pet-index' ? 'pet'
      : page.key === 'skill-index' ? 'battle_skill'
        : 'trait';
    page.entities.forEach((e, index) => {
      const isForm = page.key === 'pet-index'
        ? Boolean(e.form) && e.form !== 'main'
        : false;
      records.push({
        record_kind: page.key === 'pet-index'
          ? (isForm ? 'pet_form' : 'pet_record')
          : (page.key === 'skill-index' ? 'battle_skill' : 'trait_record'),
        group,
        id: e.id,
        name: e.name,
        normalized_name: normalizeName(e.name),
        source_scope: 'live_bwiki',
        attributes: {
          number: e.number === undefined ? null : e.number,
          stage: e.stage === undefined ? null : e.stage,
          form: e.form === undefined ? null : e.form,
          season: e.season === undefined ? null : e.season,
          type: e.type === undefined ? null : e.type,
          element: e.element === undefined ? null : e.element,
          category: e.category === undefined ? null : e.category,
          tags: e.tags === undefined ? null : e.tags,
          form_marker: page.key === 'pet-index'
            ? `live:data-form=${e.form}`
            : null,
        },
        evidence: {
          source_scope: 'live_bwiki',
          kind: 'web_page',
          page: page.key,
          page_label: page.label,
          url: page.url,
          html_sha256: htmlSha[page.key] || null,
          selector: page.key === 'pet-index'
            ? `div.npc-card[data-id="${e.id}"]`
            : `div.nrc-skill-catalog-card[data-skill-catalog-id="${e.id}"]`,
          index,
        },
      });
    });
  }

  return records;
}

// ── 对账 ──────────────────────────────────────────────────────────────────

/** 冻结侧的「形态标注」与公网侧不一致的 id（只标注，不进 changed）。 */
function formConventionDivergence(frozenRecs, liveRecs) {
  const f = new Map(frozenRecs.filter((r) => r.group === 'pet').map((r) => [r.id, r]));
  const l = new Map(liveRecs.filter((r) => r.group === 'pet').map((r) => [r.id, r]));
  const out = [];
  for (const [id, fr] of f) {
    const lr = l.get(id);
    if (!lr) continue;
    const ff = fr.record_kind === 'pet_form';
    const lf = lr.record_kind === 'pet_form';
    if (ff !== lf) {
      out.push({
        id,
        name: fr.name,
        frozen_kind: fr.record_kind,
        live_kind: lr.record_kind,
        note: '两侧对「这条算不算形态」的标注不同；名字/编号/属性一致，因此不算 changed。',
      });
    }
  }
  return out;
}

/**
 * 核心对账。
 *
 * 判据链：
 *   1. **身份 = (比较组, id)**。名字只用来判 `changed`，从不参与对齐。
 *   2. 某个比较组的公网页不是 `ok` ⇒ 该组**整体跳过**逐条比对，改记一条
 *      `unresolved`（写明是哪张页、什么状态、原因），该组 `delta = null`、`live_count = null`。
 *      ——fail closed：页面被拦时绝不把「抽不到」写成「冻结侧多出 245 条」。
 *   3. 计数差走的是**各自声明的计数**（冻结侧读文件里的 `coverage.pets_total` /
 *      `counts.total` / `counts.traits`；公网侧读页面自己渲染的「N 个结果」），
 *      **不是**从记录数组长度反推。这样 delta 才可能和桶对不上，判据才有牙齿。
 *   4. 解释是从桶里**推出来并核对过**的：
 *        delta == only_in_frozen - only_in_live  ⇒ 解释非空；
 *        不等 ⇒ 解释留空、`unexplained_gap` 写明差在哪、`reconciled` 必须 false。
 *      「数字对不上但解释不写」这条路被堵死。
 *
 * @param {object} input
 * @param {Array} input.frozenRecords    冻结侧逐条记录
 * @param {Array} input.liveRecords      公网侧逐条记录
 * @param {object} input.declaredCounts  两侧**声明**的计数：
 *        `{frozen: {pet, battle_skill, trait, skills_file}, live: {pet, battle_skill, trait}}`
 *        （公网侧某组不可比时对应值为 null，表示「不知道」，不是 0）
 * @param {object} input.parsedCounts    两侧**实际解析出来**的条数（用于声明 vs 解析的交叉核对）
 * @param {Array} input.livePages        公网快照的三页结果（含 status/reason）
 * @param {object} input.evidence        输入文件/快照的来源信息
 */
export function reconcile({
  frozenRecords,
  liveRecords,
  declaredCounts,
  parsedCounts = null,
  livePages,
  evidence = {},
}) {
  const onlyInFrozen = [];
  const onlyInLive = [];
  const changed = [];
  const unresolved = [];
  const nameCollisions = [];

  const pages = Array.isArray(livePages) ? livePages : [];
  const groupOfPage = (key) => (key === 'pet-index' ? 'pet'
    : key === 'skill-index' ? 'battle_skill'
      : 'trait');
  const pageKeyOfGroup = {pet: 'pet-index', battle_skill: 'skill-index', trait: 'trait-index'};
  const pageByGroup = {};
  for (const p of pages) pageByGroup[groupOfPage(p.key)] = p;

  // 某组是否可比：必须有对应页面，且该页面 status === 'ok'。
  const groupBlocked = {};
  for (const g of COMPARISON_GROUPS) {
    const p = pageByGroup[g];
    if (!p) groupBlocked[g] = {status: 'missing', reason: '公网快照里没有这张页面的结果。', page: null};
    else if (p.status !== 'ok') groupBlocked[g] = {status: p.status, reason: p.reason || '未给出原因。', page: p};
    else groupBlocked[g] = null;
  }
  const comparable = (group) => !groupBlocked[group];

  // ── 身份索引 + 重复 id 检测 ──────────────────────────────────────────
  const frozenById = new Map();
  const liveById = new Map();

  for (const r of frozenRecords) {
    const key = entityKey(r.group, r.id);
    if (frozenById.has(key)) {
      unresolved.push({
        record_kind: r.record_kind,
        group: r.group,
        id: r.id,
        name: r.name,
        source_scope: 'frozen_l1',
        reason: `冻结侧同一 (比较组,id) 出现多次：${key}。按 id 对齐会把它们并成一条，必须先修数据。`,
        evidence: r.evidence,
      });
    } else {
      frozenById.set(key, r);
    }
  }
  for (const r of liveRecords) {
    const key = entityKey(r.group, r.id);
    if (liveById.has(key)) {
      unresolved.push({
        record_kind: r.record_kind,
        group: r.group,
        id: r.id,
        name: r.name,
        source_scope: 'live_bwiki',
        reason: `公网侧同一 (比较组,id) 出现多次：${key}。同一张页渲染出两张同 id 的卡。`,
        evidence: r.evidence,
      });
    } else {
      liveById.set(key, r);
    }
  }

  // ── 声明计数 vs 解析条数（不一致本身就是 unresolved） ────────────────
  const countMismatches = [];
  if (parsedCounts) {
    for (const g of COMPARISON_GROUPS) {
      const declared = declaredCounts.frozen[g];
      const parsed = parsedCounts.frozen[g];
      if (declared !== null && declared !== undefined && declared !== parsed) {
        countMismatches.push({side: 'frozen_l1', group: g, declared, parsed});
      }
    }
    for (const g of COMPARISON_GROUPS) {
      if (!comparable(g)) continue;
      const declared = declaredCounts.live[g];
      const parsed = parsedCounts.live[g];
      if (declared !== null && declared !== undefined && declared !== parsed) {
        countMismatches.push({side: 'live_bwiki', group: g, declared, parsed});
      }
    }
    for (const m of countMismatches) {
      unresolved.push({
        record_kind: m.group === 'pet' ? 'pet_record' : m.group === 'trait' ? 'trait_record' : 'battle_skill',
        group: m.group,
        id: null,
        name: null,
        source_scope: m.side,
        reason: `${m.side} 的 ${m.group} 组：产物**声明** ${m.declared} 条，但实际解析出 ${m.parsed} 条。`
          + '声明与解析不一致时不允许拿其中任何一个当结论。',
        evidence: m.side === 'frozen_l1' ? evidence.frozen : {source_scope: 'live_bwiki', kind: 'web_page'},
      });
    }
  }

  // ── 被拦/缺失页面：整组跳过，记一条 unresolved ───────────────────────
  for (const g of COMPARISON_GROUPS) {
    const blocked = groupBlocked[g];
    if (!blocked) continue;
    const frozenCount = frozenRecords.filter((r) => r.group === g).length;
    unresolved.push({
      record_kind: g === 'pet' ? 'pet_record' : g === 'trait' ? 'trait_record' : 'battle_skill',
      group: g,
      id: null,
      name: null,
      source_scope: 'live_bwiki',
      reason: `公网页面 ${pageKeyOfGroup[g]} 状态为 ${blocked.status}（${blocked.reason}）。`
        + `该组冻结侧有 ${frozenCount} 条记录，但公网侧这一组**没有可用的抽取结果**，`
        + '因此整组不做逐条比对，也**不**把这 ' + frozenCount + ' 条记进 only_in_frozen——'
        + '「抓不到」不等于「公网没有」。',
      evidence: blocked.page
        ? {
          source_scope: 'live_bwiki',
          kind: 'web_page',
          page: blocked.page.key,
          url: blocked.page.url,
          status: blocked.page.status,
          reason: blocked.page.reason,
          raw_evidence: blocked.page.evidence || null,
        }
        : {source_scope: 'live_bwiki', kind: 'web_page', page: pageKeyOfGroup[g], status: 'missing'},
    });
  }

  // ── 冻结有、公网没有 ────────────────────────────────────────────────
  const liveByGroupAndName = new Map();
  for (const r of liveById.values()) {
    const k = `${r.group}::${r.normalized_name}`;
    if (!liveByGroupAndName.has(k)) liveByGroupAndName.set(k, []);
    liveByGroupAndName.get(k).push(r);
  }

  for (const [key, r] of frozenById) {
    if (!comparable(r.group)) continue;
    if (liveById.has(key)) continue;
    const twins = liveByGroupAndName.get(`${r.group}::${r.normalized_name}`) || [];
    const entry = {
      record_kind: r.record_kind,
      group: r.group,
      id: r.id,
      name: r.name,
      title: r.title === undefined ? null : r.title,
      source_scope: r.source_scope,
      attributes: r.attributes,
      evidence: r.evidence,
    };
    if (twins.length > 0) {
      entry.same_name_entity_in_live = twins.map((t) => ({id: t.id, name: t.name, record_kind: t.record_kind}));
      unresolved.push({
        record_kind: r.record_kind,
        group: r.group,
        id: r.id,
        name: r.name,
        source_scope: 'frozen_l1',
        ambiguity: 'same_name_different_id',
        counterpart_ids: twins.map((t) => t.id),
        reason: `公网侧存在**同名但 id 不同**的实体（${twins.map((t) => t.id).join(', ')}），`
          + `因此无法完全排除「公网把 ${r.id} 并进了那条」的可能。`
          + '本报告按 id 严格判定，把它记在 only_in_frozen，同时把这份不确定性显式留在这里；'
          + '冻结侧本身就有 3 组同名不同 id 的技能记录（腾挪/保卫/好象坏象），所以「同名」不足以当身份。',
        evidence: [r.evidence, ...twins.map((t) => t.evidence)],
      });
    }
    onlyInFrozen.push(entry);
  }

  // ── 公网有、冻结没有 ────────────────────────────────────────────────
  for (const [key, r] of liveById) {
    if (!comparable(r.group)) continue;
    if (frozenById.has(key)) continue;
    onlyInLive.push({
      record_kind: r.record_kind,
      group: r.group,
      id: r.id,
      name: r.name,
      source_scope: r.source_scope,
      attributes: r.attributes,
      evidence: r.evidence,
    });
  }

  // ── 同名不同 id 的**诊断段**（不是 unresolved：它们在 id 层面都对齐了） ──
  for (const [k, list] of liveByGroupAndName) {
    if (list.length > 1) {
      nameCollisions.push({
        group: list[0].group,
        normalized_name: list[0].normalized_name,
        count: list.length,
        ids: list.map((x) => x.id),
        record_kinds: [...new Set(list.map((x) => x.record_kind))],
        note: '公网侧同组内归一化后同名但 id 不同（多为同一图鉴编号下的多个形态）。'
          + '身份按 id 走，所以它们各自独立对齐；这一段只用来证明「按名字对齐会出错」。',
      });
    }
  }

  // ── 两侧都有：比名字与编号 ──────────────────────────────────────────
  for (const [key, fr] of frozenById) {
    if (!comparable(fr.group)) continue;
    const lr = liveById.get(key);
    if (!lr) continue;
    const diffs = [];
    if (fr.normalized_name !== lr.normalized_name) {
      diffs.push({field: 'name', frozen: fr.name, live: lr.name});
    }
    if (fr.group === 'pet') {
      const fn = fr.attributes.number === null ? null : String(fr.attributes.number);
      const ln = lr.attributes.number === null ? null : String(lr.attributes.number);
      if (fn !== ln) diffs.push({field: 'number', frozen: fn, live: ln});
    }
    if (diffs.length > 0) {
      changed.push({
        record_kind: fr.record_kind === lr.record_kind ? fr.record_kind : `${fr.record_kind}/${lr.record_kind}`,
        group: fr.group,
        id: fr.id,
        name: fr.name,
        source_scope: 'frozen_l1+live_bwiki',
        diffs,
        evidence: [fr.evidence, lr.evidence],
      });
    }
  }

  // ── 计数表（文件级 / 页面级，声明数与解析数并列） ────────────────────
  const parsed = parsedCounts || {frozen: {}, live: {}};
  const catPath = evidence.frozen && evidence.frozen.catalog_path;
  const skPath = evidence.frozen && evidence.frozen.skills_path;
  const countTable = [
    {
      layer: 'file',
      source_scope: 'frozen_l1',
      artifact: catPath,
      record_kind: 'pet_record + pet_form',
      group: 'pet',
      declared_count: declaredCounts.frozen.pet,
      parsed_count: parsed.frozen.pet === undefined ? null : parsed.frozen.pet,
      declared_at: `${catPath}#coverage.pets_total`,
      note: 'full-catalog.json 的精灵记录数（每条形态算一条记录）。',
    },
    {
      layer: 'file',
      source_scope: 'frozen_l1',
      artifact: skPath,
      record_kind: 'frozen_skills_file_records（= battle_skill + trait_record）',
      group: null,
      declared_count: declaredCounts.frozen.skills_file,
      parsed_count: parsed.frozen.skills_file === undefined ? null : parsed.frozen.skills_file,
      declared_at: `${skPath}#counts.total`,
      note: 'skills.json 的技能记录总数；这是文件级总称，不作为逐条 record_kind。',
    },
    {
      layer: 'file',
      source_scope: 'frozen_l1',
      artifact: skPath,
      record_kind: 'battle_skill',
      group: 'battle_skill',
      declared_count: declaredCounts.frozen.battle_skill,
      parsed_count: parsed.frozen.battle_skill === undefined ? null : parsed.frozen.battle_skill,
      declared_at: `${skPath}#counts.total - #counts.traits`,
      note: '技能记录总数减去特性数。',
    },
    {
      layer: 'file',
      source_scope: 'frozen_l1',
      artifact: skPath,
      record_kind: 'trait_record',
      group: 'trait',
      declared_count: declaredCounts.frozen.trait,
      parsed_count: parsed.frozen.trait === undefined ? null : parsed.frozen.trait,
      declared_at: `${skPath}#counts.traits`,
      note: 'category=特性 的技能记录数。',
    },
    ...COMPARISON_GROUPS.map((g) => ({
      layer: 'page',
      source_scope: 'live_bwiki',
      artifact: pageKeyOfGroup[g],
      record_kind: g === 'pet' ? 'pet_record + pet_form' : g === 'trait' ? 'trait_record' : 'battle_skill',
      group: g,
      declared_count: comparable(g) ? declaredCounts.live[g] : null,
      parsed_count: comparable(g) ? (liveRecords.filter((r) => r.group === g).length) : null,
      declared_at: comparable(g)
        ? `${pageKeyOfGroup[g]}#declared_count（页面自己渲染的计数）`
        : `${pageKeyOfGroup[g]}#status=${groupBlocked[g].status}`,
      note: comparable(g)
        ? '公网索引页自己声明的计数与该页抽出的卡片数并列。'
        : '公网该页非 ok，没有可用计数（null 表示「不知道」，不是 0）。',
    })),
  ];

  // ── 计数差 + 从桶里推出来并核对过的非空解释 ─────────────────────────
  const deltas = COMPARISON_GROUPS.map((group) => {
    const frozenDeclared = declaredCounts.frozen[group];

    if (!comparable(group)) {
      const blocked = groupBlocked[group];
      return {
        group,
        frozen_count: frozenDeclared,
        live_count: null,
        delta: null,
        only_in_frozen: 0,
        only_in_live: 0,
        changed: 0,
        explained: false,
        unexplained_gap: null,
        explanation: `公网页面 ${pageKeyOfGroup[group]} 状态 ${blocked.status}（${blocked.reason}）：`
          + `公网侧计数不可得（记 null，不记 0），因此本组不给差值，也不做逐条比对。`
          + '见 unresolved 里对应的那一条。',
      };
    }

    const liveDeclared = declaredCounts.live[group];
    const minus = onlyInFrozen.filter((e) => e.group === group);
    const plus = onlyInLive.filter((e) => e.group === group);
    const delta = frozenDeclared - liveDeclared;
    const explainedBy = minus.length - plus.length;
    const consistent = explainedBy === delta;

    let explanation = '';
    let unexplainedGap = null;
    if (consistent) {
      if (delta === 0) {
        explanation = `计数一致且逐条对齐：两侧都声明 ${frozenDeclared} 条`
          + `（冻结 ${frozenDeclared} - 公网 ${liveDeclared} = 0），四个桶里这一组没有任何条目。`;
      } else {
        const parts = [];
        if (minus.length > 0) {
          parts.push(
            `冻结侧多出 ${minus.length} 条，已在 only_in_frozen 逐条列出：`
            + minus.slice(0, 8).map((e) => `${e.id}「${e.name}」`).join('、')
            + (minus.length > 8 ? ` 等共 ${minus.length} 条` : ''),
          );
        }
        if (plus.length > 0) {
          parts.push(
            `公网侧多出 ${plus.length} 条，已在 only_in_live 逐条列出：`
            + plus.slice(0, 8).map((e) => `${e.id}「${e.name}」`).join('、')
            + (plus.length > 8 ? ` 等共 ${plus.length} 条` : ''),
          );
        }
        parts.push(`差值 = 冻结声明 ${frozenDeclared} - 公网声明 ${liveDeclared} = ${delta}，`
          + `与桶内条目数（only_in_frozen ${minus.length} - only_in_live ${plus.length} = ${explainedBy}）一致。`);
        explanation = parts.join('；');
      }
    } else {
      unexplainedGap = {
        delta,
        explained_by_buckets: explainedBy,
        missing: delta - explainedBy,
        detail: `冻结声明 ${frozenDeclared} - 公网声明 ${liveDeclared} = ${delta}，`
          + `但 only_in_frozen ${minus.length} - only_in_live ${plus.length} = ${explainedBy}，`
          + `还差 ${delta - explainedBy} 条没有归属。`,
      };
      explanation = '';
    }

    return {
      group,
      frozen_count: frozenDeclared,
      live_count: liveDeclared,
      delta,
      only_in_frozen: minus.length,
      only_in_live: plus.length,
      changed: changed.filter((e) => e.group === group).length,
      explained: consistent,
      unexplained_gap: unexplainedGap,
      explanation,
    };
  });

  const conventionNotes = formConventionDivergence(frozenRecords, liveRecords);

  // ── 口径说明（含 824 vs 579 这类跨 kind 的差） ──────────────────────
  const scopeExplanations = [
    {
      topic: '824 条技能记录 vs 公网 579 个技能',
      text: '不是矛盾，是**口径不同**：`skills.json` 的 824 = 579 条战斗技能（category 攻击/防御/状态）'
        + ' + 245 条特性（category=特性）。公网「技能图鉴」只列战斗技能（实测 579 张卡），'
        + '特性在**另一张页**「特性图鉴」里（实测 242 张卡）。'
        + '所以 824 应当拆成 579 + 245 再比，而不是直接和 579 比。'
        + '拆开之后，战斗技能这一组 579 = 579 逐条对齐；特性这一组 245 vs 242 差 3 条，'
        + '差的是哪 3 条在 only_in_frozen 里逐条写明（见 deltas[trait]）。',
      check: 'count_table 里 frozen battle_skill=579 与 live skill-index=579；'
        + 'frozen trait_record=245 与 live trait-index=242，差值 3 = only_in_frozen 中 trait 组条目数。',
    },
    {
      topic: '622 条精灵记录 vs 公网 621 个结果',
      text: '冻结的 622 是**记录数**（每条形态算一条记录），公网的 621 是**卡片数**。'
        + '两者只差 1 条，且这一条可以指名到 id：pet_000532（name「幽影树」，'
        + 'title「幽影树（突变的样子）」，game_id 3777，number 035）在公网精灵图鉴里'
        + '**没有独立卡片**；它的立绘 `PetPortrait_youlingshu.png` 出现在公网编号 035'
        + '「幽影树」那张卡（pet_000056）的 `data-search` 检索词里，'
        + '也就是说公网把这张形态并进了基础卡的分组检索，冻结快照把它算成一条独立记录。'
        + '报告同时在 unresolved 里记下这份不确定性：公网存在同名不同 id 的 pet_000056。',
      check: 'only_in_frozen 里只有这 1 条 pet；live pet_000056 的 data-search 含 '
        + 'PetPortrait_youlingshu.png，与冻结 pet_000532 的 image.illustration 相同'
        + '（原始 Lua：data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua）。',
    },
    {
      topic: 'record_kind 与 source_scope 的用法',
      text: '每条产物都带 record_kind（pet_record / pet_form / battle_skill / trait_record）与 '
        + 'source_scope（frozen_l1 / live_bwiki）。计数表同时给文件级与页面级两行、并把'
        + '「声明数」与「解析数」并列，所以「824 里有 245 条根本不是战斗技能」这种口径差'
        + '在报告里是显式的，不靠读者猜。'
        + '`skill_record` 一词只作为**文件级**总称出现在计数表里'
        + '（frozen_skills_file_records），不作为逐条 record_kind——否则它会和 '
        + 'battle_skill / trait_record 重叠。',
      check: 'count_table 里 frozen_skills_file_records=824 与 battle_skill+trait_record=579+245 自洽。',
    },
  ];

  // ── reconciled 判定 ────────────────────────────────────────────────
  const pageStatus = Object.fromEntries(pages.map((p) => [p.key, p.status]));
  const notOkPages = pages.filter((p) => p.status !== 'ok');
  const unexplained = deltas.filter((d) => !d.explanation || String(d.explanation).trim() === '');
  const reasonlessUnresolved = unresolved.filter((u) => !u.reason || String(u.reason).trim() === '');

  let reconciled = true;
  const reasons = [];
  if (pages.length === 0) {
    reconciled = false;
    reasons.push(
      '公网快照不可用：没有任何页面结果（public-index.json 缺失或结构不对）。'
      + '**不把这种情况当成「公网 0 条」**，因此 reconciled=false。',
    );
  } else if (notOkPages.length > 0) {
    reconciled = false;
    reasons.push(
      '公网快照被拦或未解析：'
      + notOkPages.map((p) => `${p.key}=${p.status}（${p.reason || '无原因'}）`).join('；'),
    );
  }
  if (countMismatches.length > 0) {
    reconciled = false;
    reasons.push(
      '声明计数与解析条数不一致：'
      + countMismatches.map((m) => `${m.side}/${m.group} 声明 ${m.declared} vs 解析 ${m.parsed}`).join('；'),
    );
  }
  if (unexplained.length > 0) {
    reconciled = false;
    reasons.push(
      '有计数差但没有可核对归因的解释：'
      + unexplained.map((d) => `${d.group} 冻结 ${d.frozen_count} vs 公网 ${d.live_count}`
        + (d.unexplained_gap ? `（${d.unexplained_gap.detail}）` : '')).join('；')
      + '——桶里没有条目能解释它，所以不允许当作已对账。',
    );
  }
  if (reasonlessUnresolved.length > 0) {
    reconciled = false;
    reasons.push(`有 ${reasonlessUnresolved.length} 条 unresolved 没有写原因。`);
  }
  if (reconciled) {
    reasons.push(
      '三张页全部 ok；声明计数与解析条数一致；三个比较组的计数差都由 '
      + 'only_in_frozen/only_in_live 逐条解释且条目数核对通过；'
      + 'unresolved 只含已写明原因的诊断项（同名不同 id 的歧义）。',
    );
  }

  return {
    schema_version: 1,
    reconciler_version: RECONCILER_VERSION,
    reconciled,
    reason: reasons.join(' '),
    comparison_groups: COMPARISON_GROUPS,
    record_kind_vocabulary: RECORD_KIND_VOCABULARY,
    inputs: {
      ...evidence,
      declared_counts: declaredCounts,
      parsed_counts: parsedCounts,
      live_page_status: pageStatus,
    },
    // 许可是否登记齐全（缺 license/redistribution/evidence 就是 false）。
    // 它与 `reconciled` 分开：对账能不能做，与内容能不能再分发，是两件事。
    licence_ok: Boolean(
      evidence.live
      && evidence.live.licence
      && evidence.live.licence.license
      && evidence.live.licence.redistribution
      && evidence.live.licence.license_evidence,
    ),
    count_table: countTable,
    deltas,
    buckets: {
      only_in_frozen: onlyInFrozen,
      only_in_live: onlyInLive,
      changed,
      unresolved,
    },
    bucket_sizes: {
      only_in_frozen: onlyInFrozen.length,
      only_in_live: onlyInLive.length,
      changed: changed.length,
      unresolved: unresolved.length,
    },
    name_collision_diagnostics: {
      count: nameCollisions.length,
      note: '公网侧同组内归一化同名但 id 不同的组。它们按 id 各自对齐，'
        + '不是 unresolved；这一段用来证明「按名字对齐会把不同形态并起来」。',
      groups: nameCollisions,
    },
    explanations: deltas.map((d) => ({
      group: d.group,
      explanation: d.explanation,
      explained: d.explained,
      unexplained_gap: d.unexplained_gap,
    })),
    scope_explanations: scopeExplanations,
    convention_notes: {
      count: conventionNotes.length,
      note: '两侧对「这条算不算形态」的标注不一致的 id。名字/编号/属性一致，所以不算 changed。',
      items: conventionNotes,
    },
  };
}
// ── 载入输入 ──────────────────────────────────────────────────────────────

export function latestLiveSnapshotPath() {
  if (!existsSync(LIVE_ROOT)) return null;
  const dates = readdirSync(LIVE_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && statSync(join(LIVE_ROOT, d)).isDirectory())
    .sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const p = join(LIVE_ROOT, dates[i], 'public-index.json');
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadInputs({livePath = null} = {}) {
  const catalogPath = join(FROZEN_DIR, 'full-catalog.json');
  const skillsPath = join(FROZEN_DIR, 'skills.json');
  if (!existsSync(catalogPath) || !existsSync(skillsPath)) {
    throw new Error(`冻结目录不完整：${relative(ROOT, FROZEN_DIR)} 缺少 full-catalog.json 或 skills.json`);
  }
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const skills = JSON.parse(readFileSync(skillsPath, 'utf8'));

  const target = livePath || latestLiveSnapshotPath();
  const liveSnapshot = target && existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;

  return {
    catalog,
    skills,
    catalogPath,
    skillsPath,
    liveSnapshot,
    livePath: target,
  };
}

export function buildReport({livePath = null} = {}) {
  const loaded = loadInputs({livePath});
  const {catalog, skills, catalogPath, skillsPath, liveSnapshot} = loaded;

  const frozenRecords = buildFrozenRecords({catalog, skills, catalogPath, skillsPath});

  const liveRecords = liveSnapshot && liveSnapshot.result && Array.isArray(liveSnapshot.result.pages)
    ? buildLiveRecords(liveSnapshot)
    : [];
  const livePages = liveSnapshot && liveSnapshot.result && Array.isArray(liveSnapshot.result.pages)
    ? liveSnapshot.result.pages
    : [];

  // **声明计数**：读产物自己写的数字，不从记录数组长度反推。
  // 这样 delta 才有可能和四个桶对不上，判据 ④ 才有牙齿。
  const declaredCounts = {
    frozen: {
      pet: catalog.coverage && typeof catalog.coverage.pets_total === 'number'
        ? catalog.coverage.pets_total
        : catalog.pets.length,
      skills_file: skills.counts && typeof skills.counts.total === 'number'
        ? skills.counts.total
        : Object.keys(skills.skills).length,
      trait: skills.counts && typeof skills.counts.traits === 'number'
        ? skills.counts.traits
        : frozenRecords.filter((r) => r.group === 'trait').length,
      get battle_skill() { return this.skills_file - this.trait; },
    },
    live: {},
  };
  for (const g of COMPARISON_GROUPS) {
    const p = livePages.find((x) => comparisonGroupOfPageKey(x.key) === g);
    declaredCounts.live[g] = p && p.status === 'ok' && typeof p.declared_count === 'number'
      ? p.declared_count
      : null;
  }

  const parsedCounts = {
    frozen: {
      pet: catalog.pets.length,
      skills_file: Object.keys(skills.skills).length,
      battle_skill: frozenRecords.filter((r) => r.group === 'battle_skill').length,
      trait: frozenRecords.filter((r) => r.group === 'trait').length,
    },
    live: Object.fromEntries(COMPARISON_GROUPS.map((g) => {
      const p = livePages.find((x) => comparisonGroupOfPageKey(x.key) === g);
      return [g, p && p.status === 'ok' ? p.entities.length : null];
    })),
  };

  const evidence = {
    frozen: {
      dir: relative(ROOT, FROZEN_DIR),
      catalog_path: relative(ROOT, catalogPath),
      catalog_sha256: sha256File(catalogPath),
      catalog_count: catalog.pets.length,
      skills_path: relative(ROOT, skillsPath),
      skills_sha256: sha256File(skillsPath),
      skills_count: Object.keys(skills.skills).length,
      note: '冻结目录是**只读**输入；本脚本不写、不改它。',
    },
    live: liveSnapshot
      ? {
        path: relative(ROOT, loaded.livePath),
        snapshot_date: liveSnapshot.snapshot_date,
        extractor_version: liveSnapshot.extractor_version,
        result_sha256: liveSnapshot.metadata ? liveSnapshot.metadata.result_sha256 : null,
        page_sha256: Object.fromEntries(
          Object.entries((liveSnapshot.metadata && liveSnapshot.metadata.pages) || {})
            .map(([k, v]) => [k, {url: v.url, http_status: v.http_status, bytes: v.bytes, sha256: v.sha256, fetched_at: v.fetched_at}]),
        ),
        // **许可与再分发**必须随快照一起进报告：对账结论要能被别人复核，
        // 而「这份公网内容是什么许可、能不能再分发」是复核的第一问。
        // 值搬运自快照 metadata（快照那边又从 sources.yaml 搬），这里**不重新发明**。
        licence: (liveSnapshot.metadata && liveSnapshot.metadata.licence) || null,
        licence_problems: (liveSnapshot.metadata && liveSnapshot.metadata.licence_problems) || [],
      }
      : {
        path: loaded.livePath ? relative(ROOT, loaded.livePath) : null,
        note: '公网快照缺失：data/roco/live/<date>/public-index.json 不存在。'
          + '此时不允许把对账结果当成「已对账」——请先跑 scripts/roco/fetch-live-snapshot.mjs。',
      },
  };

  const report = reconcile({
    frozenRecords,
    liveRecords,
    declaredCounts,
    parsedCounts,
    livePages,
    evidence,
  });
  report.generated_at = new Date().toISOString();
  report.generated_by = 'scripts/roco/reconcile-catalog.mjs';
  return report;
}

export function writeReport(report, outPath = REPORT_PATH) {
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  return outPath;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {live: null, out: REPORT_PATH, json: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

const HELP = `用法：node scripts/roco/reconcile-catalog.mjs [--live PATH] [--out PATH] [--json]

  --live   公网快照路径（默认取 data/roco/live/ 下日期最新的 public-index.json）
  --out    报告输出路径（默认 reports/roco/reconciliation/catalog-reconciliation.json）
  --json   额外把报告打到 stdout

  退出码：0=reconciled；2=未对账（报告照常产出）；3=运行异常
`;

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const report = buildReport({livePath: args.live});
  const path = writeReport(report, args.out);

  process.stdout.write(`[reconcile] reconciled=${report.reconciled}\n`);
  process.stdout.write(`[reconcile] reason=${report.reason}\n`);
  for (const d of report.deltas) {
    process.stdout.write(
      `[reconcile] ${d.group.padEnd(13)} frozen=${String(d.frozen_count).padStart(4)} `
      + `live=${String(d.live_count).padStart(4)} delta=${String(d.delta).padStart(4)} `
      + `only_in_frozen=${d.only_in_frozen} only_in_live=${d.only_in_live} changed=${d.changed}\n`,
    );
  }
  process.stdout.write(`[reconcile] buckets=${JSON.stringify(report.bucket_sizes)}\n`);
  for (const e of report.buckets.only_in_frozen) {
    process.stdout.write(`[reconcile]   only_in_frozen: ${e.record_kind} ${e.id} 「${e.name}」\n`);
  }
  for (const e of report.buckets.only_in_live) {
    process.stdout.write(`[reconcile]   only_in_live:   ${e.record_kind} ${e.id} 「${e.name}」\n`);
  }
  for (const e of report.buckets.changed) {
    process.stdout.write(`[reconcile]   changed:        ${e.id} ${JSON.stringify(e.diffs)}\n`);
  }
  process.stdout.write(`[reconcile] wrote ${relative(ROOT, path)}\n`);
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.reconciled ? 0 : 2;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[reconcile] 运行失败：${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 3;
  }
}
