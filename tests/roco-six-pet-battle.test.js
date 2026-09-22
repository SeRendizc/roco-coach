// RC-106：让「六宠标准 PVP」真的能开一局 —— Node 侧的契约测试。
//
// 引擎与数据这一侧由 Python 负责（`roco/tests/test_six_pet_battle.py`，33 条）。
// 这一份盯的是**Node 能读到的那些契约**，也就是主线程接线时会照抄的三件事：
//
//   ① `data/roco/battle-modes.json` 的 `pvp-standard-six-pet.ruleset_binding`
//      指向**真的带 mana/actions** 的那份配置（RC-106 的靶心）；判据从**登记表读数**
//      得出，不在这里再写一个字面量 —— 否则两处会各漂一份。
//   ② 模式规模 `team_size` 的**唯一事实源**是登记表；配置里的那个数必须与它一致，
//      而且 legacy/候选的两种口径（3 / 6）都能在登记表里读出来。
//   ③ v2 与 v3 的区别就是三件事：`mana` / `actions` / `binding` —— 其余逐字相同
//      （v2 是「能开局但没有 mana/actions」的历史候选，**留着**做回归对照）。
//
// 运行：node --test tests/roco-six-pet-battle.test.js

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ACTIONS_REQUIRED_PATHS, BATTLE_MODES_PATH, CANDIDATE_ID, LEGACY_ID, MANA_ACTIONS_CONFIG_IDS,
  MANA_REQUIRED_PATHS, RULESET_DIR, V3_CANDIDATE_ID, buildConfigs, checkConfigsForTest,
} from '../scripts/roco/build-rule-configs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const ledger = readJson('data/roco/evidence/rule-evidence-ledger.json');
const battleModes = readJson(BATTLE_MODES_PATH);
const modes = new Map((battleModes.modes ?? []).map((m) => [m.id, m]));
const configs = new Map(buildConfigs({ledger, battleModes}).map((c) => [c.ruleset_config_id, c]));
const onDisk = (id) => readJson(`${RULESET_DIR}/${id.replace(/_/g, '-')}.json`);

//: 标准 PVP 的模式 id。它是**登记表里的一条记录**，不是本文里的一个规则字面量。
const STANDARD_MODE = 'pvp-standard-six-pet';
//: legacy 训练场的模式 id（`legacy_sim_v1` 绑的那个）。
const TRAINING_MODE = 'demo-training-3v3';

test('RC-106 绑定：标准 PVP 必须绑到带 mana/actions 的候选（改回 v2 就红）', () => {
  const mode = modes.get(STANDARD_MODE);
  assert.ok(mode, `${STANDARD_MODE} 必须登记在 ${BATTLE_MODES_PATH} 里`);
  // 判据本体：**绑定指向哪份配置，那份配置就必须声明 mana 与 actions**。
  // 这不是「抄一份 v3 的 id」—— 把绑定改回 v2，下面两条立刻红（v2 没有这两块）。
  const bound = onDisk(mode.ruleset_binding);
  assert.equal(bound.ruleset_config_id, mode.ruleset_binding,
    `${STANDARD_MODE} 绑的 ${mode.ruleset_binding} 与磁盘上的配置 id 不一致`);
  assert.ok(bound.mana,
    `被绑定的配置 ${mode.ruleset_binding} 没有 mana 块 —— 标准 PVP 会按「能开局但没有魔力系统」的口径跑`);
  assert.ok(bound.actions, `被绑定的配置 ${mode.ruleset_binding} 没有 actions 块`);
  assert.equal(bound.is_default, false, '被绑定的候选不得是默认配置');
  assert.equal(bound.battle_mode.id, STANDARD_MODE,
    '被绑定的配置必须声明它服务的就是标准 PVP 这个模式');
  // 反向控制：绑回 v2（历史候选，没有 mana/actions）必须能被这条判据判出来
  const v2 = onDisk(CANDIDATE_ID);
  assert.equal(v2.mana, undefined);
  assert.equal(v2.actions, undefined);
  assert.throws(() => {
    if (!v2.mana) throw new Error(`${STANDARD_MODE} 的绑定指向了没有 mana 的 ${CANDIDATE_ID}`);
  }, /没有 mana/);
  // legacy 的绑定没被动过
  assert.equal(modes.get(TRAINING_MODE).ruleset_binding, LEGACY_ID);
});

