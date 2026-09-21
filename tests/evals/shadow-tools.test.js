// 开发者面板的守卫：面板展示的必须是**已发布评测的那次实验**，不能是另一个实验。
//
// 这一层防的失效很安静：有人为了让提示「顺一点」改了 `LOCAL_TOOL_SYSTEM`，
// 或者把 user 提示的键序/条件键改了，面板照常出图，只是**数字不再对得上产物**。
// 没有测试的话，这件事只有靠人记得去比摘要——而人一定会忘。
//
// 所以这里钉三道：
//   ① 摘要：sha256(LOCAL_TOOL_SYSTEM) 必须等于产物里那个值，并且**反向对照**证明它有牙；
//   ② 字面量：`toolPromptFor` 的输出逐个字符定死，键序与条件键一起钉；
//   ③ 直接比对：与 `scripts/roco/agent-trajectories.mjs` 里那份拷贝逐字一致（防两份漂）。
//
// 全程不碰真网关：`askGateway` 的 `fetchImpl` 注入假实现，模型侧的五种结局都能造出来。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  LOCAL_TOOL_SYSTEM, PROMPT_DIGEST_PIN, PROMPT_CHAR_COUNT,
  toolPromptFor, askGateway, modelToolChoice, compareToolChoices, shadowToolDecision,
} from '../../src/coach/shadow-tools.js';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

/** 产物里钉着的那个值（`tests/evals/agent-trajectories-model-v1.manifest.json` 等）。 */
const PINNED = 'a5cb0fbcc53fbecd356b86f921030dac1954d737dfa1af731b452b2f04a6654d';
/** 提示的字符数，与 `docs/roco/SHADOW-REPLAY.md` 的口径一致。 */
const PINNED_CHARS = 524;

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// 真实数据，不是编的：任务取自 `tests/evals/agent-tasks-v1.jsonl`（case_id rl-pet-f0-01），
// 三只精灵取自 S4 规则集 `data/roco/normalized/roco-world-s4-2026-09-10/pets.json`
// （pet_000225 寂灭骨龙 / pet_000190 海豹船长 / pet_000445 黑猫巫师），
// 这个三人阵容在 `tests/evals/roco/bridge.test.js` 里被真实引擎评过。
const CAMP_TASK = {case_id: 'rl-pet-f0-01', message: '寂灭骨龙的种族值是多少？', context: {mode: 'camp'}};
const CAMP_HINTS = {
  mode: 'camp', state_version: 12, locked_pet: 'pet_000225',
  team: ['pet_000225', 'pet_000190', 'pet_000445'],
};
const BATTLE_TASK = {case_id: 'plan-f0-01', message: '帮我看下这局该怎么打。', context: {mode: 'battle'}};
const BATTLE_HINTS = {mode: 'battle', state_version: 3};

// ↓↓ 期望值是**字面量**，由读 `localModelPlanner` 的 `prompt()` 推出来，并另外与它直接比对过。
// 写成一个整串是刻意的：任何键序、条件键、null/缺省的变化都会让这一行对不上。
const CAMP_PROMPT = '{"message":"寂灭骨龙的种族值是多少？","screen":"camp","tools":["read_state","search_rules","compare_actions","simulate_branch","inspect_training","read_match","read_evidence","read_last_turn","query_rules","evaluate_team","compare_team_change","plan_actions","summarize_battle"],"hints":{"state_version":12,"locked_pet":"pet_000225","team":["pet_000225","pet_000190","pet_000445"]},"receipts":null}';
const BATTLE_PROMPT = '{"message":"帮我看下这局该怎么打。","screen":"battle","tools":["read_state","search_rules","compare_actions","simulate_branch","inspect_training","read_match","read_evidence","read_last_turn","query_rules","evaluate_team","compare_team_change","plan_actions","summarize_battle"],"hints":{"state_version":3},"receipts":null}';

/** 假网关：记录每次调用，按需回一段文本或一个错误响应。 */
function fakeFetch(reply, {ok = true, status = 200} = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({url, options});
    return {
      ok, status,
      json: async () => (typeof reply === 'string' ? {choices: [{message: {content: reply}}]} : reply),
    };
  };
  impl.calls = calls;
  return impl;
}

const GATEWAY = 'http://127.0.0.1:8099';

test('摘要守卫：LOCAL_TOOL_SYSTEM 与已发布产物里的那份一字不差', () => {
  assert.equal(sha256(LOCAL_TOOL_SYSTEM), PINNED,
    '提示被动过了：面板将不再复现已发布的评测，数字对不上但没人看得出来');
  assert.equal(LOCAL_TOOL_SYSTEM.length, PINNED_CHARS, '字符数变了，同样是提示被改过的信号');
  // 模块自己公布的那两个常量也必须等于原值，不能是「测试绿、模块写错」。
  assert.equal(PROMPT_DIGEST_PIN, PINNED);
  assert.equal(PROMPT_CHAR_COUNT, PINNED_CHARS);
});

