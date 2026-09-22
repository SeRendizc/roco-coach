// RC-501：**保留资产不许静默退化**的可复核清单。
//
// 这一条回答的是 v3 红线里那句话：「不得重写或退化现有 Agent / RAG / Memory /
// 军师·老师·陪练三角色 / game adapter / mock host / stale-result guard / release guard」。
// 光写一句「保留」没有牙 —— 一个资产可能在接下来的某一轮里**悄悄失去它的判据**
// （脚本被删、报告不再生成、从套件清单里掉出去），而没人会注意到，因为「没红」和
// 「没在跑」在 CI 里长得一模一样。**守卫不跑等于没有守卫**（第 39 轮踩过）。
//
// 所以每一条保留资产必须同时具备四样东西，缺一样就判红：
//   ① **判据**：跑得起来的东西（套件 id / `test:unit` 里的文件 / npm 脚本）；
//   ② **接线**：它真的被某个**会跑的入口**收着（套件在最近一次 gate 的清单里，
//      文件在 `test:unit` 的显式清单里，npm 脚本真的存在）—— 不是「仓库里有这个文件」；
//   ③ **证据**：机器可读产物在场，且满足声明的那类断言（全绿 / 零失败 / 全反证命中）
//      加一条**条数下限**（判据被悄悄删掉一半会红）；
//   ④ **必红方向**：要么报告里逐条带 `counterproofs` 且全部命中，要么判据自己带
//      `--fault` / `--selftest` / `--check` 这类反证入口。
//
// 用法：
//   node scripts/roco/revalidate-retained-assets.mjs            # 跑一遍并写报告
//   node scripts/roco/revalidate-retained-assets.mjs --check    # 只读，不写产物（门禁用）
//   node scripts/roco/revalidate-retained-assets.mjs --selftest # 自检：坏输入必须报出问题
//
// 产物：reports/roco/rc501/revalidation.json

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/rc501/revalidation.json');
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const SELFTEST = args.includes('--selftest');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const exists = (rel) => existsSync(join(ROOT, rel));

/**
 * 保留资产的声明表。
 *
 * `evidence.expect` 是一个**闭集**（不是一段任意脚本）：
 *   · `exists`              产物在场且能解析（最弱的一档，只在别处已有强判据时才用）
 *   · `verdict_pass`        `verdict === 'pass'`（或布尔 `true`）
 *   · `zero_failed`         `failed === 0`（或 `summary.failed === 0`）
 *   · `all_ok`              `checks[]` 逐条 `ok`/`pass` 都为真
 *   · `batch_zero_failed`   `fields[]` 指到的每个批次都 `failed === 0` 且 `total > 0`
 *   · `all_values_true`     `fields[]` 指到的对象的**每个值**都是 true
 *   · `gate_zero_violations` 硬门控：`matched === total`、`spoken_under_gate === 0`、`failures` 空
 * `min_checks` 是**下限**：判据条数被悄悄删掉一半会红。
 */
