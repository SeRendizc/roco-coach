// RC-802 的四类判据（ruleset / support / latency / digest）：合成基线全绿 + 逐类反证必红。
//
// 判据本体在 `scripts/roco/dev-drawer-checks.mjs`（浏览器套件与这里共用同一份）。
// 为什么单测也要有：这四类的**真值**都在回执里，浏览器套件要跑一局、还要拉起本机小模型；
// 单测用合成事实把"写死样例 / 拿别的数顶上 / 没跑也显示耗时"这三类造假方式逐条钉死，
// 于是浏览器那一侧只剩"真页面上的值 == 真回执"这一件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rulesetProblems, registryProblems, latencyProblems, digestProblems} from '../scripts/roco/dev-drawer-checks.mjs';

const REGISTRY = {id: 'pvp-standard-six-pet', engine: {team_size: 3}, parameters: {team_size: 6},
  unknowns_count: 4, prematch: {visibility: 'UNKNOWN_PREMATCH'}};
const baseline = () => ({
  engineRulesetId: 'roco-world-s4-2026-09-10', engineStateVersion: 31,
  // H4 改钉（2026-10-01；原基线逐字留档）：rulesetText: 'roco-world-s4-2026-09-10 · 本局状态版本 31',
  rulesetText: 'roco-world-s4-2026-09-10 · 本局已收到 31 次局面更新',
  registry: REGISTRY, modeRawText: JSON.stringify(REGISTRY, null, 1),
  modeProbeText: '引擎当前生效规模 3 只 · 注册表登记规模 6 只（不一致：对局开始前引擎是练习局配置，'
    + '标准 PVP 会按注册表的六只开）；注册表登记的未核实项：4 条；prematch.visibility = UNKNOWN_PREMATCH',
  panelText: '规则引擎（真值来源） 本机小模型（只提议工具） 耗时 812 ms · 提示摘要 9f2c1ab4d7e0…',
  receiptAvailable: true, receiptLatencyMs: 812, receiptDigestPin: '9f2c1ab4d7e05566aabbcc',
});

test('RC-802 四类判据：合成基线必须全绿（判据不是空的）', () => {
  const f = baseline();
  assert.deepEqual(rulesetProblems(f), []);
  assert.deepEqual(registryProblems(f), []);
  assert.deepEqual(latencyProblems(f), []);
  assert.deepEqual(digestProblems(f), []);
});

test('RC-802 反证：写死的样例 / 拿别的数顶上 / 没跑也显示 —— 逐条必须红', () => {
  // ① ruleset：只写 id（写死的样例）、或版本号对不上
  // H4 改钉（原断言逐字留档）：rulesetText: 'roco-world-s4-2026-09-10' ⇒ 「没有本局状态版本」
  assert.ok(rulesetProblems({...baseline(), rulesetText: 'roco-world-s4-2026-09-10'}).length > 0,
    '只写规则集 id（没有局面更新次数）必须红');
  // H4 改钉（原断言逐字留档）：rulesetText: 'roco-world-s4-2026-09-10 · 本局状态版本 30' ⇒ 「状态版本对不上」
  assert.ok(rulesetProblems({...baseline(), rulesetText: 'roco-world-s4-2026-09-10 · 本局已收到 30 次局面更新'}).length > 0,
    '局面更新次数对不上必须红');
  // H4 新增反证：旧措辞（内部术语「本局状态版本」）在新口径下**也必须红** ——
  // 否则"改词"会变成一条后门：页面写回内部术语，判据照样绿。
  assert.ok(rulesetProblems({...baseline(), rulesetText: 'roco-world-s4-2026-09-10 · 本局状态版本 31'}).length > 0,
    '旧措辞「本局状态版本」必须红（H4 之后就它算不合口径）');
  assert.ok(rulesetProblems({...baseline(), engineStateVersion: null}).length > 0, '读不到版本必须红（不许当没看见）');
  // ② support：注册表改一个字段、或摘要里的数字对不上
  assert.ok(registryProblems({...baseline(), modeRawText: JSON.stringify({...REGISTRY, unknowns_count: 3})}).length > 0,
    '注册表原文与 /api/roco/status 不一致必须红');
  assert.ok(registryProblems({...baseline(), modeRawText: 'not json'}).length > 0, '原文不是 JSON 必须红');
  assert.ok(registryProblems({...baseline(), modeProbeText: '引擎当前生效规模 6 只 · 注册表登记规模 6 只'}).length > 0,
    '摘要里的规模与注册表对不上必须红');
  // ③ latency：页面写死一个耗时、或本地模型没跑成却显示耗时
  assert.ok(latencyProblems({...baseline(), panelText: baseline().panelText.replace('812', '12')}).length > 0,
    '耗时与回执不一致（写死样例）必须红');
  assert.ok(latencyProblems({...baseline(), receiptAvailable: false}).length > 0,
    '本地模型没跑成却显示耗时必须红');
  assert.ok(latencyProblems({...baseline(), receiptLatencyMs: null}).length > 0, '回执里没有耗时必须红');
  // ④ digest：摘要与 pin 前 12 位不一致
  assert.ok(digestProblems({...baseline(), receiptDigestPin: 'deadbeefcafe0000'}).length > 0,
    '提示摘要与回执不一致必须红');
  assert.ok(digestProblems({...baseline(), receiptDigestPin: 'short'}).length > 0, 'pin 太短取不出 12 位必须红');
});

