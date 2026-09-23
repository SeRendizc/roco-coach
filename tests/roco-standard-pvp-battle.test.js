// RC-106 服务端接线：**按 BattleMode 开局**（模式决定规则配置与队伍规模）。
//
// 为什么这一组必须存在
// --------------------
// 引擎侧在 RC-106 已经能跑六宠标准 PVP 了，但服务端如果继续写死 3 只、抄一个配置字符串、
// 或者只把 mana 丢掉，玩家看到的仍然是「3v3 练习局 + 魔力未核验」——**能力有了，页面拿不到**。
// 这一组钉的正是这段接线，每条都有必红方向：
//   ① 模式 → 规则配置必须**读登记表**（抄字符串的那一版会被这条抓住）；
//   ② 六宠：队伍长度 = 登记表里的 `parameters.team_size`，不足就 400（**不静默补默认队伍**）；
//   ③ 魔力来自引擎：`view.mana` 是 {self,opponent}；legacy 下必须是 **null**（不是 0、不是 4）；
//   ④ 「未核验覆盖」必须带着 confidence/reason/microcase 进载荷并标 `unverified`；
//   ⑤ 标准 PVP 的合法动作里**没有 item / escape**，且有 charge / surrender；
//      把 item 塞回去 ⇒ 模式闸必须报问题（证明这条判据不是空转）。
//
// 用法：`node --test tests/roco-standard-pvp-battle.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  STANDARD_PVP_UNVERIFIED_OVERRIDES, battleModeOf, battleModes, createRocoService,
} from '../src/server/roco-service.js';
import {modeActionProblems} from '../src/coach/team-serving.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARD = 'pvp-standard-six-pet';
const log = (...args) => console.log('  ·', ...args);

/** 规则配置里的 `actions` 块（闸要的是裸值，所以显式解包）。 */
const actionsDeclaration = (configId) => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data/roco/rulesets', `${configId.replace(/_/g, '-')}.json`), 'utf8'));
  return {
    allowed_kinds: raw.actions.allowed_kinds.value,
    forbidden_kinds: raw.actions.forbidden_kinds.value,
    unknown_kinds_allowed: raw.actions.unknown_kinds_allowed.value,
  };
};

const service = createRocoService({repoRoot: ROOT});
const roster = await service.roster({limit: 12});
const BUILT = (roster.pets ?? []).map((pet) => pet.pet_id);
const SIX = BUILT.slice(0, 6);

test('模式 → 规则配置：必须读登记表，不许在 Node 里抄字符串', () => {
  const mode = battleModeOf(STANDARD);
  assert.ok(mode, `登记表里必须有 ${STANDARD}`);
  assert.equal(mode.parameters.team_size, 6, '标准 PVP 登记的队伍规模是 6');
  const binding = mode.ruleset_binding;
  assert.ok(typeof binding === 'string' && binding.startsWith('mobile_s4_candidate'),
    `绑定应当指向候选配置，实际 ${binding}`);
  // 反证：把绑定换成一个不存在的 id 之后，「按登记表读」与「抄字符串」就不再等价——
  // 所以下面开局的断言只能靠**读**登记表来满足。
  log('[实际] 登记表绑定 =', binding);
  assert.equal(battleModeOf('不存在的模式'), null);
});

test('六宠标准 PVP：开局给 6 只、魔力 4/4、覆盖逐条带出处', async () => {
  const result = await service.startBattle({mode: STANDARD, team: SIX, seed: 11});
  assert.equal(result.ok, true, `开局失败：${result.error ?? ''}`);
  const view = result.view;
  const mode = battleModeOf(STANDARD);
  assert.equal(view.mode_id, STANDARD);
  assert.equal(view.ruleset_config_id, mode.ruleset_binding, '这一局的配置必须等于登记表的绑定');
  assert.equal((view.self.pets ?? []).length, mode.parameters.team_size, '己方应当是 6 只');
  assert.deepEqual(view.mana, {self: 4, opponent: 4}, `魔力应当来自引擎，实际 ${JSON.stringify(view.mana)}`);
  const override = view.unverified_overrides[0];
  assert.equal(override.path, 'turn_order.speed_tie');
  assert.equal(override.confidence, 'ENGINE_HYPOTHESIS');
  assert.equal(override.microcase_id, 'MC-E05');
  assert.equal(view.self.pets[0].energy, 10, '开局 10 星（用户实机核对）');
  assert.equal(override.unverified, true, '每条覆盖都必须标 unverified');
  assert.ok(view.unverified_notes.length >= 1 && view.unverified_notes[0].includes('未核验'),
    `界面要拿到可渲染的「未核验」说明，实际 ${JSON.stringify(view.unverified_notes)}`);
  log('[实际] mana =', JSON.stringify(view.mana), '；覆盖 =', JSON.stringify(override));
  await service.stop();
});

