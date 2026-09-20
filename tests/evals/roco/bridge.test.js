// Node ↔ Python 桥的契约测试（`npm run test:bridge`）
//
// 这一组测试只问一件事：**桥说得清「是谁的错」吗？**
//
// 四类失败必须能被调用方分开：
//   ① service      服务超时 / 连不上
//   ② ruleset      规则集不被支持（本引擎持有的规则集加载不了）
//   ③ version      版本不一致（请求的规则集不是本引擎持有的版本 / 快照指纹对不上）
//   ④ unsupported  机制不支持（fail closed：回 unsupported，**不回数字**）
//
// 另外守住两条不变量：
//   - 契约字段：每个回执都有 ruleset_id / state_version / coverage / evidence_ids / latency_ms / error_type
//   - 隐藏信息：请求带对手待执行动作或真实随机种子时，桥**连发都不发**（MC-013）
//
// 测试是自洽的：自己挑空闲端口、自己起停 Python 子进程、结束后清理。
// 没有 python3 时**明确 skip**（带原因），而不是假装通过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';

import {
  RocoClient,
  ROCO_ERROR,
  ROCO_FAILURE_CLASS,
  RULESET_ID,
  CONTRACT_FIELDS,
  findHiddenKeys,
  isOk,
  isTimeout,
  isRulesetUnsupported,
  isVersionMismatch,
  isUnsupportedEffect,
  isNotImplemented,
  isUnsupported,
  assertOk,
  RocoError,
  ROCO_TOOLS,
} from '../../../src/coach/roco-client.js';

const UNKNOWN_RULESET = 'roco-world-s0-1999-01-01';

