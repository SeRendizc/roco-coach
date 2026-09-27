// 金标（标准答案）**送审闸门**的纯逻辑层。
//
// 存在理由（人类口径 1，逐字）：
//   「金标（标准答案）由你重做、我不许动：这个它可以改，但是必须得我先审阅」
//   ⇒ **可以改，但改了要送审**；**审之前不许拿去刷指标**。
//
// 这个模块**只做三件可复算的事**，不碰模型、不碰网络、不碰 8765：
//   ① `goldRevision()`：给一条金标算一个**内容指纹**（改了 message / expect / 正则 / 参数，指纹必变）；
//   ② `mergeReviewState()`：把「磁盘上人类审过的状态」与「现在代码里的金标」合并，
//      算出每条**能不能当已审**（`unreviewed`）；
//   ③ `checkGoldReview()`：判据用的纯函数 —— 返回问题清单，空数组才算过。
//
// 为什么指纹不能直接用 `JSON.stringify(case)`：
//   `expect.answer.must/mustNot` 里是**箭头函数与正则字面量**（见 scripts/eval-live-s04.js:210,216,222,228），
//   `JSON.stringify` 会把函数丢成 `undefined`、把正则变成 `{}` ⇒ 改了正则而指纹不变，
//   「改了答案文本但没改 revision ⇒ 必须红」这条反证就**没有牙**。所以这里递归取 `String(fn)` / `String(re)`。
//
// 方向（很重要，别反过来）：**指纹存在 `review-state.json` 里（人类审阅时写死），运行时重算并比对**。
// 若指纹是运行时自动写进去的，它永远追平，反证就失效了。

import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const REVIEW_STATE_PATH = 'data/roco/gold/review-state.json';
export const GOLD_STATUSES = ['draft', 'approved'];
/** 只有人类本人（本项目里就是 owner）能批准；agent 想自我批准必须**显式改这一行**，diff 里看得见。 */
export const DEFAULT_REVIEWER_ALLOWLIST = ['owner（人类持有者）'];