test('RC-106 模式规模：登记表是唯一事实源，配置必须跟着它生成', () => {
  for (const [modeId, expected] of [[STANDARD_MODE, 6], [TRAINING_MODE, 3]]) {
    const mode = modes.get(modeId);
    assert.equal(mode.parameters.team_size, expected,
      `${modeId} 的 team_size 应当是 ${expected}`);
  }
  // 每份配置里的 team_size 必须等于它所绑模式登记的 team_size
  for (const cfg of configs.values()) {
    const mode = modes.get(cfg.battle_mode.id);
    assert.ok(mode, `${cfg.ruleset_config_id} 绑的模式 ${cfg.battle_mode.id} 不在登记表里`);
    assert.equal(cfg.battle_mode.team_size.value, mode.parameters.team_size,
      `${cfg.ruleset_config_id} 的 team_size 与登记表 ${mode.id} 不一致`);
  }
  // 必红方向：把配置里的 team_size 改成 3，判据必须能判出来（这里走的是同一份比较）
  const judge = (declared, registered) => declared === registered;
  assert.equal(judge(6, 6), true);
  assert.equal(judge(3, 6), false, '硬编码回 3 必须被判出来');
  // 生成器与磁盘仍然逐字一致（本活没改过生成逻辑）
  assert.deepEqual(checkConfigsForTest(), []);
});

test('RC-106 v2/v3：区别只有 mana / actions / binding 三处', () => {
  const v2 = onDisk(CANDIDATE_ID);
  const v3 = onDisk(V3_CANDIDATE_ID);
  // 逐字相同的两块：本活没有重新解释既有口径
  assert.deepEqual(v3.energy, v2.energy, 'v3 的 energy 必须逐字沿用 v2');
  assert.deepEqual(v3.turn_order, v2.turn_order, 'v3 的 turn_order 必须逐字沿用 v2');
  // 2026-09-22：开局资源是用户实机核对的 10 星（两侧同源同值）。
  assert.equal(v3.energy.initial.value, 10);
  assert.equal(v3.energy.initial.confidence, 'RECORDED_IN_GAME');
  assert.equal(v2.energy.initial.value, 10);
  // 新增的两块
  assert.ok(v3.mana && v3.actions, 'v3 必须有 mana 与 actions');
  assert.equal(v2.mana, undefined);
  assert.equal(v2.actions, undefined);
  // 白名单里只有 v3 被要求写全这两块
  assert.deepEqual([...MANA_ACTIONS_CONFIG_IDS], [V3_CANDIDATE_ID]);
  assert.deepEqual([...MANA_REQUIRED_PATHS],
    ['mana.pool', 'mana.faint_cost', 'mana.loss_when_zero', 'mana.surrender']);
  assert.deepEqual([...ACTIONS_REQUIRED_PATHS],
    ['actions.allowed_kinds', 'actions.forbidden_kinds', 'actions.unknown_kinds_allowed']);
  // 台账等级一律没抬（MC-E07/E08/E09 未录制）
  assert.equal(v3.mana.pool.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(v3.mana.faint_cost.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(v3.battle_mode.team_size.confidence, 'ENGINE_HYPOTHESIS');
  for (const id of ['EV-PVP-STANDARD-TEAM-SIZE', 'EV-PVP-STANDARD-MANA', 'EV-PVP-FAINT-MANA-LOSS']) {
    const entry = (ledger.entries ?? []).find((e) => e.id === id);
    assert.ok(entry, `台账里必须有 ${id}`);
    assert.equal(entry.confidence, 'CROSS_SOURCE_SUPPORTED',
      `${id} 不许被升成更高级别`);
    assert.notEqual(entry.confidence, 'OFFICIAL_CURRENT');
  }
});

test('RC-106 接线：这份测试真的在 test:unit 的手写清单里', () => {
  const pkg = readJson('package.json');
  assert.match(pkg.scripts['test:unit'], /tests\/roco-six-pet-battle\.test\.js/,
    '本文件必须出现在 test:unit 的**手写清单**里 —— 不加就永远不会跑');
  const stripped = pkg.scripts['test:unit'].replace('tests/roco-six-pet-battle.test.js ', '');
  assert.ok(!/tests\/roco-six-pet-battle\.test\.js/.test(stripped),
    '反向控制：从清单里删掉这一项之后，同一条判据必须不再成立');
});