// python3 不在就整组跳过：桥的另一半是 Python，缺了它测不了。
const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）：Node↔Python 桥测试跳过`;

/** 挑一个空闲端口：先绑 0 号端口拿到系统分配的号，再关掉。 */
async function pickFreePort() {
  const probe = createServer();
  probe.unref();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 绕过客户端守卫直接 POST：用来证明**服务端**也会拦隐藏信息（两层都要拦）。 */
function rawPost(baseUrl, path, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const url = new URL(baseUrl + path);
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 起一个服务、跑断言、无论成败都停掉。 */
async function withService(run, { rulesetId = RULESET_ID, timeoutMs = 8000 } = {}) {
  const client = new RocoClient({
    port: await pickFreePort(),
    rulesetId,
    timeoutMs,
    startTimeoutMs: 30000,
  });
  try {
    const started = await client.startService();
    return await run(client, started);
  } finally {
    await client.stopService();
  }
}

// ── 1. 生命周期 + /health ───────────────────────────────────────────────

test('桥：能起停 Python 服务；/health 往返并报告规则集 id 与快照指纹', { skip: SKIP }, async () => {
  const client = new RocoClient({ port: await pickFreePort(), startTimeoutMs: 30000 });
  try {
    const started = await client.startService();
    assert.equal(started.ok, true, 'startService 应当成功');
    assert.equal(started.ruleset_id, RULESET_ID, '就绪行应当报告规则集 id');
    assert.ok(started.port > 0, '端口应当是系统分配的真实端口');
    assert.match(String(started.snapshot_fingerprint), /^[0-9a-f]{64}$/, '就绪行应当带 sha256 快照指纹');

    const health = await client.health();
    assert.equal(health.ok, true, `健康检查应当成功：${health.message || ''}`);
    assert.equal(health.ruleset_id, RULESET_ID, '/health 必须报告规则集 id');
    assert.match(String(health.snapshot_fingerprint), /^[0-9a-f]{64}$/, '/health 必须报告快照指纹');
    assert.equal(health.protocol_version, 1, '协议版本应当对齐');
    assert.ok(Array.isArray(health.evidence_ids) && health.evidence_ids.length >= 5, '应当给出五份数据文件的证据 id');
    assert.equal(health.result.loaded, true);

    // 契约字段一个都不能少
    for (const field of CONTRACT_FIELDS) {
      assert.ok(field in health, `回执缺少契约字段 ${field}`);
    }

    // 版本握手：适配器与服务必须说同一个协议版本
    const handshake = await client.handshake();
    assert.equal(handshake.ready, true, '握手应当就绪');

    // 停掉之后必须真的连不上，而不是拿到缓存
    const stopped = await client.stopService();
    assert.equal(stopped.ok, true);
    const after = await client.health({ fresh: true });
    assert.equal(after.ok, false, '服务停了就不该还能答');
    assert.equal(after.code, ROCO_ERROR.UNAVAILABLE, '停了之后应当是「连不上」这一类');
    assert.equal(after.failure_class, ROCO_FAILURE_CLASS.SERVICE);
  } finally {
    await client.stopService();
  }
});

// ── 2. 契约字段 + 静态事实 ──────────────────────────────────────────────

test('桥：静态事实带 ruleset/state_version/coverage/evidence_ids/延迟', { skip: SKIP }, async () => {
  await withService(async (client) => {
    const pet = await client.pet('pet_000225', { stateVersion: 7 });
    assert.equal(pet.ok, true, `查精灵应当成功：${pet.message || ''}`);
    assert.equal(pet.ruleset_id, RULESET_ID);
    assert.equal(pet.state_version, 7, 'state_version 必须原样回传（调用方用它判断事实是否过期）');
    assert.equal(pet.coverage, 1, '静态图鉴事实的覆盖率是 1');
    assert.ok(
      pet.evidence_ids.includes(`ev:${RULESET_ID}:pets.json#pet_000225`),
      `证据 id 应当能回查到 pets.json 的具体记录，实际：${pet.evidence_ids.join(', ')}`,
    );
    assert.equal(pet.result.name, '寂灭骨龙');
    assert.equal(pet.result.stat_total, 552);
    assert.deepEqual(pet.result.types, ['龙系', '幽系']);

    // 延迟必须被报告：客户端实测 + 服务端自测各一栏
    assert.equal(typeof pet.latency_ms, 'number');
    assert.ok(pet.latency_ms >= 0, 'latency_ms 必须是非负数');
    assert.equal(typeof pet.service_latency_ms, 'number');
    assert.ok(pet.service_latency_ms >= 0);

    // 静态 power 是**来源字段**，绝不能被当成最终伤害
    const skill = await client.skillByName('坟场搏击');
    assert.equal(skill.ok, true);
    assert.equal(skill.result.power, 180);
    assert.equal(skill.result.power_status, 'static_value_present');
    assert.equal(skill.result.effective_power, null, '未核验的最终威力必须是 null，不是数字');
    assert.equal(skill.result.damage, null, '未核验的伤害必须是 null，不是数字');
    assert.equal(skill.result.mechanics.resolved, false);
    assert.ok(skill.unsupported.length >= 1, '未实现的机制必须显式列出');

    // 学习表与术语也是事实，同样带证据
    const learnset = await client.learnset('pet_000225');
    assert.equal(learnset.ok, true);
    assert.ok(learnset.evidence_ids.some((id) => id.includes('learnsets.json')));
    assert.ok(Array.isArray(learnset.result.native) && learnset.result.native.length > 0);

    const term = await client.term('1016');
    assert.equal(term.ok, true);
    assert.equal(term.result.note, '应对攻击');
    assert.ok(term.evidence_ids.includes(`ev:${RULESET_ID}:terms.json#1016`));
  });
});

// ── 3. 版本不一致（可区分）──────────────────────────────────────────────