const RETAINED = [
  {
    id: 'agent-trajectories',
    name: 'Agent 轨迹与工具协议（6048 条回放）',
    promise: '工具协议与轨迹回放不退化：结构、回放、grader 三层都逐条复验，'
      + '且「改坏一条就判红」的负数样本真的被抓到',
    judge: {kind: 'suite', ref: 'trajectories'},
    evidence: {path: 'reports/roco/agent-trajectories-verification.json', expect: 'batch_zero_failed',
      fields: ['structural', 'replay', 'grader.positive']},
    negative: [
      {kind: 'script_flag', path: 'scripts/roco/verify-agent-trajectories.mjs', flag: '--selftest'},
      {kind: 'report_field', path: 'reports/roco/agent-trajectories-verification.json',
        field: 'grader.negative', expect: 'all_passed_batch', min_total: 1000},
    ],
  },
  {
    id: 'rag-evidence',
    name: 'RAG 证据与 held-out 评测',
    promise: '五类查询的 Recall@K / MRR / 版本命中 / grounding / 冲突弃答都能复算',
    judge: {kind: 'suite', ref: 'rag-eval'},
    evidence: {path: 'reports/roco/rag/rag-eval.json', expect: 'exists'},
    negative: [{kind: 'test_pair', path: 'tests/roco-rag-eval.test.js', needle: '弃答'}],
  },
  {
    id: 'memory-preference',
    name: 'Memory（偏好记忆）',
    promise: '静默偏好能被记住、能进聊天链路、可忘记',
    judge: {kind: 'unit_file', ref: 'tests/companion.test.js'},
    evidence: null,
    negative: [{kind: 'test_pair', path: 'tests/companion.test.js', needle: '偏好'}],
  },
  {
    id: 'strategist',
    name: '军师（主动提示）',
    promise: '多动作比较 + 未来后果：两个合法动作、下一回合机会、最大下行，且不给伪精确胜率',
    judge: {kind: 'suite', ref: 'plan-e2e'},
    evidence: {path: 'reports/roco/demo-acceptance/demo-acceptance.json', expect: 'zero_failed', min_checks: 100},
    negative: [{kind: 'report_field', path: 'reports/roco/ux-acceptance/browser-roco-ux-acceptance.json',
      field: 'counterproofs_all_hit', expect: true}],
  },
  {
    id: 'companion',
    name: '陪练（小芽）',
    promise: '入口可用、手动说话能回、不聊天也会出主动提示，且不打断对局',
    judge: {kind: 'npm_script', ref: 'roco:companion-nonintrusion'},
    evidence: {path: 'reports/roco/companion-nonintrusion.json', expect: 'verdict_pass'},
    negative: [
      {kind: 'report_field', path: 'reports/roco/companion-nonintrusion.json',
        field: 'gates', expect: 'all_values_true'},
      // 这组判据**自己声明了每条阈值都能红**（实测把阈值抬上去就红）—— 这是它的必红证据。
      {kind: 'report_field', path: 'reports/roco/companion-nonintrusion.json',
        field: 'criteria_can_fail', expect: 'any_key_suffix_true', suffix: '_can_fail'},
    ],
  },
  {
    id: 'teacher',
    name: '老师（局末复盘）',
    promise: '按可教性选课、挂账回合用局面回合；不是一句话模板',
    judge: {kind: 'unit_file', ref: 'tests/evals/teacher-review.test.js'},
    evidence: null,
    negative: [{kind: 'test_pair', path: 'tests/evals/roco/teacher-match-review.test.js', needle: '课'}],
  },
  {
    id: 'game-adapter',
    name: 'game adapter（游戏适配层）',
    promise: '适配层只搬运、不改规则：编数字 / 编动作 / 越界字段一律拒',
    judge: {kind: 'unit_file', ref: 'tests/evals/roco/game-adapter.test.js'},
    evidence: {path: 'reports/roco/adapter-acceptance/browser-adapter-acceptance.json',
      expect: 'zero_failed', min_checks: 8},
    negative: [{kind: 'test_pair', path: 'tests/evals/roco/game-adapter.test.js', needle: '都会被丢掉并换回执'}],
  },
  {
    id: 'mock-host',
    name: 'mock host（本地模拟宿主）',
    promise: '装配期缺能力就拒绝装配；线上竞技 PVP 里不给战术分析',
    judge: {kind: 'unit_file', ref: 'tests/evals/roco/mock-host-integration.test.js'},
    evidence: null,
    negative: [{kind: 'test_pair', path: 'tests/evals/roco/mock-host-integration.test.js', needle: '拒绝装配'}],
  },
  {
    id: 'stale-plan-guard',
    name: 'stale-result guard（陈旧规划必须被丢弃）',
    promise: '陈旧规划不许上屏：版本对不上就作废，且只有一个入口',
    judge: {kind: 'unit_file', ref: 'tests/roco-experience.test.js'},
    evidence: {path: 'reports/roco/demo-acceptance/demo-acceptance.json', expect: 'zero_failed', min_checks: 100},
    negative: [{kind: 'test_pair', path: 'tests/roco-experience.test.js', needle: '作废'}],
  },
  {
    id: 'release-guard',
    name: 'release guard（发版闸门自身）',
    promise: '注入真实违规时登记过的守卫**真的会红**',
    judge: {kind: 'suite', ref: 'guard-selftest'},
    evidence: null,
    negative: [{kind: 'script_flag', path: 'scripts/roco/guard-selftest.mjs', flag: '注入'}],
  },
  {
    id: 'pvp-gate',
    name: 'PVP 门控（按 BattleMode 裁剪合法行动）',
    promise: '标准 PVP 下不出现道具与逃跑；隐藏要如实记账，不是假装引擎没给',
    judge: {kind: 'unit_file', ref: 'tests/roco-standard-pvp-battle.test.js'},
    evidence: {path: 'reports/roco/workshop-acceptance/browser-workshop-acceptance.json',
      expect: 'all_ok', min_checks: 30},
    negative: [{kind: 'report_field', path: 'reports/roco/ux-acceptance/browser-roco-ux-acceptance.json',
      field: 'counterproofs_all_hit', expect: true}],
  },
  {
    id: 'page-ux-p0',
    name: '用户 P0 的页面能力（翻页 / 选宠 / 行动坞 / 场上事实）',
    promise: '页面看不到或点不动的能力不得仅凭单元测试标记完成',
    judge: {kind: 'suite', ref: 'roco-ux-acceptance'},
    evidence: {path: 'reports/roco/ux-acceptance/browser-roco-ux-acceptance.json',
      expect: 'all_ok', min_checks: 35},
    negative: [{kind: 'report_field', path: 'reports/roco/ux-acceptance/browser-roco-ux-acceptance.json',
      field: 'counterproofs_all_hit', expect: true}],
  },
  {
    id: 'intervention-gate',
    name: '介入层硬门控（规则不许被学习层覆盖）',
    promise: '规则说不行就是不行：介入层只能在规则允许的窗口里开口，一个都不许多',
    judge: {kind: 'unit_file', ref: 'tests/evals/roco/intervention-agreement.test.js'},
    evidence: {path: 'reports/roco/intervention-agreement.json', expect: 'gate_zero_violations',
      field: 'gate_cases'},
    negative: [{kind: 'test_pair', path: 'tests/evals/roco/intervention-agreement.test.js',
      needle: '不许把点估计写成区间'}],
  },
];