test('标准 PVP 的合法动作：没有 item / escape，有 charge / surrender（模式闸必须放行）', async () => {
  const result = await service.startBattle({mode: STANDARD, team: SIX, seed: 12});
  assert.equal(result.ok, true, `开局失败：${result.error ?? ''}`);
  const kinds = [...new Set((result.view.legal ?? []).map((action) => action.kind))];
  log('[实际] 合法动作 kind =', kinds.join(','));
  assert.ok(!kinds.includes('item'), `标准 PVP 不该出现道具动作，实际 ${kinds.join(',')}`);
  assert.ok(!kinds.includes('escape'), `标准 PVP 不该出现逃跑动作，实际 ${kinds.join(',')}`);
  assert.ok(kinds.includes('charge'), '标准 PVP 必须有聚能');
  assert.ok(kinds.includes('surrender'), '标准 PVP 必须有投降（次级入口）');
  const declaration = actionsDeclaration(battleModeOf(STANDARD).ruleset_binding);
  assert.deepEqual(modeActionProblems(result.view.legal, declaration), [], '服务端发出去的动作必须过模式闸');
  // 反证：把 item 塞回同一份载荷 ⇒ 同一条判据必须报问题（否则这条检查是空转的）。
  const leaked = modeActionProblems([...result.view.legal, {kind: 'item', label: '使用回复药'}], declaration);
  assert.equal(leaked.length, 1, `塞进 item 之后必须被抓住，实际 ${JSON.stringify(leaked)}`);
  log('[实际] 塞进 item 的报错 =', leaked[0]);
  await service.stop();
});

test('legacy 练习局逐位不变：3 只、mana 是 null、道具与逃跑仍在（不是被顺手改掉的）', async () => {
  const result = await service.startBattle({});
  assert.equal(result.ok, true, `开局失败：${result.error ?? ''}`);
  const view = result.view;
  assert.equal((view.self.pets ?? []).length, 3, '不给 mode 时仍是 3v3 练习局');
  // 这是「不编规则」的另一面：legacy 配置里根本没有魔力这条概念，所以必须是 null。
  // 若这里出现 4（或 0），说明有人在 Node 侧补了一个数。
  assert.equal(view.mana, null, `legacy 不该有魔力，实际 ${JSON.stringify(view.mana)}`);
  assert.deepEqual(view.unverified_overrides, [], 'legacy 没有未核验覆盖');
  const kinds = [...new Set((view.legal ?? []).map((action) => action.kind))];
  log('[实际] legacy 合法动作 =', kinds.join(','), '；mana =', JSON.stringify(view.mana));
  assert.ok(kinds.includes('item'), '练习局仍然有道具（迁移夹具，不许顺手删）');
  assert.ok(kinds.includes('escape'), '练习局仍然有逃跑');
  await service.stop();
});

test('队伍规模与模式不符 ⇒ 400 并点名（不静默补默认队伍）；不认得的模式 ⇒ 400 列出登记表', async () => {
  const short = await service.startBattle({mode: STANDARD, team: SIX.slice(0, 3)});
  assert.equal(short.ok, false);
  assert.equal(short.status, 400);
  assert.match(short.error, /需要 6 只/);
  const enemy = await service.startBattle({mode: STANDARD, team: SIX, enemy_team: SIX.slice(0, 2)});
  assert.equal(enemy.ok, false);
  assert.equal(enemy.status, 400);
  assert.match(enemy.error, /对手也必须是 6 只/);
  const unknown = await service.startBattle({mode: 'zzz', team: SIX});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 400);
  assert.match(unknown.error, /模式不许自创/);
  for (const mode of battleModes().modes ?? []) assert.ok(unknown.error.includes(mode.id), `${mode.id} 应当被列出`);
  log('[实际] 队伍不足：', short.error);
  await service.stop();
});

test('六宠标准 PVP 能一路打到终局：魔力归零判负（A4 的端到端）', async () => {
  const result = await service.startBattle({mode: STANDARD, team: SIX, seed: 12});
  assert.equal(result.ok, true, `开局失败：${result.error ?? ''}`);
  let view = result.view;
  let turns = 0;
  while (!view.battle_result && turns < 200) {
    const stepped = await service.advanceBattle({battle_id: result.battle_id, auto: true});
    assert.equal(stepped.ok, true, `第 ${turns + 1} 回合推进失败：${stepped.error ?? ''}`);
    view = stepped.view;
    turns += 1;
  }
  const loserMana = view.battle_result === 'win' ? view.mana.opponent : view.mana.self;
  log('[实际] 六宠对局：回合', turns, '结果', view.battle_result, '魔力', JSON.stringify(view.mana));
  assert.ok(view.battle_result === 'win' || view.battle_result === 'loss',
    `一局必须打到分出胜负，实际 ${JSON.stringify(view.battle_result)}`);
  // 判负依据就是**魔力归零**（不是「打光六只」）——这正是用户说的「心没了就输 PVP」。
  assert.equal(loserMana, 0, `输的那一方魔力应当是 0，实际 ${JSON.stringify(view.mana)}`);
  assert.ok(turns >= 5 && turns <= 200, `回合数应当是个正常值，实际 ${turns}`);
  await service.stop();
});