test('桥：未知规则集 id → 可区分的 version_mismatch', { skip: SKIP }, async () => {
  await withService(async (client) => {
    const mismatch = await client.query({ kind: 'pet', pet_id: 'pet_000225' }, { rulesetId: UNKNOWN_RULESET });
    assert.equal(mismatch.ok, false, '未持有的规则集不许答');
    assert.equal(mismatch.code, ROCO_ERROR.VERSION_MISMATCH);
    assert.equal(mismatch.failure_class, ROCO_FAILURE_CLASS.VERSION);
    assert.equal(mismatch.coverage, 0);
    assert.equal(mismatch.result, null, '版本不一致时不许给任何结果');
    assert.match(mismatch.message, /不是本引擎持有的版本/, '错误文案要说清是哪一类');

    // 四类失败的码必须互不相同 —— 这正是「可区分」的含义
    const codes = [
      ROCO_ERROR.TIMEOUT,
      ROCO_ERROR.RULESET_UNSUPPORTED,
      ROCO_ERROR.VERSION_MISMATCH,
      ROCO_ERROR.UNSUPPORTED_EFFECT,
    ];
    assert.equal(new Set(codes).size, 4, '四类失败的码必须互不相同');
    const classes = [
      ROCO_FAILURE_CLASS.SERVICE,
      ROCO_FAILURE_CLASS.RULESET,
      ROCO_FAILURE_CLASS.VERSION,
      ROCO_FAILURE_CLASS.UNSUPPORTED,
    ];
    assert.equal(new Set(classes).size, 4, '四类失败的失败类必须互不相同');
    assert.equal(isVersionMismatch(mismatch), true);
    assert.equal(isRulesetUnsupported(mismatch), false, '版本不一致不能被误判成规则集不支持');
    assert.equal(isTimeout(mismatch), false);
    assert.equal(isUnsupportedEffect(mismatch), false);

    // 指纹钉死：调用方给一个对不上的指纹，同样必须是 version_mismatch
    const fingerprint = await client.query(
      { kind: 'pet', pet_id: 'pet_000225' },
      { expectedFingerprint: 'deadbeef'.repeat(8) },
    );
    assert.equal(fingerprint.code, ROCO_ERROR.VERSION_MISMATCH);
  });
});

// ── 4. 不支持机制：fail closed，不给数字 ────────────────────────────────

test('桥：机制不支持时返回 unsupported，而不是一个数字', { skip: SKIP }, async () => {
  await withService(async (client) => {
    const effect = await client.resolveEffect('skill_000744');
    assert.equal(effect.ok, false, '效果原语未实现时不许答');
    assert.equal(effect.code, ROCO_ERROR.UNSUPPORTED_EFFECT);
    assert.equal(effect.failure_class, ROCO_FAILURE_CLASS.UNSUPPORTED);
    assert.equal(effect.coverage, 0, 'fail closed 必须 coverage = 0');
    assert.equal(effect.result, null, '绝不退化成默认威力/默认伤害');
    assert.ok(effect.unsupported.length >= 1, '必须给出结构化的不支持理由');
    assert.match(effect.unsupported[0].reason, /未核验|未实现/);
    assert.equal(isUnsupportedEffect(effect), true);
    assert.equal(isOk(effect), false);
    // 结果里不该出现任何「数字型」的最终数值
    assert.equal(effect.result, null);

    // 引擎逻辑还没写的端点：结构化 not_implemented + coverage 0。
    // 注意这里**不再**用 team/evaluate 与 team/compare 当例子——那两个已经接上
    // 规则 baseline，返回的是真实特征；用已实现的端点当「未实现」的例子，
    // 会在实现落地时变成假失败（这条测试就是这么被发现的）。
    // planActions 现在**已接上 planner**。因此它的正确行为不再是 not_implemented，
    // 而是：缺少公开 planner state 时给一个明确的 bad_request，并在错误里说清
    // 需要用 public 而不是私有 serialize()。这不是放宽断言，是断言新契约。
    const planNoPublic = await client.planActions({ turn: 3 });
    assert.equal(planNoPublic.ok, false);
    assert.equal(planNoPublic.code, ROCO_ERROR.BAD_REQUEST);
    assert.equal(planNoPublic.coverage, 0);
    assert.equal(planNoPublic.result, null);
    assert.match(planNoPublic.message, /public/,
      '缺公开 planner state 时必须明确指向 public，而不是含糊报错');

    // summarize_battle 仍然没有服务端点（实施书只定义了 4 个端点）——它必须是
    // 结构化的 not_implemented，而不是编一份摘要。
    const summary = await client.summarizeBattle({ match_id: 'm1' });
    assert.equal(summary.code, ROCO_ERROR.NOT_IMPLEMENTED);
    assert.equal(summary.coverage, 0);
    assert.equal(summary.result, null);
    assert.equal(isNotImplemented(summary), true);
    assert.equal(isUnsupported(summary), true, 'not_implemented 与 unsupported_effect 同属不支持');
  });
});

