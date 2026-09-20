// Node ↔ Python 规则服务的**端到端规划**测试（`npm run test:plan-e2e`）
//
// 这一组测试回答的是桥与工具层各自单测都答不了的一个问题：
// **真链路（toolbox → roco-client → HTTP → Python 服务）能不能用公开状态产出计划？**
//
// 为什么不能只靠两边的单测：
//   - tests/evals/roco/bridge.test.js 只证明桥**会拒绝**缺 public 的请求，
//     没有证明带正确 public 的请求能**成功**；
//   - tests/evals/roco/toolbox-roco.test.js 用的是假客户端，证明的是工具层的行为，
//     不证明「工具层交给桥的东西，桥能收、服务能算」。
// 两条单测都绿而真实链路对不上，是完全可能的（T02 阶段就发生过：
// 桥发 state、服务要 public，两边单测都绿）。所以这里必须起**真的** Python 服务。
//
// 五条线：
//   ① 公开状态来自引擎本身：用 scripts/roco/gen-plan-state.py 生成，
//      而不是在测试里手抄 —— 手抄的 fixture 会随引擎改动悄悄过期；
//   ② 反证：把同一局的**私有** serialize() 递进去，必须被拒，且客户端与服务端两层都拦；
//   ③ 反证：`state.seed` / `state.foo.seed` / `state.history[0].seed` /
//      对手待执行动作 / `rng_seed` 别名，在**客户端就**被拦下，HTTP 请求数为 0；
//   ④ 反证：两个不同真实内部 seed 的公开面逐字节一致，规划结论一致，
//      且桥实际发出的请求体里没有真实 seed（连它的值都不出现）；
//   ⑤ 反证：真实 seed 恰好等于某个 analysis seed 时结论不变
//      —— 两者一旦被混用，这条会红。
//
// 没有 python3 时**明确 skip**（带原因），而不是假装通过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RocoClient, ROCO_ERROR, RULESET_ID, HIDDEN_KEYS, PRIVATE_PLANE_PATHS, findHiddenKeys } from '../../../src/coach/roco-client.js';
import { executeTool, configureRocoTools, resetRocoTools } from '../../../src/coach/toolbox.js';
import { createRocoService } from '../../../src/server/roco-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const GENERATOR = join(ROOT, 'scripts', 'roco', 'gen-plan-state.py');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';

const PYTHON = RocoClient.probePython(PYTHON_BIN);
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）：端到端规划测试跳过`;

/** 挑一个空闲端口：先绑 0 号端口拿到系统分配的号，再关掉。 */
async function pickFreePort() {
  const probe = createNetServer();
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
      { host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 一个只记账的 HTTP 端点：用来证明「该拦的连发都没发」。 */
async function withSpyServer(run) {
  const seen = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol_version: 1, ruleset_id: RULESET_ID, state_version: 0, coverage: 1, evidence_ids: [], unsupported: [], latency_ms: 0, error_type: null, error: null, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}`, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 让引擎自己生成一份公开 planner state（以及同一局的私有状态，用来做反证）。 */