/** 规范化一条金标：函数取源码、正则取字面量、对象键排序 ⇒ 逐字节可复算。 */
export function canonicalGoldCase(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  // 数字要**按值分别编码**：`JSON.stringify(NaN/±Infinity)` 全是 `null`，`-0` 是 `0`
  // ——那样「把标准答案从 1 改成 NaN」这种改动在指纹里**看不见**（对抗复核 A7）。
  // 普通数字仍走 JSON.stringify：编码不变 ⇒ 54 条既有 revision 一个都不动。
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'number:Infinity' : 'number:-Infinity';
    if (Object.is(value, -0)) return 'number:-0';
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return `fn:${String(value)}`;
  if (value instanceof RegExp) return `re:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(canonicalGoldCase).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalGoldCase(value[key])}`).join(',')}}`;
  }
  return `?${String(value)}`;
}

/** 内容指纹：sha256(规范化) 前 8 位十六进制。 */
export function goldRevision(kase) {
  return createHash('sha256').update(canonicalGoldCase(kase)).digest('hex').slice(0, 8);
}

/** 把一组金标变成 `[{id, revision, canonical}]`（canonical 一并带出，好让判据能**独立**重算一遍）。 */
export function goldCaseIndex(cases) {
  return cases.map((kase) => ({id: kase.id, revision: goldRevision(kase), canonical: canonicalGoldCase(kase)}));
}

/** 独立校验：调用方拿 canonical 自己哈希一遍，与 revision 对齐 —— 防止「指纹函数本身坏了也没人发现」。 */
export function revisionOfCanonical(canonical) {
  return createHash('sha256').update(String(canonical)).digest('hex').slice(0, 8);
}

export function emptyReviewState({generatedBy = 'scripts/roco/gold-review-state.mjs', allowlist = DEFAULT_REVIEWER_ALLOWLIST} = {}) {
  return {
    schema: 'roco-gold-review-state/v1',
    generated_by: generatedBy,
    reviewer_allowlist: [...allowlist],
    note: '人类口径 1：金标可以改，但必须人类先审阅。status=approved 只有人类能写；'
      + 'revision 变了而 status 仍是 approved ⇒ 判据必须红（等于「改了答案没重新送审」）。',
    cases: {},
  };
}

/** 读磁盘上的审阅状态；**读不到返回 null**（不抛），调用方必须降级成「全部未审」而不是崩。 */
export function loadReviewState({root = ROOT, path = REVIEW_STATE_PATH} = {}) {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.cases !== 'object' || parsed.cases === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 合并：算出每条金标的**有效状态**。
 *
 * 有效 `approved` 的三个条件（缺一即 `unreviewed`）：
 *   ① 状态里写着 `approved`；② 写的 `revision` 与**现在代码里的**一致；③ `reviewed_by` 在允许名单里且有 `reviewed_at`。
 * ②是关键：**改了金标而没重新送审 ⇒ 自动退回未审**，不需要谁记得去改状态文件。
 */
export function mergeReviewState(entries, state) {
  const recorded = state && typeof state.cases === 'object' && state.cases ? state.cases : {};
  // ⚠️ 2026-09-25 对抗复核修（A1）：允许名单**只认源码里的常量**。
  // 旧写法"数据文件里写了就用数据文件的"，等于把闸门的钥匙放在被审的那份文件里 ——
  // agent 本来就要用 `--sync` 写 `review-state.json`，于是它能把 `reviewer_allowlist` 改成自己、
  // 再给自己写一条 approved，`gate_eligible` 就 true 了（实测过）。注释当时宣称"必须显式改源码、diff 里看得见"，不成立。
  const allowlist = DEFAULT_REVIEWER_ALLOWLIST;
  const rows = entries.map((entry) => {
    const saved = recorded[entry.id] ?? null;
    const review = evaluateEntry(entry, saved, allowlist);
    return {...entry, ...review};
  });
  const approved = rows.filter((row) => row.status === 'approved');
  return {
    rows,
    summary: {
      total: rows.length,
      approved: approved.length,
      draft: rows.length - approved.length,
      // 「闸门合格」= 每一条都真的被人类审过；只要有一条没审，任何能力结论都不许对外说。
      gate_eligible: rows.length > 0 && approved.length === rows.length,
      unreviewed_ids: rows.filter((row) => row.unreviewed).map((row) => row.id),
      reviewers: [...new Set(approved.map((row) => row.reviewed_by))].sort(),
    },
  };
}

function evaluateEntry(entry, saved, allowlist) {
  const status = saved?.status;
  const reasons = [];
  if (!saved) reasons.push('missing-entry');
  if (saved && !GOLD_STATUSES.includes(status)) reasons.push(`invalid-status:${String(status)}`);
  let approved = saved?.status === 'approved';
  if (approved && saved.revision !== entry.revision) {
    approved = false;
    reasons.push('revision-drift');
  }
  if (approved && !allowlist.includes(saved.reviewed_by)) {
    approved = false;
    reasons.push(`reviewer-not-allowed:${String(saved.reviewed_by)}`);
  }
  if (approved && !saved.reviewed_at) {
    approved = false;
    reasons.push('missing-reviewed-at');
  }
  return {
    revision: entry.revision,
    recorded_revision: saved?.revision ?? null,
    status: approved ? 'approved' : 'draft',
    recorded_status: status ?? null,
    unreviewed: !approved,
    reviewed_by: saved?.reviewed_by ?? null,
    reviewed_at: saved?.reviewed_at ?? null,
    review_reasons: reasons,
  };
}

/**
 * 判据用的纯函数：返回问题清单（空数组 = 过）。
 *
 * 五类问题（每条都能被一条必红反证做红，见 tests/roco-gold-review-gate.test.js 与 guard-selftest）：
 *   ① missing-entry —— 有金标没登记进 review-state（新加的题必须显式登记，不能默认"已审"）
 *   ② revision-drift —— 登记的内容指纹与现在代码里的不一致（**改了答案没重新送审**）
 *   ③ invalid-status / reviewer-not-allowed / missing-reviewed-at —— approved 写得不合法
 *   ④ orphan-entry —— 状态里有、代码里没有的 id（删了题要一起删状态）
 *   ⑤ summary-mismatch —— 传进来的 summary 与重算不一致
 */
export function checkGoldReview(entries, state, {allowlist = null, summary = null} = {}) {
  const problems = [];
  const recorded = state && typeof state.cases === 'object' && state.cases ? state.cases : {};
  // A1：同上 —— 只认源码常量。
  const allowed = DEFAULT_REVIEWER_ALLOWLIST;
  // 数据文件里若声明了**不同**的允许名单，直接报错（它是篡改的特征，不是配置项）。
  const declared = state?.reviewer_allowlist;
  if (Array.isArray(declared) && declared.length
    && [...declared].sort().join('|') !== [...DEFAULT_REVIEWER_ALLOWLIST].sort().join('|')) {
    problems.push(`review-state 里的 reviewer_allowlist ${JSON.stringify(declared)} 与源码常量不一致 ——`
      + ' 允许名单只能写在源码里（写在被审的数据文件里等于把钥匙放在锁旁边）');
  }
  if (!state) problems.push('review-state 读不出来（缺失或坏 JSON）：所有金标一律按未审处理');
  const seen = new Set();
  for (const entry of entries) {
    seen.add(entry.id);
    const saved = recorded[entry.id];
    if (!saved) {
      problems.push(`${entry.id}: missing-entry（金标没有登记审阅状态）`);
      continue;
    }
    if (!GOLD_STATUSES.includes(saved.status)) {
      problems.push(`${entry.id}: invalid-status ${JSON.stringify(saved.status)}`);
    }
    if (saved.revision !== entry.revision) {
      problems.push(`${entry.id}: revision-drift（登记 ${saved.revision} ≠ 现在 ${entry.revision}）`
        + '—— 改了金标必须重新送审');
    }
    if (saved.status === 'approved') {
      if (!allowed.includes(saved.reviewed_by)) {
        problems.push(`${entry.id}: reviewer-not-allowed ${JSON.stringify(saved.reviewed_by)}`
          + `（允许名单 ${JSON.stringify(allowed)}）`);
      }
      if (!saved.reviewed_at) problems.push(`${entry.id}: approved 但缺 reviewed_at`);
    }
  }
  for (const id of Object.keys(recorded)) {
    if (!seen.has(id)) problems.push(`${id}: orphan-entry（状态里有、金标里没有）`);
  }
  if (summary) {
    // 一次 merge 同时拿 rows 与 summary：同一份合并在同一个函数里算两遍，
    // 以后只要有人只改其中一处（比如给 rows 加一层过滤），两边就会悄悄不一致（对抗复核 A5）。
    const {rows, summary: recomputed} = mergeReviewState(entries, state);
    void rows;
    if (summary.total !== recomputed.total) problems.push(`summary.total ${summary.total} ≠ ${recomputed.total}`);
    if (summary.approved !== recomputed.approved) problems.push(`summary.approved ${summary.approved} ≠ ${recomputed.approved}`);
    const declared = [...(summary.unreviewed_ids ?? [])].sort().join(',');
    const actual = [...recomputed.unreviewed_ids].sort().join(',');
    if (declared !== actual) problems.push(`summary.unreviewed_ids 与重算不一致（${declared} vs ${actual}）`);
    void rows;
  }
  return problems;
}

/**
 * `--sync` 的产物：**保留人类已做的审阅决定，但内容一变就退回 draft**。
 * 绝不自动批准任何东西（`status` 只可能是 draft；approved 只继承自旧状态且指纹必须一致）。
 */
export function reviewStateFor(entries, previous, {generatedBy = 'scripts/roco/gold-review-state.mjs'} = {}) {
  const next = emptyReviewState({generatedBy});
  // A1：**不继承**数据文件里的名单（只写常量那份）—— 避免 sync 把篡改值一路带下去。
  const kept = [];
  const reset = [];
  for (const entry of entries) {
    const saved = previous?.cases?.[entry.id] ?? null;
    if (saved && saved.status === 'approved' && saved.revision === entry.revision) {
      next.cases[entry.id] = {...saved};
      kept.push(entry.id);
    } else {
      next.cases[entry.id] = {
        revision: entry.revision,
        status: 'draft',
        reviewed_by: null,
        reviewed_at: null,
        note: saved ? '内容变了或上次也未审 ⇒ 退回 draft，等待人类重新审阅' : '新登记，等待人类审阅',
      };
      if (saved) reset.push(entry.id);
    }
  }
  next.sync_note = `本轮 sync：保留已审 ${kept.length} 条，退回/新增 draft ${reset.length + (entries.length - kept.length - reset.length)} 条。`;
  return {state: next, kept, reset};
}