test('桥：阵容评估已接规则 baseline，且明确不输出胜率', { skip: SKIP }, async () => {
  await withService(async (client) => {
    const team = await client.evaluateTeam(['pet_000225', 'pet_000190', 'pet_000445']);
    assert.equal(team.ok, true, `阵容评估应当可用，实际 ${team.code}: ${team.message}`);
    assert.equal(team.coverage, 1.0, '特征全部来自规则集，故 coverage = 1');
    assert.ok(team.evidence_ids.length >= 3, '每条队伍成员都要有证据 id');
    assert.equal(team.result.calibration, 'rule-baseline-no-simulation');
    // 六个特征都在
    const names = team.result.features.map((f) => f.name).sort();
    assert.deepEqual(names, ['damage', 'energy', 'gaps', 'roles', 'speed', 'types']);
    // 不得输出胜率类字段
    const blob = JSON.stringify(team.result);
    for (const forbidden of ['"winrate"', '"win_rate"', '"overall"', '"tier"']) {
      assert.ok(!blob.includes(forbidden), `规则 baseline 不得输出 ${forbidden}`);
    }
    // limitations / calibration 由信封展开到**顶层**（与 service 的 _envelope 一致），
    // 不在 result 里。注释写清这点，免得下次又找错位置。
    assert.ok(team.limitations.length >= 3, '必须带上局限性说明');
    assert.equal(team.calibration, 'rule-baseline-no-simulation');

    // 非法队伍要 400，而不是猜一个结果
    const bad = await client.evaluateTeam(['pet_000225']);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, ROCO_ERROR.BAD_REQUEST);
    assert.equal(bad.coverage, 0);

    // 换人比较：客户端契约是 (teamBefore, teamAfter)，服务端自己 diff 出换出/换入。
    // 要同时给出改善与代价。
    const comp = await client.compareTeamChange(
      ['pet_000225', 'pet_000190', 'pet_000445'],
      ['pet_000225', 'pet_000190', 'pet_000062']);
    assert.equal(comp.ok, true, `换人比较应当可用，实际 ${comp.code}: ${comp.message}`);
    assert.ok(Array.isArray(comp.result.improves));
    assert.ok(Array.isArray(comp.result.costs));
    assert.ok(comp.result.note.includes('不等于'), '必须写明它不等于「更强」');
  });
});

// ── 5. 规则集不支持（与版本不一致分开）──────────────────────────────────

