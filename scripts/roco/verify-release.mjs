#!/usr/bin/env node
// 一次跑完**发布前必须过**的验收，并把「跑了什么、结果是什么」落成产物。
//
// 存在理由（第 24 轮的事故）：浏览器验收有三轮没跑，期间一个静态 `node:*`
// 把页面整条 import 链打断，而 `test:unit` 一直全绿。问题不在某条测试，
// 而在于「哪些套件必须跑」只活在人的记忆里和状态文档的散文里。
// 这个脚本把它变成可执行的一份清单：跑完写 `reports/roco/verification/latest.json`，
// 任何一项失败就非零退出。
//
// 它不是新测试：只是把已有的验收按固定顺序跑一遍并记账。
//
// 跑法::
//
//     node scripts/roco/verify-release.mjs              # 全跑
//     node scripts/roco/verify-release.mjs --quick      # 跳过浏览器（无 Chrome 时用）

import {execFileSync} from 'node:child_process';
import {writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync as gitExec} from 'node:child_process';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'verification');
const OUT = join(OUT_DIR, 'latest.json');
// 最近一次**通过**的那次运行。只有它能在「套件全绿」时被更新。
//
// 为什么需要单独一份：原来只有 `latest.json`，而 `unit` 里有一条断言
// 「最近一次 verify:release 必须是 pass」。于是**一次失败就把闸门永久卡死**——
// 之后每次跑的 `unit` 都会因为上一次是红的而红，而 latest.json 只能靠一次成功的
// 运行变绿，成功的运行又必须先过 `unit`。唯一的出路是手改 latest.json，
// 那正是这个仓库最不该鼓励的动作。现在：
//   · `latest.json`   = 最近一次运行（任何结论），用来回答「刚刚跑得怎么样」；
//   · `last-green.json` = 最近一次**全绿**的运行，用来回答「上一次可信的闸门是什么时候」。
const LAST_GREEN = join(OUT_DIR, 'last-green.json');

/**
 * 清单：`{id, cmd, args, why, quick}`。
 *
 * `why` 写的是**这条为什么必须在清单里**——不是「有这个测试」，而是
 * 「漏跑它会漏掉哪一类错误」。没有 why 的条目不该进来。
 */