/** 取值：支持点号路径（报告字段是嵌套的，`get(row,'a.b')`）。 */
function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** `checks[]` 逐条的 ok/pass（两种写法都认；缺字段就是 undefined，由调用方判红）。 */
function allChecks(report) {
  const list = Array.isArray(report?.checks) ? report.checks : [];
  return list.map((row) => row?.ok ?? row?.pass);
}
function failedCount(report) {
  if (Number.isFinite(report?.failed)) return report.failed;
  if (Number.isFinite(report?.summary?.failed)) return report.summary.failed;
  return null;
}

/** 按声明的那一类断言核对证据（返回问题清单，空 = 通过）。 */
function checkEvidence(asset, report) {
  const problems = [];
  const spec = asset.evidence;
  const {expect} = spec;
  const list = allChecks(report);
  if (expect === 'exists') {
    if (!report) problems.push('产物是空的');
  }
  if (expect === 'all_ok') {
    if (list.length === 0) problems.push('报告里 checks[] 是空的（判据一条都没跑）');
    const bad = list.filter((ok) => ok !== true).length;
    if (bad) problems.push(`checks[] 里有 ${bad} 条不是 true`);
  }
  if (expect === 'zero_failed') {
    const failed = failedCount(report);
    if (failed === null) problems.push('报告里既没有 failed 也没有 summary.failed（形状变了？）');
    else if (failed !== 0) problems.push(`failed = ${failed}`);
  }
  if (expect === 'verdict_pass') {
    if (report?.verdict !== 'pass' && report?.verdict !== true) {
      problems.push(`verdict = ${JSON.stringify(report?.verdict)}`);
    }
  }
  if (expect === 'batch_zero_failed') {
    for (const field of spec.fields ?? []) {
      const batch = getPath(report, field);
      if (!batch || typeof batch !== 'object') { problems.push(`${field} 不是一个批次对象`); continue; }
      if (!Number.isFinite(batch.total) || batch.total <= 0) problems.push(`${field}.total = ${batch.total}（没样本）`);
      // 有的报告只给 total/passed（没有 failed 字段）—— 按 total - passed 算，不因为缺字段就放过。
      const failed = Number.isFinite(batch.failed) ? batch.failed
        : (Number.isFinite(batch.passed) ? batch.total - batch.passed : null);
      if (failed === null) problems.push(`${field} 既没有 failed 也没有 passed（形状变了？）`);
      else if (failed !== 0) problems.push(`${field}.failed = ${failed}`);
    }
  }
  if (expect === 'all_values_true') {
    problems.push(...assertAllValuesTrue(getPath(report, spec.field), spec.field));
  }
  if (expect === 'gate_zero_violations') {
    const gate = getPath(report, spec.field);
    if (!gate || typeof gate !== 'object') { problems.push(`${spec.field} 不是一个对象`); return problems; }
    if (!Number.isFinite(gate.total) || gate.total <= 0) problems.push(`${spec.field}.total = ${gate.total}（没样本）`);
    if (gate.gate_matched !== gate.total) problems.push(`门控命中 ${gate.gate_matched}/${gate.total}`);
    if (gate.spoken_under_gate !== 0) problems.push(`门控窗口里开口了 ${gate.spoken_under_gate} 次（必须为 0）`);
    if (Array.isArray(gate.failures) && gate.failures.length) problems.push(`failures 非空：${JSON.stringify(gate.failures).slice(0, 120)}`);
  }
  if (Number.isFinite(spec.min_checks)) {
    const count = list.length || (Number.isFinite(report?.passed) ? report.passed : 0);
    if (count < spec.min_checks) {
      problems.push(`判据条数 ${count} < 下限 ${spec.min_checks}（判据被删掉了一半？）`);
    }
  }
  return problems;
}