test('桥：本引擎持有的规则集加载不了 → ruleset_unsupported', { skip: SKIP }, async () => {
  // 让服务**自己声明**持有一个不存在的数据版本：这时问题不是「版本不一致」，
  // 而是「本引擎该有的那份数据加载不了」，两类必须分开。
  await withService(
    async (client, started) => {
      assert.equal(started.ruleset_id, UNKNOWN_RULESET);
      assert.equal(started.ruleset_ok, false, '就绪行应当明说规则集没加载成功');

      const health = await client.health();
      assert.equal(health.ok, false);
      assert.equal(health.code, ROCO_ERROR.RULESET_UNSUPPORTED);
      assert.equal(health.failure_class, ROCO_FAILURE_CLASS.RULESET);
      assert.equal(health.coverage, 0);
      assert.equal(isRulesetUnsupported(health), true);
      assert.equal(isVersionMismatch(health), false, '规则集不支持不能被误判成版本不一致');

      const query = await client.pet('pet_000225');
      assert.equal(query.ok, false);
      assert.equal(query.code, ROCO_ERROR.RULESET_UNSUPPORTED);
      assert.equal(query.failure_class, ROCO_FAILURE_CLASS.RULESET);

      // 与「版本不一致」的可区分性：请求另一个规则集，这时才该报 version_mismatch
      const mismatch = await client.query({ kind: 'pet', pet_id: 'pet_000225' }, { rulesetId: RULESET_ID });
      assert.equal(mismatch.code, ROCO_ERROR.VERSION_MISMATCH);
      assert.notEqual(mismatch.code, query.code, '两类必须能分开');
    },
    { rulesetId: UNKNOWN_RULESET },
  );
});

// ── 6. 服务超时是独立的一类 ─────────────────────────────────────────────

test('桥：服务超时是独立的一类（service）', { skip: SKIP }, async () => {
  // 造一个「只接受连接、永不回包」的服务，把超时钉死在客户端这一侧。
  const stall = createHttpServer(() => {
    /* 故意不回包 */
  });
  await new Promise((resolve, reject) => {
    stall.once('error', reject);
    stall.listen(0, '127.0.0.1', resolve);
  });
  const { port } = stall.address();
  const client = new RocoClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 });
  try {
    const result = await client.health();
    assert.equal(result.ok, false);
    assert.equal(result.code, ROCO_ERROR.TIMEOUT, '超时必须有自己的码');
    assert.equal(result.failure_class, ROCO_FAILURE_CLASS.SERVICE);
    assert.equal(isTimeout(result), true);
    assert.equal(isVersionMismatch(result), false);
    assert.equal(isRulesetUnsupported(result), false);
    assert.equal(isUnsupportedEffect(result), false);
    assert.ok(result.latency_ms >= 150, `超时也要报告耗时，实际 ${result.latency_ms}ms`);
  } finally {
    client.stopService();
    await new Promise((resolve) => stall.close(resolve));
  }
});

// ── 7. 隐藏信息（MC-013）────────────────────────────────────────────────

test('桥：拒绝携带隐藏信息，连发都不发', { skip: SKIP }, async () => {
  // 纯函数层：键名归一化后比对，路径要说清楚
  assert.deepEqual(findHiddenKeys({ state: { opponent_action: { skill: 'x' } } }), ['state.opponent_action']);
  assert.deepEqual(findHiddenKeys({ rng_seed: 42 }), ['rng_seed']);
  assert.deepEqual(findHiddenKeys({ state: { my_hp: 100 } }), []);
  assert.deepEqual(findHiddenKeys({ list: [{ pendingAction: 1 }] }), ['list[0].pendingAction']);
  // seed 在**任何深度**都要被认出：这里曾有一个「只允许 state 下一层」的后门，
  // 真实 seed 能预测同速与伤害的随机结果，所以后门已移除。
  assert.deepEqual(findHiddenKeys({ state: { seed: 7 } }), ['state.seed']);
  assert.deepEqual(findHiddenKeys({ state: { foo: { seed: 7 } } }), ['state.foo.seed']);
  assert.deepEqual(findHiddenKeys({ state: { history: [{ seed: 7 }] } }), ['state.history[0].seed']);
  // env/schema 私有 serialize() 真正会出现的键名（归一化后）
  assert.deepEqual(findHiddenKeys({ state: { _pending_enemy: {} } }), ['state._pending_enemy']);
  assert.deepEqual(findHiddenKeys({ state: { _pending_player: {} } }), ['state._pending_player']);
  assert.deepEqual(findHiddenKeys({ state: { replace_queue: 'enemy' } }), ['state.replace_queue']);

  await withService(async (client) => {
    const refused = await client.planActions({ turn: 1, opponent_pending_action: { skill: 'skill_000744' } });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, ROCO_ERROR.HIDDEN_INFORMATION);
    assert.equal(refused.failure_class, ROCO_FAILURE_CLASS.REQUEST);
    assert.equal(refused.coverage, 0);
    // http_status 为 null = 客户端就地拒绝，请求根本没发出去
    assert.equal(refused.http_status, null, '带隐藏信息的请求不该发到服务端');

    // 服务端也要拦（绕过客户端守卫直连，确认不是只靠客户端自觉）
    const raw = await rawPost(client.baseUrl, '/rules/query', {
      ruleset_id: RULESET_ID,
      state_version: 1,
      query: { kind: 'pet', pet_id: 'pet_000225' },
      opponent_action: { skill: 'skill_000744' },
    });
    assert.equal(raw.status, 400, '服务端应当以 400 拒绝带隐藏信息的请求');
    assert.equal(raw.body.error_type, 'hidden_information');
    assert.equal(raw.body.coverage, 0);
    assert.equal(raw.body.result, null);
    assert.match(raw.body.error, /隐藏信息/, '拒绝理由要说清是隐藏信息');
  });
});