export const SUITES = [
  {id: 'env', cmd: 'npm', args: ['run', 'test:env'],
    why: '规则引擎与 Python 服务的不变量；这一层坏了上层全是假的'},
  {id: 'unit', cmd: 'npm', args: ['run', 'test:unit'],
    why: '教练/判定器/轨迹/本地模型/结构契约；单测绿不等于页面能开，下面两条补这一刀'},
  {id: 'bridge', cmd: 'npm', args: ['run', 'test:bridge'],
    why: '桥的隐藏信息边界；这条只在 Node 侧，单测与浏览器都覆盖不到'},
  {id: 'toolbox-roco', cmd: 'npm', args: ['run', 'test:toolbox-roco'],
    why: '工具契约与 roco-client 的逐键镜像；漂了就静默给出错参数'},
  {id: 'plan-e2e', cmd: 'npm', args: ['run', 'test:plan-e2e'],
    why: '真 Python 服务的端到端规划；两边单测都绿而对不上，T02 阶段发生过'},
  {id: 'trajectories', cmd: 'node', args: ['scripts/roco/verify-agent-trajectories.mjs', '--quiet'],
    why: '轨迹集与判定器的两个方向；判定器写坏了只有这里看得见'},
  {id: 'trajectories-model', cmd: 'node',
    args: ['scripts/roco/verify-agent-trajectories.mjs',
      '--trajectories', 'tests/evals/agent-trajectories-model-v1.jsonl', '--quiet'],
    why: 'W4-02 的第二半（模型候选轨迹）：同一把尺子、同一个判定器。'
      + '这一份**不声称字节可复现**（模型重跑会逐条不同），它靠 `model_identity` 钉住；'
      + '结构与离线回放仍然必须全过——模型臂的产物要是格式漂了，模型与规则就没法横向比'},
  {id: 'sft-split', cmd: 'node', args: ['scripts/roco/verify-sft-split.mjs', '--quiet'],
    why: 'SFT 训练数据的切分：家族是否都在训练侧、留出有没有泄漏、'
      + '报告里的自我描述与切分模式是否自洽，以及**逐字节复现**。'
      + '第 37 轮发现报告把「留出机制」描述成「留出模板」，那一类错误只有这条抓得到'},
  {id: 'model-manifest', cmd: 'node', args: ['scripts/model/verify-manifest.mjs'],
    why: '本地权重与登记表是否同一份；换版不校验等于不知道跑的是什么'},
  {id: 'provenance', cmd: 'node', args: ['scripts/roco/verify-provenance.mjs'],
    why: '数据溯源：每条来源有可核对的锚点（归档哈希 / 逐文件清单）、'
      + '逐实体的 provenance 台账完整。「所有数据必须记录来源」这条边界从散文变成检查'},
  {id: 'rag-eval', cmd: 'node', args: ['scripts/roco/eval-rag-retrieval.mjs'],
    why: 'RC-204：RAG 检索的 held-out 评测必须在闸门里跑判据（13 组：覆盖/泄漏/fixture 交集/'
      + '推导出处/弃答一致性/冲突弃答/grounded/版本命中/证据等级/三套基线都报/清单指纹/探针登记/无挂钟）。'
      + '**它报告自己的失败**：~~探针里有 1 条真的没按预期（「冰系被哪些属性克制」按系别标签召回而不是弃答，'
      + '语料里确实没有克制表）~~ —— **2026-09-25 已解决（原话保留）**：语料补上了 L3 属性相性库'
      + '（`types.json` → `type_chart::*` 120 篇），该探针现在**按预期答得出**（top-1 `type_chart::冰系`），'
      + '探针失败数 1→0；旧期望（弃答）逐字留在 held-out 的 `expectation_prior`/`why_prior`/`derivation_prior` 里。'
      + '「保留失败比做过拟合修复更有价值」这条口径不变：这次是**语料变了**，不是把判据改松。'
      + '确定性：两次运行除 metadata.generated_at 外逐字节相同（1.6s）。'
      + '判据的牙在 `unit`（tests/roco-rag-eval.test.js 21 条含 6 条必红反证）。'},
  {id: 'game-data-pack', cmd: 'node', args: ['scripts/roco/verify-game-data-pack.mjs'],
    why: 'RC-202：统一索引包 `data/roco/game-data-pack/v2/pack.json` 必须与 schema 一致、'
      + '逐实体 provenance 的 artifact_sha256 与磁盘对得上、licence_ref 在 sources.yaml 里找得到、'
      + '**REFERENCE_ONLY 不得进 distributable 分节**、unknown_fields 与冻结产物重算一致、'
      + '孤儿引用为 0、冲突未解决时**拒绝 ready**、就绪报告是最新的。'
      + '判据的牙在 `unit` 里（tests/roco-game-data-pack.test.js 16 条含 8 条必红反证）'
      + '以及两条脚本的 `--selftest`（10/10 与 11/11）'},
  {id: 'reconciliation', cmd: 'node', args: ['scripts/roco/verify-reconciliation.mjs', '--gate'],
    why: 'RC-201 §9 第 9 项：公网快照 + 对账产物接进闸门。判据三条 —— ①快照能由**本地 HTML**'
      + '逐字节重抽（不打网，确定性）；②报告的 reconciled/licence_ok 为真且四桶与许可登记齐全；'
      + '③**已提交的报告与"现在重算"一致**（忽略 generated_at），即报告没过期。'
      + '`--gate` 会先跑判据自检（5 条反证：reconciled=false / licence_ok=false / 离线重抽失败 / '
      + '报告过期 / 报告缺失），所以这条套件同时证明「现在是对的」与「错了会被发现」。'
      + '手工触发的对账会静默过期 —— 这条就是防它（本仓库已经吃过一次：'
      + 'agent-trajectories-verification-model.json 声称 1752/1752、实际 1644/1752）'},
  {id: 'sprite-identity', cmd: 'node', args: ['scripts/roco/verify-pet-sprites.mjs'],
    why: '立绘身份：48 槽 × 2 态共 96 张立绘**装的是不是这只精灵的画**。'
      + '2026-09-23 人类报「立绘很多对不上」，查明素材集从第 25 张起整体错位一格'
      + '（槽 25–48 全部显示成下一只的立绘，槽 25「蹦蹦种子」根本没有画）——'
      + '这一层 CSS/JS/规则全都看不见，只有把文件和素材板逐像素对上才发现。'
      + '这条套件核对审计产物 `data/roco/derived/pet-sprite-audit.json` 里记的 sha256 与仓库现状，'
      + '并禁止「已知缺图的槽位偷偷补一张来路不明的图」与「两个槽位指向同一张画」'},
  {id: 'state-doc', cmd: 'node', args: ['scripts/roco/verify-state-doc.mjs'],
    why: '状态文档与现实一致：声明的 HEAD 还在历史里、验证产物在、没有引用不存在的路径。'
      + '第 30 轮的教训是文档能漂，而读它的人会在错的前提上继续做事'},
  {id: 'guard-selftest', cmd: 'node', args: ['scripts/roco/guard-selftest.mjs'],
    why: '注入真实违规，验证登记过的守卫**真的会红**。它逐个改写仓库文件并恢复，'
      + '所以**不能**和并行跑的单测放在一起（会互相读到注入中的文件，'
      + '第 28 轮实测把结构契约搞成偶发红）——只能在这里串行跑'},
  {id: 'browser-acceptance', cmd: 'node', args: ['scripts/roco/browser-acceptance.mjs'],
    why: '**页面真的能开**。第 24 轮的回归只有这条抓得到', quick: true},
  {id: 'demo-acceptance', cmd: 'npm', args: ['run', 'roco:demo-acceptance'],
    why: '无聊天入口的完整演示链路；页面能开但演示链路断了也在这里', quick: true},
  {id: 'mobile-sweep', cmd: 'node', args: ['scripts/roco/browser-mobile-sweep.mjs'],
    why: 'RC-505 移动端验收：**五个公开页面放在同一把尺子下**（390×844 与 360×640 两档）。'
      + '窄屏判据此前散在四个脚本里，没有任何一处回答得了「这一版每一页在手机上都不横向溢出吗」。'
      + '筛选菜单是**打开着**量的（那个状态此前没有判据覆盖，实测真的坏过：浮层把页面撑宽 111px / 140px）。'
      + '带 5 条反证（横向溢出/触控目标/首屏主操作/白屏/控制台报错），反证没命中也算失败'},
  {id: 'box-acceptance', cmd: 'node', args: ['scripts/roco/browser-box-acceptance.mjs'],
    why: 'RC-205 + RC-801 的第一步交接：盒子的个体比较、玩家层与开发者层分界、窄屏版式，'
      + '以及**盒子 → 产品页六槽工作台的交接**（真鼠标点「带上这两只去配队」→ `?team=own-…` → '
      + '工作台预填、开局按钮读到的规模一致、文案如实说还差几只）'},
  {id: 'workshop-acceptance', cmd: 'node', args: ['scripts/roco/browser-workshop-acceptance.mjs'],
    why: 'RC-305/RC-503 的产品判据：六槽工作台（候选宇宙 622、评估随阵容变化、满编五轴）'
      + '与**候选规则下的 Coach 取舍**（并列比较的动作逐条都在引擎合法动作表里、'
      + '未来 2—3 回合、如实标置信/未核验、不出现胜率或百分数）。真实键鼠 + 390px 版式'},
  {id: 'loadout-acceptance', cmd: 'node', args: ['scripts/roco/browser-loadout-acceptance.mjs'],
    why: '人类从第 2 轮点名的**配招（换招）玩家路径**，以及 2026-09-25 的口径「**每个技能都要对准那个精灵**，'
      + '拿不准就去查」：六槽工作台里逐槽打开换招，池子必须是**去问引擎**要来的（优先按持有实例 id 解析物种），'
      + '保存的键用引擎回执的 `pet_id`，并断言**六个槽位各对各的池子**（六只的可学技能数逐只记下、互不串味）；'
      + '再真鼠标选出四个 → 真实请求体 `loadouts` → **引擎回执里那一只带的就是这四个**。'
      + '反面同样量：非法配招由引擎拒（这一层不许自己说了算）。自起 app server 与 Chrome'},
  {id: 'five-minute-chain', cmd: 'node', args: ['scripts/roco/eval-five-minute-chain.mjs'],
    why: 'RC-801 ②③：**把「盒子 → 个体比较 → 锁定 → 补队 → 战斗 → 主动提示 → 展开取舍 → 局末教学」'
      + '当成一条链路量一遍**（此前每一段各自有验收，却没有任何一条量过整条路，也没量过耗时）。'
      + '真键鼠走完全程：总墙钟 ≤ 300s，每一步另有自己的预算（分步预算之和 = 300s，与总预算同源）；'
      + '「主动提示」必须**自己冒出来**（点击日志里在它出现之前没有点过小芽/提示出口）、带「依据：」、'
      + '且在开局后 45s 内；「展开取舍」展开后必须有正文且与浮条那行字不同；结算与回合数只读引擎回执；'
      + '「局末教学」三个字段非空 + 复盘带「依据：」+ 转折回合不超过总回合 + 局末「✦ 小芽」点得开。'
      + '带 16 条必红反证（超一秒 / 缺步 / 一步吃掉别步预算 / 提示被点出来或迟到或没依据 / '
      + '展开是空的或与浮条逐字相同 / 结算不是引擎给的 / 教学字段空或转折回合越界 / 计时器是死的 / 页面报错），'
      + '外加「判据对已知全绿的合成基线必须全绿」的自检。默认自起**离线**服务（这一条链路上没有联网）'},
  {id: 'roco-ux-acceptance', cmd: 'node', args: ['scripts/roco/browser-roco-ux-acceptance.mjs'],
    why: '用户 P0 的第 8 条：**页面看不到或点不动的能力不得仅凭单元测试标记完成**。'
      + '这一条用真实键鼠走一遍翻页 / 筛选 / 选宠 / 行动坞 / 小芽 / 场上事实（印记·能量上限·防御冷却），'
      + '并把 DOM 与引擎的公开视图逐字对齐；每条判据都配一条**必红反证**（反证没命中也算失败）'},
  {id: 'battle-feedback', cmd: 'node', args: ['scripts/roco/browser-battle-feedback-acceptance.mjs'],
    why: '人类 2026-09-24 点名的两件事：**伤害数字要看得见**（不是只有动效）与**出手/受击要有先后**'
      + '（「洛手攻击/动作都有先后，你不要同时做」）。这一条从**页面外面**量，不看客户端自述的任何时间字段：'
      + '页面内挂 `MutationObserver` 记 `performance.now()` 时间线（`.b3-attack`/`data-b3-variant=action`/'
      + '动作立绘 src → `.b3-hit` → `.b3-float` 的加入与移除），再逐帧对浮字中心做 '
      + '`document.elementFromPoint()` —— 被立绘压住时它命中的是 `img.b3-sprite`（这就是人类报的「只有动效没有数字」'
      + '的真根因），只抬 `.b3-fx` 的 z-index 还不够，`pointer-events:none` 会让 hit-test 跳过浮字（复刻页三档实测）。'
      + '带 13 条必红反证（同时播 / 顺序反了 / 被压住 / 没有数字 / 残留 / 看不清 / 命中 spritebox / 没有出手线索 / 层叠复刻'
      + ' / **写死样例数字必须红（R11，2026-09-25 决策 4）** / **框底写死硬横线必须红（R12，决策 1）** 等；'
      + '2026-09-25 起判据 8 条：J7 背包屏数字可追溯 + J8 立绘框底边接缝 ≤6/≤3 两条像素阈值）'
      + '与一份合成健康基线（必须判空数组）；**量不到不算量到**（rect 为 0 或不在视口一律红）。自起 app server 与 Chrome'},
  {id: 'coverage-axes', cmd: 'node', args: ['scripts/roco/verify-coverage-axes.mjs', '--selftest'],
    why: 'RC-403 的**三套支持口径不许混**（数据侧 `effect_support` / 引擎侧特性实现状态 / 实机核验），'
      + '外加一条**抓"账本落后于引擎"**的判据：`data/roco/engine-trait-status.json` 必须覆盖 `traits.py` 登记的'
      + '每一条特性、且它自己那三个档位的计数必须与 `traits.implementation_summary()` 现算一致。'
      + '2026-09-25 实测：`traits.py` 已 17 条（`渴求` FULL、`贪得无厌` PARTIAL），账本却停在 15 条，'
      + '**没有任何一条进闸门的判据会发现**（这个核对脚本此前只在手工跑），三份文档还引着更旧的 `FULL 6 / PARTIAL 2`。'
      + '现在连 `--selftest`（6 条构造必红输入）一起进闸门；判据本身 16 项。'},
  // ⚠ 元套件必须**最后**跑：它自检的是别的套件产出的报告，排前面会读到上一轮的旧报告。
    {id: 'retained-assets', cmd: 'node', args: ['scripts/roco/revalidate-retained-assets.mjs', '--check', '--selftest'],
    why: 'v3 红线：**保留资产不许静默退化**（Agent/RAG/Memory/三角色/game adapter/mock host/'
      + 'stale-result guard/release guard）。这一条不重跑那些判据，而是逐条核对'
      + '「它还有判据吗、判据还接在会跑的入口上吗、产物还在生成吗、怎么才会红」——'
      + '「没红」与「没在跑」在 CI 里长得一样，这一条就是分它们的。带 9 条自检必红方向'},
];