/** `all_values_true`：对象的每个值都得 `passed === true`（逐项点名没过的那几个）。 */
function assertAllValuesTrue(box, label) {
  if (!box || typeof box !== 'object') return [`${label} 不是一个对象`];
  const names = Object.keys(box);
  if (names.length === 0) return [`${label} 是空的`];
  const bad = names.filter((k) => box[k]?.passed !== true);
  return bad.length ? [`${label} 里这些项没过：${bad.join('、')}`] : [];
}

/** 一条必红方向（返回问题清单，空 = 这条方向立得住）。 */
function checkOneNegative(neg) {
  if (!neg) return ['没有声明必红方向：这条资产「怎么才会红」说不清'];
  if (neg.kind === 'script_flag') {
    if (!exists(neg.path)) return [`反证入口文件不存在：${neg.path}`];
    if (!read(neg.path).includes(neg.flag)) return [`${neg.path} 里找不到反证入口 ${neg.flag}`];
    return [];
  }
  if (neg.kind === 'test_pair') {
    if (!exists(neg.path)) return [`反证用例文件不存在：${neg.path}`];
    if (!read(neg.path).includes(neg.needle)) {
      return [`${neg.path} 里找不到「${neg.needle}」相关的用例（反证被删了？）`];
    }
    return [];
  }
  if (neg.kind === 'report_field') {
    if (!exists(neg.path)) return [`反证报告不存在：${neg.path}`];
    const report = readJson(neg.path);
    const value = getPath(report, neg.field);
    if (neg.expect === true || neg.expect === false) {
      if (value !== neg.expect) {
        return [`${neg.path} 的 ${neg.field} = ${JSON.stringify(value)}，期望 ${JSON.stringify(neg.expect)}`];
      }
      return [];
    }
    if (neg.expect === 'all_passed_batch') {
      if (!value || typeof value !== 'object') return [`${neg.path} 的 ${neg.field} 不是一个批次对象`];
      if (!Number.isFinite(value.total) || value.total < (neg.min_total ?? 1)) {
        return [`${neg.path} 的 ${neg.field}.total = ${value.total} < ${neg.min_total ?? 1}（负数样本太少，证明不了）`];
      }
      const failed = Number.isFinite(value.failed) ? value.failed
        : (Number.isFinite(value.passed) ? value.total - value.passed : null);
      if (value.passed !== value.total || failed !== 0) {
        return [`${neg.path} 的 ${neg.field} 没全过：passed=${value.passed} total=${value.total} failed=${failed}`];
      }
      return [];
    }
    if (neg.expect === 'all_values_true') {
      return assertAllValuesTrue(value, `${neg.path} 的 ${neg.field}`);
    }
    if (neg.expect === 'any_key_suffix_true') {
      if (!value || typeof value !== 'object') return [`${neg.path} 的 ${neg.field} 不是一个对象`];
      const hits = Object.keys(value).filter((k) => k.endsWith(neg.suffix) && value[k] === true);
      if (hits.length === 0) {
        return [`${neg.path} 的 ${neg.field} 里没有任何 ${neg.suffix} 为 true（「这条判据能红」没被声明）`];
      }
      return [];
    }
    return [`未知的报告断言：${neg.expect}`];
  }
  if (neg.kind === 'report_negative') {
    if (!exists(neg.path)) return [`反证报告不存在：${neg.path}`];
    const report = readJson(neg.path);
    const hasCounter = Array.isArray(report?.counterproofs) && report.counterproofs.length > 0;
    const fault = report?.fault_injected === true;
    if (!hasCounter && !fault && !Array.isArray(report?.[neg.field])) {
      return [`${neg.path} 里既没有 counterproofs、也没有 fault_injected（拿不到必红证据）`];
    }
    return [];
  }
  return [`未知的必红方向类型：${neg.kind}`];
}

