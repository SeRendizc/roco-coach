// 阵容问句 → 引擎评估 的判据（2026-09-25）。
//
// 背景（改前真机实测）：「帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？」→
// `agentStop: policy-route-without-tools`、**零次调用**，回答「这仨我手头没数据」。
// 而且查下去发现更根上的问题：**页面送来的名单从来没进过证据包**
// （`coachCampContext()` 把 12 只的名字/系别/定位/种族值都送进来了，
//  运行时只把它用在本地模板里，**没有转给模型**）—— 所以那句"没数据"是**真的**。
//
// 这一轮修三处，判据逐个钉：
//   ① **名单进包**：`context.profile.pets` → `packet.roster`；没有 pets 时**不出现**这个键。
//   ② **事实守卫认得名单数字**（与上一轮 `rocoBattle` 同一个坑：守卫不认识新字段 ⇒
//      引用真数据被判成凭空 ⇒ 硬回退成模板「我在。」）。
//   ③ **阵容问句走引擎**：恰好点名三只、且都能在名单里对上 ⇒ `evaluate_team`；多一只/少一只/对不上 ⇒ null。
// 必红反证：① 不带 pets 时 `roster` 不许出现；③ 关掉开关时 `policyFor` 不许要求 `evaluate_team`。

import test from 'node:test';
import assert from 'node:assert/strict';

import {createGame} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {
  runCoach, buildContext, teamAsk, ownTeamClarify, teamLookupEnabled, policyFor, defaultArgsFor,
  withRuntimeStateVersion, checkGroundedAnswer,
} from '../src/coach/runtime.js';
import {validToolArgs} from '../src/coach/toolbox.js';
import {checkReceiptConsistency} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';

const PROFILE = {pets: [
  {id: 'pet_000225', name: '寂灭骨龙', types: ['龙系', '幽系'], stats: {hp: 120, atk: 137}},
  {id: 'pet_000190', name: '潮甲龟', types: ['水系'], stats: {hp: 160, atk: 70}},
  {id: 'pet_000445', name: '芽角鹿', types: ['草系'], stats: {hp: 150, atk: 88}},
  {id: 'pet_000124', name: '棋契陛下', types: ['幻系'], stats: {hp: 140, atk: 99}},
]};
const campContext = () => ({...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp', profile: PROFILE});

test('① 名单进包：带 pets 时原样进 packet.roster，不带时这个键不出现', async () => {
  let withRoster = null;
  await runCoach({
    message: '随便聊聊',
    context: campContext(),
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withRoster = packet; return '嗯。'; }},
  });
  assert.deepEqual(withRoster.roster, PROFILE.pets, '页面送来的名单必须原样进包（不许裁剪成别的形状）');

  let withoutRoster = null;
  await runCoach({
    message: '随便聊聊',
    context: {...buildContext(createGame(), newProfile(), 'fox'), mode: 'camp'},
    memory: freshMemory(),
    provider: {name: 'fake', async generate(packet) { withoutRoster = packet; return '嗯。'; }},
  });
  assert.equal('roster' in withoutRoster, false, '没有名单时不许出现这个键（老路一字不变）');
});

test('② 事实守卫必须认得名单里的数字（否则引用真数据会被判成凭空）', () => {
  const answer = {
    text: '寂灭骨龙 120 血、攻击 137；潮甲龟 160 血。',
    evidence: [], toolTrace: [], publicState: null, latestEvents: [], textFacts: null,
  };
  const without = checkGroundedAnswer({...answer});
  assert.equal(without.valid, false, '不带名单时这些数字必须判成凭空（守卫的原有职责）');
  assert.ok(without.reasons.some((r) => r.startsWith('unsupported-number:120')),
    `理由要点名数字，实际：${JSON.stringify(without.reasons)}`);
  const withRoster = checkGroundedAnswer({...answer, roster: PROFILE.pets});
  assert.equal(withRoster.valid, true,
    `带上名单后这些数字必须可追溯，实际理由：${JSON.stringify(withRoster.reasons)}`);
});