test('反向对照：改动一个字，摘要守卫必须变红（证明这道守卫有牙）', () => {
  const variants = {
    '去掉加粗标记': LOCAL_TOOL_SYSTEM.replace('**默认是停止。**', '默认是停止。'),
    '换一个标点': LOCAL_TOOL_SYSTEM.replace('，', ','),
    '换行变空格': LOCAL_TOOL_SYSTEM.replace('\n', ' '),
    '结尾补一个换行': `${LOCAL_TOOL_SYSTEM}\n`,
    '多一句解释': `${LOCAL_TOOL_SYSTEM}\n（顺便说一句。）`,
  };
  for (const [label, variant] of Object.entries(variants)) {
    assert.notEqual(variant, LOCAL_TOOL_SYSTEM, `${label}：这个变体根本没改动，对照无效`);
    assert.notEqual(sha256(variant), PINNED, `${label}：改动了提示，摘要却没变——守卫是假的`);
  }
});

test('toolPromptFor 逐字复现评测发出去的那条 user 提示', () => {
  const prompt = toolPromptFor({task: CAMP_TASK, hints: CAMP_HINTS});
  assert.equal(prompt, CAMP_PROMPT);
  // 键序也是契约的一部分：顺序变了字节就变了，摘要的意义随之消失。
  assert.deepEqual(Object.keys(JSON.parse(prompt)), ['message', 'screen', 'tools', 'hints', 'receipts']);
  assert.deepEqual(Object.keys(JSON.parse(prompt).hints), ['state_version', 'locked_pet', 'team']);
  // 工具名清单来自 TOOL_CONTRACTS，不是另抄的一份。
  assert.deepEqual(JSON.parse(prompt).tools, Object.keys(TOOL_CONTRACTS));
  // receipts 与发布口径一致：第一次发问时它还不存在。
  assert.equal(JSON.parse(prompt).receipts, null);
});

test('locked_pet / team / planner_margin 按评测的条件逻辑进出提示', () => {
  assert.equal(toolPromptFor({task: BATTLE_TASK, hints: BATTLE_HINTS}), BATTLE_PROMPT);
  assert.equal(BATTLE_PROMPT.includes('locked_pet'), false);
  assert.equal(BATTLE_PROMPT.includes('"team"'), false);
  assert.equal(BATTLE_PROMPT.includes('planner_margin'), false);
  assert.equal(JSON.parse(BATTLE_PROMPT).screen, 'battle');

  const only = (hints) => Object.keys(JSON.parse(toolPromptFor({task: BATTLE_TASK, hints})).hints);
  assert.deepEqual(only({...BATTLE_HINTS, locked_pet: 'pet_000225'}), ['state_version', 'locked_pet']);
  assert.deepEqual(only({...BATTLE_HINTS, team: ['pet_000225']}), ['state_version', 'team']);
  // 边际量是唯一用 `!== undefined` 判断的键：0 是合法值，必须进提示。
  assert.deepEqual(only({...BATTLE_HINTS, planner_margin: 0.25}), ['state_version', 'planner_margin']);
  assert.deepEqual(only({...BATTLE_HINTS, planner_margin: 0}), ['state_version', 'planner_margin']);
  // 真值判断：空串和 null 不进——与评测的 `hints.locked_pet ? ... : {}` 一致。
  assert.deepEqual(only({...BATTLE_HINTS, locked_pet: '', team: null}), ['state_version']);
  // 但**空数组是真值**，`team: []` 会被原样写进提示。这是评测那侧的真实行为
  // （`hints.team ? {team: hints.team} : {}`），照抄它才算复现，不能"顺手修好"。
  assert.deepEqual(only({...BATTLE_HINTS, team: []}), ['state_version', 'team']);
  assert.deepEqual(JSON.parse(toolPromptFor({task: BATTLE_TASK, hints: {...BATTLE_HINTS, team: []}})).hints.team, []);
  // mode 不是 camp 就写 battle（评测里就是这么兜的）。
  assert.equal(JSON.parse(toolPromptFor({task: CAMP_TASK, hints: {state_version: 1}})).screen, 'battle');
  // receipts 可以由调用方显式给，给了就照发（面板默认给 null）。
  assert.equal(JSON.parse(toolPromptFor({task: CAMP_TASK, hints: CAMP_HINTS, receipts: {a: 1}})).receipts.a, 1);
});