/** 清净的子进程环境：清掉测试运行器自己的变量（见 tests/helpers/subprocess.mjs 的说明）。 */
function childEnv() {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function run(suite) {
  const started = Date.now();
  try {
    const stdout = execFileSync(suite.cmd, suite.args,
      {cwd: ROOT, encoding: 'utf8', timeout: 1800000, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv()});
    return {id: suite.id, why: suite.why, ok: true, ms: Date.now() - started,
      tail: stdout.trim().split('\n').slice(-4).join('\n')};
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    // **失败必须留全量输出**：`latest.json` 只留尾部几行，而「哪个用例红了」通常在中段。
    // 第 81 轮实测踩到：`unit` 在门禁里红、单跑却绿，而尾部只剩栈帧 —— 那是
    // 「有失败但不可诊断」。现在每次失败都落一份完整日志，并在 tail 里写出路径。
    const dir = join(ROOT, 'reports', 'roco', 'verification', 'failures');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let fullLog = null;
    let note = '';
    try {
      mkdirSync(dir, {recursive: true});
      fullLog = join(dir, `${suite.id}-${stamp}.log`);
      writeFileSync(fullLog, `${suite.cmd} ${(suite.args ?? []).join(' ')}\n\n${output}\n`);
      note = `\n[full log] ${relative(ROOT, fullLog)}`;
    } catch (writeError) {
      note = `\n[full log] 写入失败：${writeError?.message ?? writeError}`;
    }
    return {id: suite.id, why: suite.why, ok: false, ms: Date.now() - started,
      full_log: fullLog ? relative(ROOT, fullLog) : null,
      tail: output.split('\n').slice(-12).join('\n') + note};
  }
}

export function runSuites({quick = false, log = () => {}} = {}) {
  const selected = SUITES.filter((suite) => !(quick && suite.quick));
  const rows = [
];
  for (const suite of selected) {
    log(`… ${suite.id}`);
    const row = run(suite);
    rows.push(row);
    log(`  ${row.ok ? '✔' : '✖'} ${suite.id}（${Math.round(row.ms / 1000)}s）`);
  }
  return rows;
}

function main(argv) {
  const quick = argv.includes('--quick');
  const rows = runSuites({quick, log: (line) => process.stdout.write(`${line}\n`)});
  const failed = rows.filter((row) => !row.ok).map((row) => row.id);
  const report = {
    generated_by: 'scripts/roco/verify-release.mjs',
    quick,
    suites: rows.map((row) => ({...row, tail: row.tail.split('\n').slice(0, 4)})),
    failed,
    verdict: failed.length ? 'failed' : 'pass',
    note: '时间戳与耗时是易变字段；这里保留是因为它要回答「哪一次跑的」，'
      + '而稳定的验收产物各自另有落盘位置。',
  };
  mkdirSync(OUT_DIR, {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  if (report.verdict === 'pass') {
    let head = null;
    try {
      head = gitExec('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
    } catch { /* 没有 git 时留 null，报告里能看出来 */ }
    writeFileSync(LAST_GREEN, `${JSON.stringify({
      generated_by: 'scripts/roco/verify-release.mjs',
      quick,
      verdict: 'pass',
      head,
      suites: rows.map((row) => row.id),
      ran_at: new Date().toISOString(),
      note: '只有全部套件通过时才会被写。`latest.json` 可能是红的，这一份一定是绿的。',
    }, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify({verdict: report.verdict, failed,
    ran: rows.map((r) => r.id)}, null, 1)}\n`);
  return failed.length ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