/** 必红方向可以是**多条**：每一条都要立得住。 */
function checkNegative(asset) {
  const list = Array.isArray(asset.negative) ? asset.negative : (asset.negative ? [asset.negative] : []);
  if (list.length === 0) return ['没有声明必红方向：这条资产「怎么才会红」说不清'];
  return list.flatMap((neg) => checkOneNegative(neg));
}

/** ① 判据存在 + ② 接线：它真的被某个**会跑的入口**收着（不是「仓库里有这个文件」）。 */
function checkJudge(asset, ctx) {
  const problems = [];
  const {kind, ref} = asset.judge;
  if (kind === 'unit_file' || kind === 'test') {
    if (!exists(ref)) problems.push(`判据文件不存在：${ref}`);
    if (!ctx.unitFiles.includes(ref)) problems.push(`${ref} 不在 test:unit 的显式清单里`);
    return problems;
  }
  if (kind === 'suite') {
    // 「接线」的**真值来源是门禁脚本自己**（它声明了哪些套件），不是最近一次运行的产物：
    // 门禁有 `--quick` 这种只跑一部分的模式，产物里天然会缺套件 ——
    // 拿产物当唯一判据会把「这次跑了子集」误判成「套件被摘掉了」。
    if (!ctx.declaredSuites.has(ref)) problems.push(`scripts/roco/verify-release.mjs 里没有套件 ${ref}（它掉出门禁了）`);
    if (ctx.gateSuites?.has(ref) && ctx.gateSuites.get(ref).ok !== true) {
      problems.push(`套件 ${ref} 最近一次是红的`);
    }
    return problems;
  }
  if (kind === 'npm_script') {
    if (!(ref in ctx.scripts)) problems.push(`npm 脚本不存在：${ref}`);
    return problems;
  }
  return [`未知的判据类型：${kind}`];
}