test('与评测脚本那份拷贝逐字一致（防两份拷贝各自漂）', async () => {
  const script = await import('../../scripts/roco/agent-trajectories.mjs');
  assert.equal(LOCAL_TOOL_SYSTEM, script.LOCAL_TOOL_SYSTEM, '两份提示已经漂了');
  let captured = null;
  const planner = script.localModelPlanner(CAMP_TASK, CAMP_HINTS,
    {ask: async (payload) => { captured = payload; return '{"stop":true}'; }});
  await planner({});
  assert.equal(captured.system, LOCAL_TOOL_SYSTEM);
  assert.equal(captured.prompt, toolPromptFor({task: CAMP_TASK, hints: CAMP_HINTS}));
  assert.equal(captured.maxTokens, 96);
  assert.equal(captured.temperature, 0);
  assert.equal(captured.timeoutMs, 8000);

  // 条件键的边界也逐条与真身比对——条件逻辑最容易在重写时被"顺手修好"。
  const edge = [
    BATTLE_HINTS,
    {...BATTLE_HINTS, locked_pet: 'pet_000225'},
    {...BATTLE_HINTS, team: ['pet_000225', 'pet_000190', 'pet_000445']},
    {...BATTLE_HINTS, team: []},
    {...BATTLE_HINTS, locked_pet: '', team: null},
    {...BATTLE_HINTS, planner_margin: 0},
    {...BATTLE_HINTS, planner_margin: 0.25, locked_pet: 'pet_000225'},
    {mode: 'camp', state_version: 0},
  ];
  for (const hints of edge) {
    let seen = null;
    const ask = async (payload) => { seen = payload; return '{"stop":true}'; };
    await script.localModelPlanner(BATTLE_TASK, hints, {ask})({});
    assert.equal(toolPromptFor({task: BATTLE_TASK, hints}), seen.prompt, `提示与真身不一致：${JSON.stringify(hints)}`);
  }
});

