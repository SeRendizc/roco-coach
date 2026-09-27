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
  STANDARD_PVP_UNVERIFIED_OVERRIDES, battleModeOf, battleModes, createRocoService, weatherLine, publicView,
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
  // 2026-09-23：引擎的公开视图多了 `pool`（这一局每人几颗心）——它是**规则常量**，
  // 页面的掉心动效靠它把「掉了的」画成空心 ♡（与 `energy_max` 同一性质，都是公开事实）。
  // 三个数都来自引擎；把 `pool` 去掉或另写一个数，这条会红。
  assert.deepEqual(view.mana, {self: 4, opponent: 4, pool: 4},
    `魔力应当来自引擎，实际 ${JSON.stringify(view.mana)}`);
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

// ─────────────────────────────────────────────────────────────────────────
// 自由动作的 **API 边界**（2026-09-25，人类口径「愿力强化不占行动、背包物品都不占行动」）
//
// 为什么断在**这一层**：真正拒绝的地方是 Python 服务层
// （`roco/src/roco_env/service.py`：这份配置声明了「不占行动」时，`/battle/advance` 不接受把 magic
// 当成这一手交上来，回 `_bad_request("…请走 POST /battle/free…")` ⇒ HTTP 400），
// 而**页面唯一会走的是 Node 路由** `/api/roco/battle/advance`（`src/server/roco-service.js` 的
// `advanceBattle` 对失败**硬编码** `status:400`，`src/server/index.js` 尊重回执里的 status）。
// Python 侧已有同语义判据（`test_service_boundary_refuses_a_free_action_as_the_turn_action`），
// 这一条补的是 **Node 层**：同一个 action 打 `/api/roco/battle/advance` ⇒ **400 且正文点名
// `/battle/free`**（只断路径子串，不绑整句措辞/字段名）；而 `/api/roco/battle/free` 自己
// ⇒ **200 且 `turn` 不变、`legal` 里仍有 `kind:'skill'`**。
// 判据本体是**纯函数**：真跑与两条必红反证**共用同一份**（反证没命中也算失败）。
// ─────────────────────────────────────────────────────────────────────────

/** 纯函数判据：两条 HTTP 回执 → problems[]。
 *
 * 输入：`{free, advance, turnBefore}`，`free`/`advance` = `{status, text, body}`。
 * 「量不到一律判红」：拿不到回执、拿不到 magic 动作都不算验过。 */
function freeActionBoundaryProblems({free, advance, turnBefore}) {
  const bad = [];
  if (!free) return ['自由动作那条回执没拿到（采样失败 ⇒ 读不到就不算验过）'];
  if (free.status !== 200) {
    bad.push(`POST /api/roco/battle/free 应当 200，实际 ${free.status}：${String(free.text ?? '').slice(0, 120)}`);
  }
  if (free.body?.ok !== true) bad.push(`/battle/free 回执 ok 必须是 true，实际 ${JSON.stringify(free.body?.ok)}`);
  if (free.body?.view?.turn !== turnBefore) {
    bad.push(`自由动作**不许**推进回合：之前 turn=${turnBefore}，之后 turn=${JSON.stringify(free.body?.view?.turn)}`);
  }
  const skills = (free.body?.view?.legal ?? []).filter((a) => a.kind === 'skill');
  if (skills.length === 0) bad.push('自由动作之后这一手仍然要能出技能（回执 legal 里必须有 kind=skill）');
  if (!advance) return [...bad, '把它当这一手交上去那条回执没拿到（采样失败）'];
  if (advance.status !== 400) {
    bad.push(`把它当这一手打 /battle/advance 必须 400，实际 ${advance.status}（放行就会让玩家白搭一个回合）`);
  }
  if (advance.body?.ok !== false) {
    bad.push(`/battle/advance 被拒时 ok 必须是 false，实际 ${JSON.stringify(advance.body?.ok)}`);
  }
  if (!String(advance.text ?? '').includes('/battle/free')) {
    bad.push(`拒绝理由必须**点名** /battle/free（玩家才知道该走哪条）：实际「${String(advance.text ?? '').slice(0, 160)}」`);
  }
  return bad;
}