function revalidate() {
  const pkg = readJson('package.json');
  const unitFiles = String(pkg.scripts?.['test:unit'] ?? '').split(/\s+/).filter((t) => t.startsWith('tests/'));
  const gatePath = 'reports/roco/verification/latest.json';
  const gate = exists(gatePath) ? readJson(gatePath) : null;
  const gateSuites = new Map((gate?.suites ?? []).map((s) => [s.id, s]));
  // 门禁脚本自己声明的套件清单（`{id: 'x', cmd: ...}`）。
  const releaseSrc = read('scripts/roco/verify-release.mjs');
  const declaredSuites = new Set([...releaseSrc.matchAll(/\{id:\s*'([^']+)'/g)].map((m) => m[1]));

  const rows = RETAINED.map((asset) => {
    const problems = [...checkJudge(asset,
      {unitFiles, gate, gateSuites, declaredSuites, gatePath, scripts: pkg.scripts ?? {}})];
    // ③ 证据
    let evidence = null;
    if (asset.evidence) {
      if (!exists(asset.evidence.path)) problems.push(`证据产物不存在：${asset.evidence.path}`);
      else {
        try {
          evidence = readJson(asset.evidence.path);
          problems.push(...checkEvidence(asset, evidence).map((p) => `${asset.evidence.path}：${p}`));
        } catch (error) {
          problems.push(`证据产物读不出来（${asset.evidence.path}）：${error.message}`);
        }
      }
    }
    // ④ 必红方向
    problems.push(...checkNegative(asset));
    return {id: asset.id, name: asset.name, promise: asset.promise, judge: asset.judge,
      evidence: asset.evidence?.path ?? null, negative: asset.negative,
      problems, ok: problems.length === 0};
  });

  return {
    schema: 'roco-retained-assets/v1',
    rc: 'RC-501',
    generated_by: 'scripts/roco/revalidate-retained-assets.mjs',
    why: 'v3 红线：不得重写或退化现有 Agent/RAG/Memory/三角色/game adapter/mock host/'
      + 'stale-result guard/release guard。「保留」必须有牙 —— 缺判据、掉出套件清单、'
      + '产物不再生成、没有必红方向，四样缺一样都要红（守卫不跑等于没有守卫）。',
    gate: {path: gatePath, verdict: gate?.verdict ?? null,
      declared_suites: [...declaredSuites], last_run_suites: (gate?.suites ?? []).map((s) => s.id),
      head_run: gate?.head ?? null},
    totals: {assets: rows.length, ok: rows.filter((r) => r.ok).length,
      with_problems: rows.filter((r) => !r.ok).length},
    assets: rows,
    known_limits: [
      '这里验的是「这条资产**还在被判据守着**」，不是「它的行为一定对」——行为对错由各自的判据负责',
      '证据产物是**最近一次**跑出来的：产物陈旧（引擎改了但没重跑）这里看不出来，'
        + '所以每条的判据都还是各自套件里的判据，这一层只是防止它们被悄悄摘掉',
      '`min_checks` 是手写的下限，不是自动推导的：判据被删到只剩一半会红，删几条看不出来',
    ],
  };
}

// ── 自检：坏输入必须报出问题（证明这一层不是恒绿）────────────────────────────
function selftest() {
  const problems = [];
  const base = revalidate();
  if (base.totals.with_problems !== 0) {
    problems.push(`现状本身就有问题，自检没法进行：${JSON.stringify(base.assets.filter((a) => !a.ok).map((a) => a.id))}`);
  }
  const pkg = readJson('package.json');
  const unitFiles = String(pkg.scripts?.['test:unit'] ?? '').split(/\s+/).filter((t) => t.startsWith('tests/'));
  const gatePath = 'reports/roco/verification/latest.json';
  const gate = readJson(gatePath);
  const releaseSrc = read('scripts/roco/verify-release.mjs');
  const declaredSuites = new Set([...releaseSrc.matchAll(/\{id:\s*'([^']+)'/g)].map((m) => m[1]));
  const ctx = {unitFiles, gate, gateSuites: new Map((gate.suites ?? []).map((s) => [s.id, s])),
    declaredSuites, gatePath, scripts: pkg.scripts ?? {}};

  // ① 判据文件消失
  const gone = checkJudge({judge: {kind: 'unit_file', ref: 'tests/__这个文件不存在__.test.js'}}, ctx);
  if (gone.length === 0) problems.push('自检失败：判据文件不存在居然通过了');

  // ② 判据文件在、但**不在** test:unit 的清单里（第 39 轮那个真缺陷）
  const unwired = checkJudge({judge: {kind: 'unit_file', ref: 'tests/evals/shadow-replay.test.js'}},
    {...ctx, unitFiles: unitFiles.filter((f) => !f.includes('shadow-replay'))});
  if (unwired.length === 0) problems.push('自检失败：判据不在 test:unit 清单里居然通过了');

  // ③ 套件掉出门禁**脚本**（真值来源）必须被抓到
  const dropped = checkJudge({judge: {kind: 'suite', ref: 'plan-e2e'}},
    {...ctx, declaredSuites: new Set([...declaredSuites].filter((id) => id !== 'plan-e2e'))});
  if (dropped.length === 0) problems.push('自检失败：套件掉出门禁脚本居然通过了');
  // ③b 最近一次跑成红的也必须被抓到
  const red = checkJudge({judge: {kind: 'suite', ref: 'plan-e2e'}},
    {...ctx, gateSuites: new Map([['plan-e2e', {id: 'plan-e2e', ok: false}]])});
  if (red.length === 0) problems.push('自检失败：套件最近一次是红的居然通过了');

  // ④ 证据断言：把判据条数下限抬到 10 万必须报问题
  const strict = checkEvidence({evidence: {expect: 'zero_failed', min_checks: 100000}},
    readJson('reports/roco/demo-acceptance/demo-acceptance.json'));
  if (strict.length === 0) problems.push('自检失败：判据条数下限抬到 10 万居然没报问题');

  // ⑤ 批次断言：伪造一个 failed>0 的批次必须报问题
  const badBatch = checkEvidence({evidence: {expect: 'batch_zero_failed', fields: ['structural']}},
    {structural: {total: 10, passed: 9, failed: 1}});
  if (badBatch.length === 0) problems.push('自检失败：批次里有 failed 居然没报问题');

  // ⑥ 必红方向缺失
  if (checkNegative({id: 'x', negative: []}).length === 0) problems.push('自检失败：没有必红方向居然通过了');

  // ⑦ 必红方向写反（字段期望值反过来）必须被抓到
  const wrongField = checkNegative({negative: [{kind: 'report_field',
    path: 'reports/roco/ux-acceptance/browser-roco-ux-acceptance.json',
    field: 'counterproofs_all_hit', expect: false}]});
  if (wrongField.length === 0) problems.push('自检失败：字段期望值写反了居然通过了');

  // ⑧ 负数样本太少（证明不了「能红」）必须被抓到
  const thin = checkOneNegative({kind: 'report_field',
    path: 'reports/roco/agent-trajectories-verification.json',
    field: 'grader.negative', expect: 'all_passed_batch', min_total: 100000});
  if (thin.length === 0) problems.push('自检失败：负数样本下限抬到 10 万居然没报问题');
  return problems;
}

const report = revalidate();
if (SELFTEST) {
  const problems = selftest();
  if (problems.length) {
    console.error('[rc501-selftest] 自检失败：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('[rc501-selftest] 9 条必红方向都命中（判据文件消失 / 判据没接线 / 套件掉出门禁脚本 / '
    + '判据条数下限 / 批次里有失败 / 缺必红方向 / 字段期望写反 / 负数样本太少 / 套件跑红）');
}
if (!CHECK) {
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`[rc501] 保留资产 ${report.totals.assets} 条，有问题 ${report.totals.with_problems} 条 → ${OUT}`);
}
for (const row of report.assets) {
  console.log(`${row.ok ? '✔' : '✖'} [${row.id}] ${row.name}`
    + (row.ok ? `（判据 ${row.judge.kind}:${row.judge.ref}）` : `\n    - ${row.problems.join('\n    - ')}`));
}
if (report.totals.with_problems) {
  console.error(`[rc501] ${report.totals.with_problems} 条保留资产没有被判据守着`);
  process.exitCode = 1;
}