test('③ 阵容问句：恰好三只 ⇒ evaluate_team 的参数就是那三只的 id', () => {
  const q = '帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？';
  assert.deepEqual(teamAsk(q, {profile: PROFILE}).map((h) => h.id),
    ['pet_000225', 'pet_000190', 'pet_000445']);
  assert.deepEqual(defaultArgsFor('evaluate_team', {profile: PROFILE}, q),
    {team: ['pet_000225', 'pet_000190', 'pet_000445']});
  // 运行时补上 state_version 之后必须能过合同校验（否则工具根本发不出去）。
  assert.equal(validToolArgs('evaluate_team',
    withRuntimeStateVersion('evaluate_team', defaultArgsFor('evaluate_team', {profile: PROFILE}, q), {profile: PROFILE})), true);
});

test('③b 多一只、少一只、没点名、名字对不上 —— 一律 fail closed', () => {
  const ctx = {profile: PROFILE};
  assert.equal(teamAsk('寂灭骨龙、潮甲龟、芽角鹿、棋契陛下这四只怎么样？', ctx), null, '四只不许猜三只');
  assert.equal(teamAsk('寂灭骨龙、潮甲龟这两只怎么样？', ctx), null, '两只不够');
  assert.equal(teamAsk('我这三只搭不搭？', ctx), null, '没点名就不许替玩家挑');
  assert.equal(teamAsk('喷火龙、皮卡丘、杰尼龟这三只怎么样？', ctx), null, '名字对不上名单');
  assert.equal(teamAsk('寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？', {profile: {pets: []}}), null, '名单为空');
});

test('③c 开关：off 时政策与改动前一致，on 时才要求 evaluate_team', () => {
  const q = '帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？';
  assert.equal(teamLookupEnabled({}), true, '2026-09-25 起默认**开**（不设变量 = 开）');
  assert.equal(teamLookupEnabled({ROCO_TEAM_LOOKUP: '0'}), false, '显式 "0" 才算关');
  const before = process.env.ROCO_TEAM_LOOKUP;
  try {
    process.env.ROCO_TEAM_LOOKUP = '0';
    assert.equal(policyFor(q, {profile: PROFILE}).need, null, '关档时必须与改动前一样（不调工具）');
    process.env.ROCO_TEAM_LOOKUP = '1';
    assert.equal(policyFor(q, {profile: PROFILE}).need, 'evaluate_team', '开档时必须交给引擎评估');
    // 对照组：寒暄照旧不调工具。
    assert.equal(policyFor('你好小芽', {profile: PROFILE}).need, null);
  } finally {
    if (before === undefined) delete process.env.ROCO_TEAM_LOOKUP;
    else process.env.ROCO_TEAM_LOOKUP = before;
  }
});

const SIX = [
  {id: 'pet_000012', name: '铠甲虫'}, {id: 'pet_000062', name: '音速犬'},
  {id: 'pet_000100', name: '仪式巨像'}, {id: 'pet_000124', name: '化蝶'},
  {id: 'pet_000118', name: '皇家狮鹫'}, {id: 'pet_000190', name: '雪影娃娃'},
];

test('④ 「我这队」：引擎声明过的规模（3/6）直接评，其它规模**追问**而不是替玩家挑', () => {
  // 2026-09-25（人类：「我这六只怎么样」问不出来）：引擎现在按登记表里各模式声明的规模收队伍
  // （`team.declared_team_sizes()` = 2/3/6，`pvp-standard-six-pet` 就是 6）⇒ 六只阵容**不再追问**，
  // 直接拿整份名单去评估。只有**不在登记表里的规模**（4/5 只）才追问 —— 那时玩家可以挑三只出来评。
  const three = SIX.slice(0, 3);
  assert.deepEqual(teamAsk('帮我评一下我这队', {profile: {lineup: three}}).map((h) => h.id),
    ['pet_000012', 'pet_000062', 'pet_000100']);
  assert.equal(ownTeamClarify('帮我评一下我这队', {profile: {lineup: three}}), null, '三只时不该追问');

  // 六只：**声明过的规模** ⇒ 直接用整份名单评估（原来这里是"必须走追问"）。
  const six = teamAsk('帮我评一下我这队', {profile: {lineup: SIX}});
  assert.equal(six?.length, 6, '六只是引擎声明过的规模，直接评，不许再追问');
  assert.deepEqual(six.map((h) => h.id), SIX.map((p) => p.id));
  assert.equal(ownTeamClarify('帮我评一下我这队', {profile: {lineup: SIX}}), null,
    '六只时不该追问了（引擎支持六只评估）');

  // 4 只（不在登记表里的规模）：**不许**替他挑 —— teamAsk 返回 null，交给追问分支。
  const four = SIX.slice(0, 4);
  assert.equal(teamAsk('帮我评一下我这队', {profile: {lineup: four}}), null,
    '四只不是任何模式声明的规模，不许挑三只去评');
  assert.equal((ownTeamClarify('帮我评一下我这队', {profile: {lineup: four}}) || []).length, 4,
    '四只时必须走追问');

  // 不是"评"的问法（只是问都有谁）不该触发追问。
  assert.equal(ownTeamClarify('我这六只都有谁？', {profile: {lineup: SIX}}), null,
    '只问"都有谁"不需要追问三只');
});