// ── H4（2026-10-01，Lead 批准的改钉清单第 5 条）：页面那一句必须是人话，且值仍来自回执 ──
test('H4：页面真写给 #about-ruleset 的那一句不含内部术语，且仍过 rulesetProblems', () => {
  // 「真渲染」取法沿用本仓既有约定（`tests/roco-page-ux.test.js` / `roco-standard-pvp-battle.test.js`）：
  // 从**真源码**里把那一行抠出来执行 —— 不重写一份句子，免得判据与页面各说一套。
  const raw = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  // 先剥注释：那一行的**旧写法逐字留档**在注释里（改钉不删），不剥就会先匹配到注释里的旧句。
  const code = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = /aboutVersion\.textContent = (.+?);/.exec(code);
  assert.ok(hit, 'roco.js 里必须有给 #about-ruleset 赋值的那一行（抽不出来 ⇒ 这条判据已经失效）');
  const render = (view) => new Function('view', `return ${hit[1]};`)(view);
  const view = {ruleset_id: 'roco-world-s4-2026-09-10', state_version: 31};
  const shown = render(view);
  // ① 人话：不许出现内部字段名、内部术语，也不许把**事件计数**说成回合
  assert.doesNotMatch(shown, /state_version|本局状态版本|回合/,
    `玩家可见文本里不许出现内部术语/回合：${shown}`);
  // ② 含 id 与次数（换值必须跟着变 —— 这就证明它不是写死的样例）
  assert.ok(shown.includes(view.ruleset_id), `要含引擎给的规则集 id：${shown}`);
  assert.ok(shown.includes(String(view.state_version)), `要含引擎给的次数：${shown}`);
  assert.notEqual(render({...view, state_version: 32}), shown, '次数变了句子必须跟着变（否则就是写死的样例）');
  // ③ 这一句喂给 RC-802 的判据必须过（换词不许把「值来自回执」这个意图丢掉）
  const facts = {...baseline(), rulesetText: shown};
  assert.deepEqual(rulesetProblems(facts), [], `页面真句必须过 rulesetProblems：${shown}`);
  // ④ 反证：把页面那句改回旧措辞 ⇒ 同一条判据必须红（这是 H4 的"改坏必红"那一半）
  const old = 'roco-world-s4-2026-09-10 · 本局状态版本 31';
  assert.ok(rulesetProblems({...facts, rulesetText: old}).length > 0, '旧措辞必须红');
  assert.match(rulesetProblems({...facts, rulesetText: old})[0], /引擎回执是/, '红因要能看出"与回执对不上"');
});