test('askGateway 发出网关认的请求体，并如实返回延迟', async () => {
  const fetchImpl = fakeFetch('{"stop":true}');
  const reply = await askGateway(GATEWAY, {system: LOCAL_TOOL_SYSTEM, prompt: 'P', maxTokens: 32, temperature: 0.2, timeoutMs: 1500}, fetchImpl);
  assert.equal(reply.text, '{"stop":true}');
  assert.equal(typeof reply.latency_ms, 'number');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${GATEWAY}/v1/chat/completions`);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body.messages, [{role: 'system', content: LOCAL_TOOL_SYSTEM}, {role: 'user', content: 'P'}]);
  assert.equal(body.max_tokens, 32);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.timeout_ms, 1500);
  assert.equal(fetchImpl.calls[0].options.method, 'POST');

  // 没有 system 时只发 user 一条，与 gatewayAsk 一致。
  const noSystem = fakeFetch('{"stop":true}');
  await askGateway(GATEWAY, {system: null, prompt: 'P'}, noSystem);
  assert.deepEqual(JSON.parse(noSystem.calls[0].options.body).messages, [{role: 'user', content: 'P'}]);
});

test('askGateway 非 2xx 抛出带 code 的错误（错误语义与 gatewayAsk 相同）', async () => {
  const withCode = fakeFetch({error: {code: 'unavailable', message: '模型没起来'}}, {ok: false, status: 503});
  await assert.rejects(() => askGateway(GATEWAY, {prompt: 'P'}, withCode),
    (error) => error.code === 'unavailable' && /模型没起来/.test(error.message));
  const withoutCode = fakeFetch({}, {ok: false, status: 500});
  await assert.rejects(() => askGateway(GATEWAY, {prompt: 'P'}, withoutCode),
    (error) => error.code === 'http-error' && /HTTP 500/.test(error.message));
});

test('modelToolChoice：正常工具提议', async () => {
  const fetchImpl = fakeFetch('{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}');
  const result = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl});
  assert.deepEqual(result.choice, {tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}});
  assert.equal(result.error, null);
  assert.equal(typeof result.latency_ms, 'number');
  assert.equal(result.raw, '{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}');
  // 面板发的 system 默认就是评测那份。
  assert.equal(JSON.parse(fetchImpl.calls[0].options.body).messages[0].content, LOCAL_TOOL_SYSTEM);
});

test('modelToolChoice：模型的正文里夹着解释和代码块时也能抠出第一个对象', async () => {
  const reply = '好的，我建议：\n```json\n{"tool":"read_evidence","args":{"turn":4}}\n```\n以上。';
  const result = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch(reply)});
  assert.deepEqual(result.choice, {tool: 'read_evidence', args: {turn: 4}});
  // args 不是对象时按评测口径退化成空对象，不把字符串原样带出去。
  const bad = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch('{"tool":"read_state","args":"nope"}')});
  assert.deepEqual(bad.choice, {tool: 'read_state', args: {}});
  assert.equal(bad.error, null);
});

test('modelToolChoice：{"stop":true} 是合法决定，不是失败', async () => {
  const result = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch('{"stop":true}')});
  assert.deepEqual(result.choice, {stop: true, reason: 'model-stop'});
  assert.equal(result.error, null);
  // 外层花括号后面还有字也不影响：只取第一个配平的对象。
  const noisy = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch('{"stop":true} 我觉得够了')});
  assert.deepEqual(noisy.choice, {stop: true, reason: 'model-stop'});
});

test('modelToolChoice：抠不出 JSON 一律 unparseable，且不抛', async () => {
  for (const reply of ['我不知道该查什么', '{"tool":', '', 'stop']) {
    const result = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch(reply)});
    assert.deepEqual(result.choice, {stop: true, reason: 'unparseable'}, `回复「${reply}」应按 unparseable 处理`);
    assert.equal(result.error, 'unparseable');
  }
  // 解析成功但没有工具名，也不是「提议」：照评测口径停止。
  const noTool = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch('{"kind":"pet"}')});
  assert.deepEqual(noTool.choice, {stop: true, reason: 'no-tool'});
  assert.equal(noTool.error, 'no-tool');
});

test('modelToolChoice：编出来的工具名被显式拒绝，且不抛', async () => {
  for (const name of ['delete_everything', 'get_pet_info', 'ReadState']) {
    const result = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: fakeFetch(`{"tool":"${name}","args":{}}`)});
    assert.deepEqual(result.choice, {stop: true, reason: 'unknown-tool', tool: name}, `${name} 不在工具契约里`);
    assert.equal(result.error, 'unknown-tool');
  }
  // 大小写敏感：契约里的名字是小写，'ReadState' 不能因为「看起来像」就放行。
  assert.equal(Object.hasOwn(TOOL_CONTRACTS, 'ReadState'), false);
});

test('modelToolChoice：网络失败 / 非 2xx 都记成失败，不抛，也不假装模型说了话', async () => {
  const boom = async () => { throw new TypeError('fetch failed'); };
  const dead = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P', fetchImpl: boom});
  assert.deepEqual(dead.choice, {stop: true, reason: 'ask-failed'});
  assert.equal(dead.error, 'ask-failed');
  assert.equal(dead.raw, null);
  assert.equal(typeof dead.latency_ms, 'number');

  const down = await modelToolChoice({baseUrl: GATEWAY, prompt: 'P',
    fetchImpl: fakeFetch({error: {code: 'timeout', message: '超时'}}, {ok: false, status: 504})});
  assert.deepEqual(down.choice, {stop: true, reason: 'timeout'});
  assert.equal(down.error, 'timeout');

  // 网关地址没配：同样只是记一笔，不能让路由抛出去。
  const noGateway = await modelToolChoice({baseUrl: null, prompt: 'P'});
  assert.deepEqual(noGateway.choice, {stop: true, reason: 'no-gateway'});
  assert.equal(noGateway.error, 'no-gateway');
});

test('compareToolChoices：一致与不一致都要说清，且说明里不出现工程词', () => {
  const rule = {tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}};

  // 同一个工具、参数写法不同 → 仍算一致：参数不是这个面板要比的东西。
  const agree = compareToolChoices({ruleChoice: rule, modelChoice: {tool: 'query_rules', args: {kind: 'pet', name: '寂灭骨龙'}}});
  assert.equal(agree.agree, true);
  assert.equal(agree.rule, '查询规则事实');
  assert.equal(agree.model, '查询规则事实');

  // 两边都喊停 → 也算一致（都判断「不用查」）。
  const bothStop = compareToolChoices({ruleChoice: {stop: true}, modelChoice: {stop: true, reason: 'model-stop'}});
  assert.equal(bothStop.agree, true);
  assert.match(bothStop.rule, /不调用工具/);
  assert.match(bothStop.model, /模型自己判断证据够了/);

  // 不一致：规则要查规则事实，模型提议去看某一回合。
  const disagree = compareToolChoices({ruleChoice: rule, modelChoice: {tool: 'read_evidence', args: {turn: 4}}});
  assert.equal(disagree.agree, false);
  assert.equal(disagree.rule, '查询规则事实');
  assert.equal(disagree.model, '查看某一回合');

  // 规则说停、模型要查 → 不一致，而且面板必须照实显示。
  const half = compareToolChoices({ruleChoice: {stop: true}, modelChoice: rule});
  assert.equal(half.agree, false);

  // 规则那一侧压根没给决定（比如它给的是行动建议，不是工具选择）→ **不是一致**。
  // 不这么判的话 `null === null` 会让「规则什么都没说 + 模型喊停」显示成「两边一致」，
  // 那是编出来的一致，正是这个面板最该防的。
  const absent = compareToolChoices({ruleChoice: null, modelChoice: {stop: true, reason: 'model-stop'}});
  assert.equal(absent.agree, false);
  assert.equal(absent.rule, '没有输出');
  const bothAbsent = compareToolChoices({ruleChoice: null, modelChoice: null});
  assert.equal(bothAbsent.agree, false);
  const junk = compareToolChoices({ruleChoice: {}, modelChoice: {}});
  assert.equal(junk.agree, false);

  for (const [label, result] of Object.entries({agree, bothStop, disagree, half, absent, bothAbsent, junk})) {
    const note = result.note;
    assert.equal(typeof note, 'string');
    assert.ok((note.match(/[\u4e00-\u9fa5]/g) || []).length >= 12, `${label}：说明要是给玩家读的中文`);
    // 三件事必须说清：只提议工具 / 参数仍要过引擎校验 / 规则引擎说了算。
    assert.match(note, /模型/, `${label}：必须点明这是模型的提议`);
    assert.match(note, /校验/, `${label}：必须说明参数仍要过引擎校验`);
    assert.match(note, /以规则引擎为准/, `${label}：必须说明规则引擎是事实来源`);
    for (const word of ['margin', 'score', 'state_version', 'coverage', '{}']) {
      assert.equal(note.includes(word), false, `${label}：说明里出现了工程词「${word}」`);
    }
    assert.equal(/[{}]/.test(note), false, `${label}：说明里出现了花括号`);
    assert.equal(note.includes('胜率'), false, `${label}：不许出现胜率字样`);
  }
});

test('compareToolChoices：契约里的每个工具都有中文说法，不会把工具名原样端给玩家', () => {
  for (const name of Object.keys(TOOL_CONTRACTS)) {
    const {rule} = compareToolChoices({ruleChoice: {tool: name}, modelChoice: {tool: name}});
    assert.match(rule, /[\u4e00-\u9fa5]/, `${name} 缺中文说法`);
    assert.notEqual(rule, name, `${name} 直接把工具名端出去了`);
    assert.equal(rule.includes(name), false, `${name} 的中文说法里还夹着工具名`);
  }
});

test('shadowToolDecision：一步拿到面板要的全部字段（含摘要钉子）', async () => {
  const fetchImpl = fakeFetch('{"tool":"evaluate_team","args":{"team":["pet_000225","pet_000190","pet_000445"]}}');
  const out = await shadowToolDecision({
    baseUrl: GATEWAY, task: CAMP_TASK, hints: CAMP_HINTS,
    ruleChoice: {tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}}, fetchImpl,
  });
  assert.equal(out.prompt, CAMP_PROMPT);
  assert.equal(out.system, LOCAL_TOOL_SYSTEM);
  assert.equal(out.prompt_digest_pin, PINNED);
  assert.equal(out.prompt_char_count, PINNED_CHARS);
  assert.deepEqual(out.model.choice, {tool: 'evaluate_team', args: {team: ['pet_000225', 'pet_000190', 'pet_000445']}});
  assert.equal(out.model.error, null);
  assert.equal(out.compare.agree, false);
  assert.equal(out.compare.rule, '查询规则事实');
  assert.equal(out.compare.model, '评估阵容');

  // 同时一致的情形：规则引擎和模型都提议查规则事实。
  const same = await shadowToolDecision({
    baseUrl: GATEWAY, task: CAMP_TASK, hints: CAMP_HINTS,
    ruleChoice: {tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}},
    fetchImpl: fakeFetch('{"tool":"query_rules","args":{"kind":"pet","pet_id":"pet_000225"}}'),
  });
  assert.equal(same.compare.agree, true);

  // 网关挂了也要有完整返回：面板照样能显示「规则引擎这一列」和「模型没答复」。
  const offline = await shadowToolDecision({
    baseUrl: null, task: CAMP_TASK, hints: CAMP_HINTS,
    ruleChoice: {tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_000225'}},
  });
  assert.deepEqual(offline.model.choice, {stop: true, reason: 'no-gateway'});
  assert.equal(offline.compare.agree, false);
  assert.equal(offline.prompt, CAMP_PROMPT);
});