function generate(seed) {
  const out = execFileSync(PYTHON_BIN, [GENERATOR, String(seed)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** 起一个真服务、跑断言、无论成败都停掉。 */
async function withService(run, { timeoutMs = 20000 } = {}) {
  const client = new RocoClient({
    port: await pickFreePort(), rulesetId: RULESET_ID, timeoutMs, startTimeoutMs: 30000,
  });
  try {
    await client.startService();
    return await run(client);
  } finally {
    await client.stopService();
  }
}

test('公开 planner state 由引擎产出：无 seed/pending，对手后备只有公开事实', { skip: SKIP }, () => {
  const { public: pub, private: priv, team } = generate(7);
  assert.equal(pub.ruleset_id, RULESET_ID);
  assert.equal(pub.schema_version, 1, '公开 schema 版本必须与服务端常量一致');
  assert.equal(pub.self.pets.length, 3);
  // 自己的配招是公开面的一部分（自己的信息），必须带出来，否则规划算不出合法动作
  for (const pid of team) assert.ok(Array.isArray(pub.self.loadouts[pid]), `${pid} 缺少配招`);

  // 公开面里不许出现任何隐藏信息键。用桥自己的检测器查 —— 两边共用同一份词汇表，
  // 否则「测试用的检测器」和「桥用的检测器」可以各自漂移。
  assert.deepEqual(findHiddenKeys(pub), [], '公开状态里出现了隐藏信息键');
  const blob = JSON.stringify(pub);
  for (const forbidden of ['seed', 'pending', '_pending', 'random']) {
    assert.ok(!blob.includes(forbidden), `公开状态里出现了 ${forbidden}`);
  }

  // 私有状态**确实**带着 seed（否则下面的反证是空的）
  assert.ok(Number.isInteger(priv.seed), '私有 serialize() 应当带真实 seed');
  assert.ok(findHiddenKeys(priv).length > 0, '私有 serialize() 必须能被隐藏信息检测认出（否则反证无意义）');

  // 对手后备只暴露位次/id/是否倒下 + 场上那只的公开面板
  for (const entry of pub.opponent.bench) {
    assert.deepEqual(Object.keys(entry).sort(), ['fainted', 'pet_id', 'slot'],
      '对手后备只应有位次/id/是否倒下；血量与配招是隐藏信息');
  }
  assert.equal(typeof pub.opponent.field.hp, 'number', '对手**场上**的面板是公开的（屏幕上写着）');
  assert.ok(pub.opponent.field.max_hp > 0);
});

test('端到端：toolbox → roco-client → 真 Python 服务，公开状态产出计划', { skip: SKIP }, async () => {
  const { public: pub } = generate(7);
  const version = pub.state_version;
  await withService(async (client) => {
    // 先直接打桥：确认「带正确 public 的请求能成功」——bridge.test.js 只证明了会拒绝。
    const direct = await client.planActions(pub, { stateVersion: version, depth: 2, beam: 3, analysisSeeds: [11, 29] });
    assert.equal(direct.ok, true, `直接调桥应当成功，实际 ${direct.code}: ${direct.message}`);
    assert.equal(direct.ruleset_id, RULESET_ID);
    assert.equal(direct.state_version, version, 'state_version 必须原样回传');
    assert.ok(direct.result, '成功时必须有 result');
    assert.ok(Array.isArray(direct.result.analysis_seeds) && direct.result.analysis_seeds.length >= 1);
    assert.equal(direct.result.state_version, version, '回执钉的状态必须就是请求的状态');

    // 再走工具层：这才是模型真正会调的入口。
    configureRocoTools({ client, stateVersion: version });
    try {
      const receipt = await executeTool('plan_actions', { state: pub, state_version: version }, { matchId: 'match-plan-e2e' });
      assert.equal(receipt.ok, true, `工具层应当成功，实际 ${receipt.error_type}: ${receipt.message}`);
      assert.equal(receipt.ruleset_id, RULESET_ID);
      assert.equal(receipt.state_version, version);
      assert.equal(receipt.planAvailable, true, '搜索完成时才允许说「有计划」');
      assert.equal(receipt.timeout.timedOut, false, `不该超时：${receipt.message || ''}`);
      assert.equal(receipt.search.completed, true);
      assert.ok(receipt.recommendation !== null, '完成搜索后必须给出推荐');
      assert.equal(typeof receipt.recommendation, 'string');
      assert.ok(receipt.recommendation.length > 0 && receipt.recommendation.length <= 40);
      assert.ok(receipt.worstCaseTail && typeof receipt.worstCaseTail === 'object', '必须给最坏尾部区间');
      assert.ok(Number.isInteger(receipt.search.nodes) && receipt.search.nodes > 0, '必须报告搜索了多少分支');
      assert.ok(receipt.search.depth >= 1 && receipt.search.depth <= 3);
      // 证据 id 必须能回查到这次公开状态，而不是泛泛一句「引擎说的」
      assert.ok(receipt.evidence_ids.some((id) => id.includes('public-state')),
        `证据 id 应当钉到公开状态：${receipt.evidence_ids.join(', ')}`);
    } finally {
      resetRocoTools();
    }
  });
});

test('反证：把私有 serialize() 递进去必须被拒，客户端与服务端两层都拦', { skip: SKIP }, async () => {
  const { private: priv } = generate(7);
  const version = priv.state_version;

  // 第一层：客户端本地就拦（连发都不发）—— 用一个只记账的端点证明它没被碰到
  await withSpyServer(async ({ baseUrl, seen }) => {
    const local = new RocoClient({ baseUrl, rulesetId: RULESET_ID });
    const refusedLocally = await local.planActions(priv, { stateVersion: version });
    assert.equal(refusedLocally.ok, false);
    assert.equal(refusedLocally.code, ROCO_ERROR.HIDDEN_INFORMATION);
    assert.equal(refusedLocally.result, null);
    assert.equal(refusedLocally.coverage, 0);
    assert.ok(refusedLocally.details.hidden_paths.includes('public.seed'),
      `本地拒绝必须指出是哪个字段：${JSON.stringify(refusedLocally.details)}`);
    assert.equal(seen.length, 0, '隐藏信息必须在发出请求之前就被拦下');

    // 私有 `serialize()` 的真实形态也要被拦：它带的是 `_pending_enemy`（归一化
    // 成 pendingenemy）而不是测试里手搓的 `pending_enemy_action`。
    // 这条曾经是红的——桥的 HIDDEN_KEYS 少了 pendingenemy/player 与 replacequeue，
    // 于是私有状态能从第一层穿过去。现在两边词汇表一一对应。
    for (const key of ['_pending_enemy', '_pending_player', 'replace_queue']) {
      const found = findHiddenKeys({ public: { ...priv, [key]: 1 } });
      assert.ok(found.length > 0, `桥必须认得私有状态的真实键名 ${key}`);
    }
  });

  // 第二层：绕过客户端守卫直接 POST，服务端也必须拦
  await withService(async (client) => {
    const raw = await rawPost(client.baseUrl, '/battle/plan', {
      ruleset_id: RULESET_ID, state_version: version, public: priv,
    });
    assert.equal(raw.status, 400, '服务端必须用 400 而不是 500 拒绝隐藏信息');
    assert.equal(raw.body.ok, false);
    assert.equal(raw.body.error_type, 'hidden_information');
    assert.equal(raw.body.result, null);
    assert.equal(raw.body.coverage, 0);
    assert.match(raw.body.error, /隐藏信息|seed/);
    assert.match(String(raw.body.error), /public\.seed/, '服务端也要指出路径');
  });

  // 工具层在参数校验这一步就抛 invalid-arguments（与其它工具一致：参数不合规抛异常，
  // 由 runtime 转成 policy-invalid-arguments 停止，而不是编一份回执）。
  // 注意这里**故意**不接受「回执式拒绝」：参数关卡要么抛，要么参数合格后进服务；
  // 两种行为混着来，模型就看不出自己错在哪。
  await withSpyServer(async ({ baseUrl, seen }) => {
    configureRocoTools({ client: new RocoClient({ baseUrl, rulesetId: RULESET_ID }), stateVersion: version });
    try {
      assert.throws(
        () => executeTool('plan_actions', { state: priv, state_version: version }, { matchId: 'match-plan-e2e' }),
        /invalid-arguments/,
        '私有状态必须在工具层参数校验就被拒',
      );
    } finally {
      resetRocoTools();
    }
    assert.equal(seen.length, 0, '被参数校验拒掉的请求一个字节都不该发出去');
  });
});

test('反证：任意深度的 seed 与对手待执行动作都在客户端被拦下，HTTP 请求数为 0', { skip: SKIP }, async () => {
  const { public: pub } = generate(7);
  const version = pub.state_version;

  const cases = [
    ['state.seed（一层）', () => ({ ...pub, seed: 7 })],
    ['state.foo.seed（深层）', () => ({ ...pub, foo: { seed: 7 } })],
    ['state.history[0].seed', () => ({ ...pub, history: [{ seed: 7 }] })],
    ['对手待执行动作', () => ({ ...pub, opponent: { ...pub.opponent, pending_enemy_action: {} } })],
    ['rng_seed 别名', () => ({ ...pub, analysis: { rng_seed: 3 } })],
  ];

  await withSpyServer(async ({ baseUrl, seen }) => {
    const client = new RocoClient({ baseUrl, rulesetId: RULESET_ID });
    configureRocoTools({ client, stateVersion: version });
    try {
      for (const [label, make] of cases) {
        const state = make();
        // 检测器先要认得出来，否则「被拦下」可能只是因为形状不合
        assert.ok(findHiddenKeys(state).length > 0, `${label}：检测器应当能认出`);

        // 走桥：桥必须本地拒绝（这一层给的是回执，调用方能看出是哪一类失败）
        const bridged = await client.planActions(state, { stateVersion: version });
        assert.equal(bridged.ok, false, `${label}：桥必须拒绝`);
        assert.equal(bridged.code, ROCO_ERROR.HIDDEN_INFORMATION, `${label}：应当是隐藏信息这一类`);
        assert.equal(bridged.result, null, `${label}：不得给出计划`);

        // 走工具层：参数关卡直接抛，不发请求
        assert.throws(
          () => executeTool('plan_actions', { state, state_version: version }, { matchId: 'match-plan-e2e' }),
          /invalid-arguments/,
          `${label}：工具层参数校验必须拒绝`,
        );
      }
    } finally {
      resetRocoTools();
    }
    assert.equal(seen.length, 0, `隐藏信息必须一个请求都不发（实际发了 ${seen.length} 个）`);
  });

  // 对照组：把隐藏字段去掉，同一个端点就应当**真的**收到请求。
  // 没有这条，上面「请求数为 0」也可能只是因为端点根本打不通。
  await withSpyServer(async ({ baseUrl, seen }) => {
    const client = new RocoClient({ baseUrl, rulesetId: RULESET_ID });
    const ok = await client.planActions(pub, { stateVersion: version });
    assert.equal(ok.ok, true, `干净状态应当被发出去：${ok.code}: ${ok.message}`);
    assert.equal(seen.length, 1, '干净状态必须真的发一个请求');
    assert.equal(seen[0].url, '/battle/plan');
  });
});

test('反证：同一公开观察 + 不同真实内部 seed → 公开面一致、结论一致、请求体无真实 seed', { skip: SKIP }, async () => {
  const a = generate(7);
  const b = generate(12345);
  assert.notEqual(a.seed, b.seed);
  assert.equal(a.private.seed, 7);
  assert.equal(b.private.seed, 12345);

  // 公开面必须逐字节一致（除 state_version：它随事件推进，与 seed 无关）
  const strip = (pub) => {
    const copy = JSON.parse(JSON.stringify(pub));
    delete copy.state_version;
    return JSON.stringify(copy);
  };
  assert.equal(strip(a.public), strip(b.public),
    '两个真实 seed 的公开观察不一致——说明有内部信息泄进了公开 schema');

  const version = a.public.state_version;
  assert.equal(b.public.state_version, version);

  await withService(async (client) => {
    const opts = { stateVersion: version, depth: 2, beam: 3, analysisSeeds: [11, 29] };
    const first = await client.planActions(a.public, opts);
    const second = await client.planActions(b.public, opts);
    assert.equal(first.ok, true, `${first.code}: ${first.message}`);
    assert.equal(second.ok, true, `${second.code}: ${second.message}`);

    // 实质规划结论必须一致：真实 seed 不得影响推荐、主要应对或最坏尾部
    const substance = (r) => JSON.stringify({
      recommended_label: r.result.recommended_label,
      recommendation_stable: r.result.recommendation_stable,
      main_counter: r.result.main_counter,
      worst: r.result.worst,
      expected: r.result.expected,
      analysis_seeds: r.result.analysis_seeds,
      branches_evaluated: r.result.branches_evaluated,
    });
    assert.equal(substance(first), substance(second),
      '不同真实 seed 下规划结论不同——真实 seed 漏进规划了');

    // 请求体里不许出现真实 seed 的**字段名或取值**。这里直接检查桥实际发出的 payload：
    // 它是唯一能反映「到底发了什么」的地方，比断言服务端「应该没读」强。
    const sent = JSON.stringify(client._payload({ public: a.public }, { stateVersion: version }));
    assert.ok(!sent.includes('"seed"'), '请求体里出现了 seed 字段');
    assert.ok(!sent.includes('12345'), '请求体里出现了另一个真实 seed 的值');
    assert.deepEqual(findHiddenKeys(JSON.parse(sent)), [], '桥构造的请求体必须是干净的公开面');

    // 真实 seed 恰好等于某个 analysis seed 时结论必须不变：两者一旦被混用，这条会红
    const overlap = generate(11);
    const third = await client.planActions(overlap.public, opts);
    assert.equal(third.ok, true, `${third.code}: ${third.message}`);
    assert.equal(substance(third), substance(first),
      '真实 seed 等于某个 analysis seed 时结论变化——说明两者被混用了');

    // 反过来：analysis seeds 换了，结论**允许**变化，但区间仍必须是区间。
    // 这条不要求结论不同（可能恰好相同），只要求回执如实报告它用了哪些 seed。
    const other = await client.planActions(a.public, { ...opts, analysisSeeds: [101] });
    assert.equal(other.ok, true);
    assert.deepEqual(other.result.analysis_seeds, [101], '回执必须如实报告实际使用的 analysis seeds');
  });
});

test('三份隐藏信息词汇表必须一一对应（任何一侧改了都会在这里红）', () => {
  // 隐藏信息检测有三份实现，各自在不同的运行时里：
  //   ① Python 服务端  roco/src/roco_env/service.py 的 HIDDEN_KEYS
  //   ② Node 桥        src/coach/roco-client.js 的 HIDDEN_KEYS
  //   ③ 浏览器工具层    src/coach/toolbox.js 的 ROCO_HIDDEN_KEYS（镜像，不能静态 import ①）
  // 只要有一份少了键，就能出现「某层的私有状态从另一层穿过去」的缺口——
  // 这不是假设，本文件上面的测试就是这么发现 _pending_enemy 漏在桥的外面的。
  // 所以这里不靠约定，直接读三个源文件比对。
  const normalize = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

  const readFile = (rel) => readFileSync(join(ROOT, rel), 'utf8');

  const clientKeys = new Set(HIDDEN_KEYS.map(normalize));

  const pySrc = readFile('roco/src/roco_env/service.py');
  const pyBlock = pySrc.slice(pySrc.indexOf('HIDDEN_KEYS = frozenset('), pySrc.indexOf('# 查询 kind'));
  const pyKeys = new Set([...pyBlock.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]));
  assert.ok(pyKeys.size >= 10, `Python 词汇表解析失败（只读到 ${pyKeys.size} 个键）`);

  const toolboxSrc = readFile('src/coach/toolbox.js');
  const tbMatch = toolboxSrc.match(/const ROCO_HIDDEN_KEYS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(tbMatch, 'toolbox.js 里找不到 ROCO_HIDDEN_KEYS');
  const tbKeys = new Set([...tbMatch[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]));

  const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();
  assert.deepEqual(diff(pyKeys, clientKeys), [], 'Python 有、Node 桥缺的隐藏信息键');
  assert.deepEqual(diff(clientKeys, pyKeys), [], 'Node 桥有、Python 缺的隐藏信息键');
  assert.deepEqual(diff(clientKeys, tbKeys), [], 'Node 桥有、工具层镜像缺的隐藏信息键');
  assert.deepEqual(diff(tbKeys, clientKeys), [], '工具层镜像有、Node 桥缺的隐藏信息键');
});

test('两个信任域互不串门：私有端点按路径白名单，教练端点永远扫描', async () => {
  // 演示页需要「本地对局域」（带私有状态）。如果桥的守卫不按路径区分，
  // 开一局都做不到；如果按得太松，教练域就会被顺带放过。这条测试把两侧都钉住。
  assert.deepEqual([...PRIVATE_PLANE_PATHS].sort(), ['/battle/advance', '/battle/legal', '/battle/new'],
    '私有域白名单必须逐条列出，不能按名字猜');
  for (const coachPath of ['/battle/plan', '/rules/query', '/team/evaluate', '/team/compare']) {
    assert.ok(!PRIVATE_PLANE_PATHS.has(coachPath), `教练域端点 ${coachPath} 不得进入私有域白名单`);
  }

  // 私有端点：带真实 seed 的请求**必须**发得出去（否则演示页开不了局）
  await withSpyServer(async ({ baseUrl, seen }) => {
    const client = new RocoClient({ baseUrl, rulesetId: RULESET_ID });
    const seeded = { schema_version: 1, seed: 7, self: { pets: [] }, opponent: { field: {} } };
    const created = await client.battleNew({ team: ['a', 'b', 'c'], seed: 7, stateVersion: 0 });
    assert.equal(created.ok, true, `对局域应当允许带 seed：${created.code}: ${created.message}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/battle/new');
    assert.ok(seen[0].body.includes('"seed":7'), '对局域请求体里确实带了 seed');
    // 同一个带 seed 的对象走教练端点，必须在本地就被拦下（连发都不发）
    const before = seen.length;
    const planned = await client.planActions(seeded, { stateVersion: 0 });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, ROCO_ERROR.HIDDEN_INFORMATION);
    assert.equal(seen.length, before, '教练端点带 seed 必须一个请求都不发');
  });
});

test('对局域的回执带私有状态：桥按路径收下，公开视图只吐白名单字段', async () => {
  // 回执侧同理：引擎的 /battle/new 回执里就有 state.seed。
  // 桥按路径放行它（否则本地对局根本跑不起来），而**返回浏览器**的那一份
  // 由 roco-service.js 的 publicView() 白名单裁剪。这里直接喂一份完整私有回执，
  // 看白名单漏不漏——这是「浏览器永远看不到 seed」的那道闸门。
  const client = new RocoClient({ baseUrl: 'http://127.0.0.1:1', rulesetId: RULESET_ID });
  const service = createRocoService({ client, idleStopMs: 0 });
  try {
    const privateResult = {
      state: { seed: 7, replace_queue: 'enemy', player: { pets: [{ pet_id: 'x', hp: 1 }] } },
      state_version: 3, turn: 4, phase: 'battle', result: null,
      public: {
        schema_version: 1, ruleset_id: RULESET_ID, state_version: 3, turn: 4, phase: 'battle', result: null,
        self: { active: 0, pets: [{ slot: 0, pet_id: 'pet_000225', hp: 400, max_hp: 425, energy: 2, fainted: false }] },
        opponent: { active: 1, living_count: 3,
          field: { slot: 1, pet_id: 'pet_000190', hp: 300, max_hp: 374, energy: 1, fainted: false },
          bench: [{ slot: 0, pet_id: 'pet_000445', fainted: false }] },
      },
      legal: { player: [{ kind: 'skill', label: '龙血', skill_id: 'skill_000750' }], enemy: [{}] },
      needs_replacement: [], events: [{ turn: 4, kind: 'damage', side: 'enemy', detail: { amount: 25 } }],
      strategy: { name: 'greedy_damage', version: 1 }, unsupported_seen: [],
    };
    const view = service.publicView(privateResult);
    const blob = JSON.stringify(view);
    assert.ok(!blob.includes('"seed"'), '公开视图里不得出现 seed');
    assert.ok(!blob.includes('replace_queue'), '公开视图里不得出现 replace_queue');
    assert.ok(!('state' in view), '公开视图不得包含私有 state');
    assert.equal(view.self.pets[0].hp, 400, '场上面板是公开的');
    assert.equal(view.opponent.field.hp, 300, '对手场上面板是公开的（画在屏幕上）');
    assert.deepEqual(Object.keys(view.opponent.bench[0]).sort(), ['fainted', 'pet_id', 'slot'],
      '对手后备只给位次/id/是否倒下');
    assert.equal(view.cpu_legal_count, 1, '对手有几个合法动作是公开的（不公开是哪些）');
    assert.equal(view.legal[0].label, '龙血', '自己的合法动作要带标签，页面要渲染按钮');
  } finally {
    await service.stop();
  }
});

test('标记字段的放行是**按路径**的：分析结果里的动作名不算隐藏信息，状态字段照旧拦', () => {
  // 风险分支（W3-04）的回执里有 `risk.worst_seed_risks[].opponent_action`，
  // 值是「诡刺」这样的动作名字串。纯按名字扫会把它判成协议违规，
  // 于是 /battle/plan 的正常回执被整份丢掉——这是加风险分支时撞出来的真实误报。
  // 修法是**按路径**放行：只在这些分析结果父路径下、且值是字符串时放行。
  const allowed = [
    {risk: {worst_seed_risks: [{opponent_action: '诡刺'}]}},
    {result: {per_seed: [{risk: {top_risks: [{opponent_action: '换上第2位'}]}}]}},
    {branches: [{opponent_choice: '龙血'}]},
  ];
  for (const payload of allowed) {
    assert.deepEqual(findHiddenKeys(payload), [],
      `分析结果里的动作名不该被判成隐藏信息：${JSON.stringify(payload)}`);
  }

  const refused = [
    // 状态字段：同一个键名，出现在 state 下就必须拦
    {state: {opponent_action: '诡刺'}},
    {state: {foo: {opponent_action: '诡刺'}}},
    // 顶层直接出现也不行（顶层是「这条请求带着这个字段」，不是「在描述一个动作」）
    {opponent_action: '诡刺'},
    // 值不是字符串：说明它携带的是**对象**，那就是状态而不是标记
    {risk: {opponent_action: {skill_id: 'skill_000750'}}},
    // 真隐藏信息照旧
    {state: {seed: 7}},
    {state: {_pending_enemy: {}}},
    {result: {replace_queue: 'enemy'}},
  ];
  for (const payload of refused) {
    assert.ok(findHiddenKeys(payload).length > 0,
      `必须继续拦下：${JSON.stringify(payload)}`);
  }
});

test('隐藏信息词汇表现在有唯一事实来源（Python 导出，另外两份派生）', () => {
  // 三份手写迟早会漂——而且漂过一次（桥少了 pendingenemy 等，私有状态能穿过去）。
  // 现在 Python 侧是唯一事实来源，导出成 data/roco/hidden-keys.json，
  // Node 桥与结构测试都从它对齐；这条测试钉住「导出的文件与 Python 一致」。
  const exported = JSON.parse(
    readFileSync(join(ROOT, 'data', 'roco', 'hidden-keys.json'), 'utf8'),
  );
  assert.equal(exported.source, 'roco/src/roco_env/service.py');
  const clientKeys = new Set(HIDDEN_KEYS.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const exportedKeys = new Set(exported.keys);
  const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();
  assert.deepEqual(diff(exportedKeys, clientKeys), [], '导出里有、桥里缺的隐藏信息键');
  assert.deepEqual(diff(clientKeys, exportedKeys), [], '桥里有、导出里缺的隐藏信息键');
});