test('④b 选中里有点名但解析不出 id 的 ⇒ fail closed（不许拿猜的 id 去评估）', () => {
  const lineup = [{id: 'pet_000012', name: '铠甲虫'}, {name: '重名的那只'}, {id: 'pet_000100', name: '仪式巨像'}];
  assert.equal(teamAsk('帮我评一下铠甲虫、重名的那只、仪式巨像这三只', {profile: {lineup}}), null,
    '三只里有一只没有物种 id 时不许提交评估');
  assert.equal(ownTeamClarify('帮我评一下我这队', {profile: {lineup}}), null, '正好三只（即便有只没 id）也不追问');
});

test('④c 两支不许打架：已经点名三只时，「追问」必须让位给「评估」', () => {
  // 实测踩到：消息里的「这三只」同时命中 `OWN_TEAM_ASK` 与点名匹配，
  // 于是"帮我评一下 A、B、C 这三只"被追问分支截胡（工具一次都没调）。
  const ctx = {profile: {lineup: SIX}};
  const q = '帮我评一下铠甲虫、音速犬、仪式巨像这三只';
  assert.equal((teamAsk(q, ctx) || []).length, 3, '点名三只必须能解析');
  assert.equal(ownTeamClarify(q, ctx), null, '已经点名三只时不许追问');
  // 反方向（2026-09-25 改口径）：没点名 + 名单规模**不在登记表里**（4 只）⇒ 必须追问；
  // 而 6 只（`pvp-standard-six-pet` 声明过）**直接评**，不再追问。
  const four = {profile: {lineup: SIX.slice(0, 4)}};
  assert.equal(teamAsk('帮我评一下我这队', four), null, '四只不是声明过的规模，不许猜三只');
  assert.equal((ownTeamClarify('帮我评一下我这队', four) || []).length, 4, '四只必须追问');
  assert.equal((teamAsk('帮我评一下我这队', ctx) || []).length, 6, '六只是声明过的规模：直接评');
  assert.equal(ownTeamClarify('帮我评一下我这队', ctx), null, '六只不再追问');
});

test('⑤ 回执里已经有评估结论时，正文不许说"我评不了"（一次假话都不许有）', () => {
  // 实测抓到一次：工具调成功了、回执里有完整评估，正文却写
  // 「这三只我暂时评不了——本机没有它们的对战记录…」。玩家会直接读成"小芽不行"。
  const okReceipt = [{tool: 'evaluate_team', args: {team: ['pet_000012', 'pet_000062', 'pet_000100']},
    result: {ok: true, features: [], strengths: [], weaknesses: []}}];
  const deny = checkReceiptConsistency({
    text: '这三只我暂时评不了——本机没有它们的对战记录，也没有可靠的属性、技能数据。',
    toolTrace: okReceipt});
  assert.equal(deny.consistent, false, '有成功回执却说评不了 —— 必须判不一致');
  assert.ok(deny.reasons.includes('denied-available-receipt:evaluate_team'));
  // 反方向一：正常引用回执的回答不许被误伤。
  assert.equal(checkReceiptConsistency({
    text: '这三只职责挺全：输出、承伤、控制、回复都有，但被九种属性克制。', toolTrace: okReceipt}).consistent, true);
  // 反方向二：说的是**别的事**的否定（比如对手待执行动作看不到）不许被误伤。
  assert.equal(checkReceiptConsistency({
    text: '这一局我看不到对手的待执行动作。', toolTrace: okReceipt}).consistent, true);
  // 反方向三：回执本身是失败的（工具没跑成）时，说"评不了"是**实话**，不许判红。
  assert.equal(checkReceiptConsistency({
    text: '这三只我暂时评不了，工具没跑通。',
    toolTrace: [{tool: 'evaluate_team', args: {}, result: {ok: false, error_type: 'unavailable'}}]}).consistent, true);
});