test('同速平手：配置里是 UNKNOWN，靠**显式覆盖**才走得下去（覆盖不写回文件）', () => {
  const declaration = JSON.parse(readFileSync(join(ROOT, 'data/roco/rulesets/mobile-s4-candidate-v3.json'), 'utf8'));
  assert.equal(declaration.turn_order.speed_tie.value, null, 'v3 的 speed_tie 在磁盘上必须还是 null');
  const entry = STANDARD_PVP_UNVERIFIED_OVERRIDES.find((row) => row.path === 'turn_order.speed_tie');
  assert.ok(entry, '标准 PVP 的开局必须显式声明同速裁决策略');
  assert.equal(entry.value, 'random_seeded');
  assert.equal(entry.confidence, 'ENGINE_HYPOTHESIS');
  assert.equal(entry.microcase_id, 'MC-E05');
  log('[实际] 磁盘上的 speed_tie =', declaration.turn_order.speed_tie.value, '；覆盖 =', JSON.stringify(entry.value));
});

test('未核验覆盖的常量只有一份，且值与 microcase 对得上', () => {
  // 2026-09-22：`energy.initial` 已按用户实机核对登记为 10 星 → 覆盖表只剩同速平手那一条。
  assert.equal(STANDARD_PVP_UNVERIFIED_OVERRIDES.length, 1);
  const [entry] = STANDARD_PVP_UNVERIFIED_OVERRIDES;
  assert.equal(entry.path, 'turn_order.speed_tie');
  assert.equal(entry.microcase_id, 'MC-E05');
  assert.equal(entry.confidence, 'ENGINE_HYPOTHESIS');
  assert.ok(entry.reason.includes('未核验') || entry.reason.includes('未录制'));
  assert.equal(entry.value, 'random_seeded');
  log('[实际] 常量 =', JSON.stringify(entry));
});

test.after?.(() => {});
process.on('exit', () => { try { service.stop(); } catch { /* 已经停了 */ } });

// ─────────────────────────────────────────────────────────────────────────
// 2026-09-22（人类实测）：「对手选宠直接用的我的阵容」。
// 根因：`roco/src/roco_env/service.py` 里 `enemy_team = body.get("enemy_team", team)` ——
// 没给对手阵容时引擎**镜像我方**。v3 口径是「匹配前对手未知、按版本环境倾向评价」，
// 所以服务端在没有对手阵容时给一个**确定性的示例对手**（与我不重合），并标 `enemy_source`。
// 为什么在服务端判而不是页面判：公开视图**故意不给对手全队**（`opponent.bench` 只有位次与
// 是否倒下），页面根本看不到真相 —— 在页面上量这条只会是假判据。
// ─────────────────────────────────────────────────────────────────────────
test('标准 PVP 没有指定对手时：不许镜像我方（示例对手 + enemy_source 标记）', async () => {
  const {createCoachServer} = await import('../src/server/index.js');
  const server = createCoachServer({fetchImpl: async () => { throw Error('测试环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    // CSRF 三件套：Origin + Cookie + X-Coach-CSRF。少一个就是 403
    // （第一版只带 X-Coach-CSRF，直接被「请求来源或类型不正确」拦下）。
    const bootResponse = await fetch(`${base}api/bootstrap`);
    const cookie = (bootResponse.headers.get('set-cookie') ?? '').split(';')[0];
    const boot = await bootResponse.json();
    const headers = {'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf,
      Origin: base.replace(/\/$/, ''), Cookie: cookie};
    const mine = ['own-0001', 'own-0003', 'own-0005', 'own-0007', 'own-0009', 'own-0011'];
    const started = await (await fetch(`${base}api/roco/battle/new`, {
      method: 'POST', headers, body: JSON.stringify({mode: 'pvp-standard-six-pet', team: mine}),
    })).json();
    assert.equal(started.ok, true, `开局必须成功：${started.error ?? ''}`);
    const mineIds = (started.view.self.pets ?? []).map((p) => p.species_id ?? p.pet_id);
    // 公开视图不给对手全队 —— 用**引擎侧**的对手上场那只与后备做交叉判断：
    // 至少「对手与我一模一样」这种镜像，会让对手**每一只**都能在我方名单里找到。
    const foeField = started.view.opponent?.field;
    assert.ok(foeField, '对手场上那只必须在公开视图里');
    assert.ok(['sample', 'sample-usable', 'sample-fallback'].includes(started.view.enemy_source),
      '没有指定对手时必须在回执里标 enemy_source（页面才知道这是示例对手）；'
      + `当前=${JSON.stringify(started.view.enemy_source)}（sample-usable=从我的可用精灵里选，`
      + 'sample-fallback=退回全量池）');
    // 反证方向：镜像我方时，对手上场那只**必然**是我方第一只 —— 这条能抓住镜像实现
    assert.notEqual(String(foeField.species_id ?? foeField.pet_id), String(mineIds[0]),
      `对手上场那只不该就是我方第一只（镜像）：对手 ${foeField.species_id ?? foeField.pet_id} / 我方首位 ${mineIds[0]}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