// ── 8. 相性：只用快照显式行，缺行就 unsupported ────────────────────────

test('桥：双属性相性只用快照显式行（缺行时 unsupported，不相乘）', { skip: SKIP }, async () => {
  await withService(async (client) => {
    // 快照在 2×2 处封顶为 3.0：相乘假设会给出 4.0，这里是「用数据不用假设」的判别点
    const capped = await client.typeMultiplier(['光系', '地系'], '草系');
    assert.equal(capped.ok, true, `显式行应当能直接取到：${capped.message || ''}`);
    assert.equal(capped.result.multiplier, 3);
    assert.notEqual(capped.result.multiplier, 4);
    assert.equal(capped.result.assumption_free, true);

    const single = await client.typeMultiplier(['龙系'], '冰系');
    assert.equal(single.ok, true);
    assert.equal(single.result.multiplier, 2);

    // 快照没有这条组合的行 → 不许用「相乘」补
    const missing = await client.typeMultiplier(['光系', '冰系'], '草系');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, ROCO_ERROR.UNSUPPORTED_EFFECT);
    assert.equal(missing.coverage, 0);
    assert.equal(missing.result, null);
  });
});

// ── 9. 工具层声明 ───────────────────────────────────────────────────────

test('桥：工具层声明了 5 个工具且必填项明确（get_visible_state 之外）', () => {
  const names = ROCO_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, ['query_rules', 'evaluate_team', 'compare_team_change', 'plan_actions', 'summarize_battle']);
  for (const tool of ROCO_TOOLS) {
    assert.ok(tool.description.length > 10, `${tool.name} 需要有像样的说明`);
    assert.ok(tool.input_schema.required.includes('state_version'), `${tool.name} 必须要求 state_version`);
    assert.equal(tool.input_schema.additionalProperties, undefined);
  }
});

// ── 10. 异常语义（可选路径）────────────────────────────────────────────

test('桥：assertOk 能把结构化拒绝变成四类可区分的异常', { skip: SKIP }, async () => {
  await withService(async (client) => {
    const version = await client.query({ kind: 'ruleset' }, { rulesetId: UNKNOWN_RULESET });
    assert.throws(() => assertOk(version, '版本不一致'), (error) => {
      assert.ok(error instanceof RocoError);
      assert.equal(error.code, ROCO_ERROR.VERSION_MISMATCH);
      assert.equal(error.failureClass, ROCO_FAILURE_CLASS.VERSION);
      assert.equal(error.retriable, false, '版本不一致重试没有意义');
      return true;
    });

    const good = await client.rulesetSummary();
    assert.equal(isOk(good), true);
    assert.equal(good.coverage, 1);
    assert.ok(good.evidence_ids.length >= 5);
  });
});