test('自由动作的 API 边界：当成这一手打 /battle/advance 必须 400 并点名 /battle/free；'
  + '/battle/free 放行且回合不变（且这一手仍能出技能）', async () => {
  const {createCoachServer} = await import('../src/server/index.js');
  const server = createCoachServer({fetchImpl: async () => { throw Error('测试环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const post = async (path, body, headers) => {
    const r = await fetch(`${base}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 也要能看出原文 */ }
    return {status: r.status, text, body: parsed};
  };
  try {
    // CSRF 三件套：Origin + Cookie + X-Coach-CSRF（与本文件上一条判据同一套夹具，不另起一套）
    const bootResponse = await fetch(`${base}api/bootstrap`);
    const cookie = (bootResponse.headers.get('set-cookie') ?? '').split(';')[0];
    const boot = await bootResponse.json();
    const headers = {'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf,
      Origin: base.replace(/\/$/, ''), Cookie: cookie};

    const mine = ['own-0001', 'own-0003', 'own-0005', 'own-0007', 'own-0009', 'own-0011'];
    const started = await post('api/roco/battle/new', {mode: 'pvp-standard-six-pet', team: mine}, headers);
    assert.equal(started.body?.ok, true,
      `开局必须成功：${started.body?.error ?? started.text.slice(0, 160)}`);
    const magic = (started.body.view.legal ?? []).find((a) => a.kind === 'magic');
    assert.ok(magic, '标准 PVP 第 1 回合必须能出愿力强化（拿不到 ⇒ 这条判据是空的，按红处理）');
    // 公开视图那条 magic 的真实形状**量出来再写**：只要 `magic_id`（引擎认的字段）。
    assert.ok(typeof magic.magic_id === 'string' && magic.magic_id.length > 0,
      `公开视图里 kind=magic 那条必须带 magic_id（引擎用它认动作）；实测键=${JSON.stringify(Object.keys(magic))}`);
    // 只带引擎认的最小字段：公开视图还带 label/skill_name 等展示字段，
    // 整条回传会把「展示字段能不能当请求体」混进这条判据。
    const action = {kind: 'magic', magic_id: magic.magic_id};
    const turnBefore = started.body.view.turn;

    const free = await post('api/roco/battle/free', {battle_id: started.body.battle_id, action}, headers);
    const advance = await post('api/roco/battle/advance', {battle_id: started.body.battle_id, action}, headers);

    const problems = freeActionBoundaryProblems({free, advance, turnBefore});
    assert.deepEqual(problems, [], problems.join(' | '));

    // ── 必红反证（两条，喂给**同一条判据**）──
    const relaxed = freeActionBoundaryProblems({
      free, turnBefore,
      advance: {status: 200, text: JSON.stringify({ok: true}), body: {ok: true}},
    });
    assert.ok(relaxed.length >= 2, `反证没命中（判据是空的）：${JSON.stringify(relaxed)}`);
    const advanced = freeActionBoundaryProblems({
      free: {...free, body: {...free.body, view: {...free.body.view, turn: turnBefore + 1}}},
      advance, turnBefore,
    });
    assert.ok(advanced.some((x) => x.includes('推进回合')),
      `自由动作推进了回合必须报：${JSON.stringify(advanced)}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// ── 2026-09-25 追加：v3 技能格的**预期伤害**必须与引擎样本一致（含必红反证）──────────────
//
// 为什么必须钉在这里（真实缺口，不是假想）：
//   门禁里的两个浏览器套件（`battle-feedback`、legacy 路径的 `roco-ux-acceptance`）**都不覆盖
//   v3 技能格的预期伤害**；唯一有这条的 `browser-battle-v3-acceptance.mjs` **不在门禁里**。
//   于是 2026-09-25 那两个真缺陷一路绿到玩家面前：
//     ① `requestPlan()` 把 plan 的 `damage_preview` 合并进 `state.view` 之后**没有重绘**；
//     ② **字段形状不一致** —— Node 桥把 samples 映射成 `{label,min,max}`（`src/server/roco-service.js:2379`），
//        而页面读的是 `sample.damage` ⇒ 永远 `null` ⇒ 四格全是「预期伤害 —」。
//   修法是页面新增 `sampleDamageOf(sample)`（`damage` → 上界 `max` → 都没有就 `null`，**不补数**）。
//   这条判据**直接跑那个真函数**（从源码里抽出来，不另写一份，避免两份漂移），
//   再用**真服务**核对「引擎给的样本」与「页面能换算出的数字」这条链真的通。

/** 从 `src/client/roco.js` 里把 `sampleDamageOf` **整段抽出来**（借真函数跑，不重写）。 */
function extractSampleDamageOf(){
  const src=readFileSync(join(ROOT,'src/client/roco.js'),'utf8');
  const at=src.indexOf('function sampleDamageOf(sample)');
  assert.notEqual(at,-1,'`roco.js` 里找不到 `sampleDamageOf`（页面换算预期伤害的唯一入口）');
  const open=src.indexOf('{',at);
  let depth=0,i=open;
  for(;i<src.length;i+=1){
    if(src[i]==='{')depth+=1;
    else if(src[i]==='}'){depth-=1;if(depth===0)break;}
  }
  assert.ok(depth===0,'`sampleDamageOf` 的花括号不平衡（抽取失败）');
  const body=src.slice(at,i+1);
  return {body,fn:new Function(`return (${body})`)()};
}

/** 判据：一条样本必须能被换算成一个**有限数**，且带非空 `label`；换算不出来就报（不许补 0）。 */
function damageSampleProblems(samples){
  const bad=[];
  if(!Array.isArray(samples))return ['`damage_preview.samples` 不是数组'];
  if(samples.length===0)return ['引擎没给任何伤害样本（该有样本时就是缺陷；页面只能显示「—」）'];
  samples.forEach((s,i)=>{
    if(!s||typeof s.label!=='string'||!s.label.trim())bad.push(`第 ${i+1} 条样本没有 label：${JSON.stringify(s)}`);
    const val=sampleDamage(s);
    if(!Number.isFinite(val))bad.push(`样本「${s?.label??i}」换算不出有限数（damage/min/max 全空？）：${JSON.stringify(s)}`);
  });
  return bad;
}

const {body:sampleDamageSrc,fn:sampleDamage}=extractSampleDamageOf();

test('预期伤害的换算口径：damage 优先、其次上界 max、都没有就是 null（绝不补 0）——直接跑 roco.js 里的真函数',()=>{
  assert.match(sampleDamageSrc,/Number\.isFinite\(sample\.damage\)/,'`sampleDamageOf` 必须先认 `damage`');
  assert.match(sampleDamageSrc,/Number\.isFinite\(sample\.max\)/,'`sampleDamageOf` 必须认上界 `max`（Node 桥给的就是这个形状）');
  assert.equal(sampleDamage({damage:101}),101,'`{damage:101}` ⇒ 101');
  assert.equal(sampleDamage({label:'翅刃',min:101,max:216}),216,'`{label,min,max}` ⇒ 取上界 216（桥的真实形状）');
  assert.equal(sampleDamage({label:'防御',min:null,max:null}),null,'两个都空 ⇒ null（不补 0）');
  assert.equal(sampleDamage({}),null,'空对象 ⇒ null');
  assert.equal(sampleDamage(null),null,'null ⇒ null');
  // 必红反证：判据本身不许是空的 —— 把「换算不出数 / 没有 label / 样本数组为空」三种坏形态喂进去必须报
  const badShape=damageSampleProblems([{label:'防御',min:null,max:null}]);
  const noLabel=damageSampleProblems([{min:1,max:2}]);
  const empty=damageSampleProblems([]);
  assert.ok(badShape.length>=1,`反证没命中（判据是空的）：${JSON.stringify(badShape)}`);
  assert.ok(noLabel.length>=1,`反证没命中（缺 label 必须报）：${JSON.stringify(noLabel)}`);
  assert.ok(empty.length>=1,`反证没命中（空样本必须报）：${JSON.stringify(empty)}`);
  log('换算口径实测：{damage:101}→101、{min:101,max:216}→216、全空→null；三条反证全部命中');
});

test('真服务：plan 回执里的伤害样本必须与「页面换算得出来的数字」对得上（有攻击技就必须有样本）',async()=>{
  const {createCoachServer}=await import('../src/server/index.js');
  const server=createCoachServer({fetchImpl:async()=>{throw Error('测试环境不允许联网');}});
  await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
  const base=`http://127.0.0.1:${server.address().port}/`;
  const post=async(path,body,headers)=>{
    const r=await fetch(`${base}${path}`,{method:'POST',headers,body:JSON.stringify(body)});
    const text=await r.text();
    let parsed=null;try{parsed=JSON.parse(text);}catch{/* 原文也要能看 */}
    return {status:r.status,text,body:parsed};
  };
  try{
    const bootResponse=await fetch(`${base}api/bootstrap`);
    const cookie=(bootResponse.headers.get('set-cookie')??'').split(';')[0];
    const boot=await bootResponse.json();
    const headers={'Content-Type':'application/json','X-Coach-CSRF':boot.csrf,
      Origin:base.replace(/\/$/,''),Cookie:cookie};

    const mine=['own-0001','own-0003','own-0005','own-0007','own-0009','own-0011'];
    const started=await post('api/roco/battle/new',{mode:'pvp-standard-six-pet',team:mine},headers);
    assert.equal(started.body?.ok,true,`开局必须成功：${started.body?.error??started.text.slice(0,160)}`);
    const legalSkills=(started.body.view.legal??[]).filter((a)=>a.kind==='skill');
    assert.ok(legalSkills.length>0,'第 1 回合必须有合法技能（否则这条判据是空的）');

    const planned=await post('api/roco/plan',{battle_id:started.body.battle_id},headers);
    assert.equal(planned.body?.ok,true,`plan 必须成功：${planned.body?.error??planned.text.slice(0,200)}`);
    const preview=planned.body.damage_preview??null;
    assert.ok(preview,'plan 回执必须带 `damage_preview`（页面唯一的样本来源）');
    const samples=preview.samples??null;
    log(`plan 样本：available=${preview.available} samples=${JSON.stringify(samples)?.slice(0,220)}`);

    // 有可结算的攻击技 ⇒ 必须有样本；否则页面只能显示「—」（= 今天那个缺陷）
    const problems=damageSampleProblems(samples);
    assert.deepEqual(problems,[],`${problems.join(' | ')}；原始 samples=${JSON.stringify(samples)?.slice(0,300)}`);

    // 每条样本的 label 必须能在本回合的合法技能里找到（引擎给的样本不能是"别的技能"的）
    const labels=new Set(legalSkills.map((a)=>a.label??a.skill_name??a.name));
    for(const s of samples){
      assert.ok(labels.has(s.label),
        `样本「${s.label}」不在本回合合法技能里（合法：${[...labels].join('、')}）`);
    }
    // 每条样本换算出来的数必须是有限数（页面读的就是它）
    const converted=samples.map((s)=>sampleDamage(s));
    assert.ok(converted.every((v)=>Number.isFinite(v)),
      `每条样本都必须换算成有限数：${JSON.stringify(samples.map((s,i)=>[s.label,converted[i]]))}`);

    // 必红反证：把 samples 清空后，同一条判据必须报（证明它不是空转）
    const cleared=damageSampleProblems([]);
    assert.ok(cleared.length>=1,`反证没命中（判据是空的）：${JSON.stringify(cleared)}`);
  }finally{
    server.closeAllConnections?.();
    await new Promise((r)=>server.close(r));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 投降（2026-09-25，人类投诉「投降只会扣一颗心，为啥退出不出来？？」）
//
// 实测结论（主线程真机探针 `/tmp/roco-surrender/probe.mjs`，真无头 Chrome + 真鼠标）：
//   before{mana:4,turn:1,phase:'battle'} → 真鼠标点「逃跑」→「确认投降」
//   → after{result:'loss',phase:'ended',mana:4,turn:1}（**mana 逐位不变**）
//   → 真鼠标点「回主页（重新选阵容）」→ `#battle-panel.hidden===true`、`body[data-roco-view]="empty"`
// ⇒ 引擎与页面**都正确**；人类看到的「只扣一颗心」不是投降扣的（引擎 `_surrender` 不扣魔力，
//   那是力竭的 `mana.faint_cost=1`），而是**点击错位**：点击处理器原来把 `data-b3-action` 写成
//   「渲染那一刻 `view.legal` 的下标」，局面一推进下标就指向**另一个动作**。
//   修法见 `src/client/roco.js`：`surrender` 按 `kind` 在当前 `legal` 里重新定位。
// 本判据把两件事都钉住：① 投降端到端真的判负且不动魔力；② **旧下标写法必须被证明是危险的**。
function surrenderLocateProblems({legalBefore, legalAfter, staleIndex, stableAfter}) {
  const bad = [];
  if (!Array.isArray(legalBefore) || legalBefore.length < 2) return ['拿不到渲染那一刻的合法动作表（采样失败 ⇒ 读不到就不算验过）'];
  if (!Array.isArray(legalAfter) || legalAfter.length < 1) return ['拿不到局面变化后的合法动作表（采样失败）'];
  const atRender = legalBefore[staleIndex];
  if (!atRender || atRender.kind !== 'surrender') {
    bad.push(`渲染那一刻下标 ${staleIndex} 必须指向 surrender，实际 ${JSON.stringify(atRender?.kind ?? null)}`);
  }
  const afterByIndex = legalAfter[staleIndex];
  if (afterByIndex && afterByIndex.kind === 'surrender') {
    bad.push(`局面变化后下标 ${staleIndex} 仍然指向 surrender —— 这一组样本证明不了「旧下标会指错」，`
      + '换一组局面重取（不许把这种样本当成通过）');
  }
  if (stableAfter?.kind !== 'surrender') {
    bad.push(`稳定定位（按 kind 在当前 legal 里找）没找到 surrender：${JSON.stringify(stableAfter?.kind ?? null)}`);
  }
  return bad;
}

test('投降：端到端判负 + mana 逐位不变；且「渲染那刻的下标」在局面变化后会指错动作（必红反证）', async () => {
  const {createCoachServer} = await import('../src/server/index.js');
  const server = createCoachServer({fetchImpl: async () => { throw Error('测试环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
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
    const legalBefore = started.view.legal ?? [];
    const manaBefore = started.view.mana?.self ?? null;
    const staleIndex = legalBefore.findIndex((a) => a.kind === 'surrender');
    assert.ok(staleIndex > 0, `合法动作表里必须有一个 surrender 且不在首位（实际下标 ${staleIndex}）`);

    // ── 必红反证：模拟一次**真实局面变化** —— 少一个动作（例如某只倒下后换人选项消失）。
    // 用的是**真回执里的真动作**，只做一次"删掉下标 0 那一项"的真实扰动。
    const legalAfter = [...legalBefore.slice(1)];
    const stableAfter = legalAfter.find((a) => a.kind === 'surrender');
    const problems = surrenderLocateProblems({legalBefore, legalAfter, staleIndex, stableAfter});
    assert.deepEqual(problems, [], problems.join(' | '));
    assert.notEqual(legalAfter[staleIndex]?.kind, 'surrender',
      '这一组样本没能证明「旧下标会指错」——换一组局面重取（不许当通过）');
    // 同一份数据喂「旧写法」必须报（判据不是空的）
    const legacy = surrenderLocateProblems({legalBefore, legalAfter,
      staleIndex: staleIndex - 1, stableAfter: null});
    assert.ok(legacy.length >= 2, `反证没命中（判据是空的）：${JSON.stringify(legacy)}`);

    // ── 端到端：真提交投降
    // ⚠ 必须提交 **`view.legal` 里那一整条动作对象**（页面就是这么发的）。
    // 实测教训：只发 `{kind:'surrender'}` 这种最小对象，会被当成无效动作、
    // 回执变成 `phase:"replace"` 且 `mana 4→3`（走了别的路径）——不是投降。
    const surrenderAction = legalBefore[staleIndex];
    assert.equal(surrenderAction.kind, 'surrender', '要从真回执里取那一条 surrender 动作对象');
    const surrendered = await (await fetch(`${base}api/roco/battle/advance`, {
      method: 'POST', headers, body: JSON.stringify({battle_id: started.battle_id,
        action: surrenderAction, state_version: started.view.state_version ?? 0}),
    })).json();
    assert.equal(surrendered.ok, true, `投降必须被接受：${surrendered.error ?? ''}`);
    assert.equal(surrendered.view.battle_result, 'loss', '投降必须判负（人类口径：投降立刻结束本局并按失败记）');
    assert.equal(surrendered.view.phase, 'ended', '投降必须结束对局');
    assert.equal(surrendered.view.mana?.self ?? null, manaBefore,
      `投降**不许**扣魔力（人类报的「只扣一颗心」不是投降扣的）：投降前 ${manaBefore} / 投降后 ${surrendered.view.mana?.self ?? null}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// ── 天气进「模型题面」：有天气必须说出来，没天气一个字都不加（2026-09-25 裁决 B 的接线）──
//
// 引擎那一半已经由 `roco/tests/test_weather_pvp.py` 钉住（`public_planner_state` 里
// `weather.name` / `weather.turns_left`，没天气时**键不出现**）。这里钉的是**服务端读法**：
// 键名必须与引擎一致、缺回合数不许编一个数、没天气不许凭空写「天气」。
// 反证方向：把 `weatherLine` 改成「没天气也返回一句」或「缺 turns_left 时补 0」⇒ 本条必红。
test('天气进模型题面：有天气说出名字与剩余回合，没天气一个字都不加', () => {
  // 形状与引擎 `public_planner_state` 的 weather 块逐字一致（name / turns_left / duration_turns）
  const withWeather = weatherLine({weather: {name: '雨天', turns_left: 7, duration_turns: 8}});
  assert.match(withWeather, /雨天/, '天气名必须原样出现（不许翻译成别的说法）');
  assert.match(withWeather, /7/, '剩余回合数必须出现');
  assert.equal(weatherLine({}), null, '局面里没有天气 ⇒ 不许加任何字');
  assert.equal(weatherLine({weather: null}), null);
  assert.equal(weatherLine({weather: {}}), null, '空对象不是天气（引擎不会这么给，读到也不许编）');
  assert.equal(weatherLine({weather: {turns_left: 3}}), null, '只有回合数、没有名字 ⇒ 不是天气');
  // 缺 turns_left 时只报名字，**不许**补一个 0/默认值
  const noTurns = weatherLine({weather: {name: '沙暴'}});
  assert.match(noTurns, /沙暴/);
  assert.doesNotMatch(noTurns, /\d/, '引擎没给剩余回合时不许编数字');
  // 结构化：题面那一句必须**由这一份实现**产生（抄第二份文案就会漂）
  const src = readFileSync(join(ROOT, 'src/server/roco-service.js'), 'utf8');
  assert.match(src, /const weather=weatherLine\(pub\);\s*\n\s*if\(weather\)parts\.push\(weather\);/,
    'describePosition 必须调用 weatherLine（否则题面里永远没有天气）');
  assert.equal((src.match(/场上天气 /g) ?? []).length, 1, '「场上天气」这句话只许有一份实现');
});

// ── 天气进 UI 公开视图（2026-09-25 主线程真机复测挖出来的白名单缺口）──────────────
//
// 引擎从裁决 B 起就在 `public_planner_state` / `ui_public_view` 里给天气，但 `publicView()`
// 是**白名单**，之前没列 `weather` ⇒ 页面拿到的永远是 null、天气条一个字都画不出来。
// 实测证据：用 `loadouts` 给圆号鱼换上「落雨」并打出 `weather_set`（事件里有），
// 回执里仍然没有 `weather` 键。这条判据按形状钉住：**引擎给才给，没给一个键都不加**。
test('天气进 UI 公开视图：引擎给了就带出去，没给一个键都不加', () => {
  const base = {state_version: 7, turn: 3, phase: 'battle', self: {active: 0, pets: []}, opponent: {}, legal: {}};
  const withWeather = publicView({...base, public: {ruleset_id: 'x', weather: {name: '雨天', turns_left: 7, duration_turns: 8}}});
  assert.deepEqual(withWeather.weather, {name: '雨天', turns_left: 7, duration_turns: 8},
    '引擎给了天气就必须原样带出去（页面靠它画天气条）');
  assert.equal('weather' in publicView({...base, public: {ruleset_id: 'x'}}), false,
    '没天气 ⇒ 这个键不许出现（不补「无天气」占位）');
  assert.equal('weather' in publicView({...base, public: {ruleset_id: 'x', weather: {}}}), false,
    '空对象不是一条天气事实');
  assert.deepEqual(publicView({...base, public: {ruleset_id: 'x', weather: {name: '沙暴'}}}).weather, {name: '沙暴'},
    '引擎没给剩余回合时只报名字，不许编一个数');
  // 反证方向：这一行就是这次真踩到的缺陷，删掉它页面就永远没有天气
  const src = readFileSync(join(ROOT, 'src/server/roco-service.js'), 'utf8');
  assert.match(src, /publicState\?\.weather\?\?ui\?\.weather/,
    '白名单必须显式转发天气（删掉它 ⇒ 天气条永远画不出来）');
});
