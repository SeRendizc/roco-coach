// 开发者面板的「影子工具决定」：同一条提示，一边问规则引擎，一边问本地模型。
//
// 这个模块要回答老板的问题只有一句：**本地模型到底有没有在选工具？**
// 但它同时要挡住一句更危险的误读——「模型也在选，那它是不是也算一个决策者」。
// 所以面板展示的是**提议**，不是结论；规则引擎仍是唯一的事实来源。
//
// 为什么必须逐字复现评测的提示
// --------------------------
// 已发布的数字（`reports/roco/shadow-replay-*.json`、`tests/evals/agent-trajectories-model-v1.jsonl`）
// 都是拿 `scripts/roco/agent-trajectories.mjs` 里那份 system 提示跑出来的，产物里钉着它的 sha256。
// 面板如果自己写一份「差不多的」提示，那它展示的就是**另一个实验戴着同一个名字**：
// 数字对不上，而且看不出来。所以这里把提示、user 提示的构造、解析判据、工具名清单
// 全部按评测那一份复刻，并且让「有没有漂」变成**机器可核对**的东西：
//
//   ① `LOCAL_TOOL_SYSTEM` 的 sha256 必须等于 `PROMPT_DIGEST_PIN`
//      （逐字守卫，改一个字就红，见 tests/evals/shadow-tools.test.js）；
//   ② `toolPromptFor` 的输出有**字面量定死**的期望值，键序与条件键一起钉住；
//   ③ 测试另外把本模块的提示与脚本里那一份**直接字符串比对**，防两份拷贝各自漂。
//
// 为什么这里**不**静态 import `node:*`
// ----------------------------------
// 这个模块给服务端路由用。为了算一个摘要去引 `node:crypto`，等于把「服务端能不能起」
// 绑在一个根本不需要的依赖上。摘要守卫放在测试里（那是 Node 环境，随便用）；
// 模块这边只**公布钉子字符串**，面板把它显示出来，人可以拿去和产物对。
//
// 为什么不 import `scripts/`
// -------------------------
// 那是评测脚本的家，会拖进 `node:crypto` 与整个评测世界构造。服务端不该依赖评测脚本，
// 评测脚本也不该依赖服务端。所以 `askGateway` 在这里**重写一遍**（与
// `scripts/roco/local-model-ask.mjs` 的 `gatewayAsk` 同款语义），代价是两份小实现，
// 收益是「面板能不能开」与「评测能不能跑」互不牵连。
//
// 与 `scripts/roco/agent-trajectories.mjs` 的关系：**目前是两份拷贝**。
// 那个脚本自己那一份仍归它所有；两份的去重由父任务处理（本次改动不允许碰那个脚本）。
// 在去重之前，「两份没漂」由上面 ① ③ 两道一起守。

import {TOOL_CONTRACTS} from './toolbox.js';

/**
 * 评测真正发出去的 system 提示，**逐字**搬自
 * `scripts/roco/agent-trajectories.mjs` 的 `LOCAL_TOOL_SYSTEM`。
 *
 * 不要「顺手改通顺」：这段文字是已发布数字的一部分。措辞一改，
 * 面板展示的就不再是那次评测，而摘要守卫会立刻变红。
 */
export const LOCAL_TOOL_SYSTEM = [
  '你在为游戏教练决定「下一步查不查工具、查哪个」。只输出一行 JSON，不要解释，不要思考过程。',
  '可用工具：query_rules（查规则事实：精灵/技能/学习表/术语/属性相性）、evaluate_team（评阵容）、',
  'compare_team_change（换人前后对比）、plan_actions（给行动建议）、read_evidence（读某回合）、',
  'read_match（整局统计）、read_last_turn（上一回合）、search_rules（战术检索）。',
  '需要查证时输出 {"tool":"工具名","args":{...}}；证据已经足够时输出 {"stop":true}。',
  '**默认是停止。** 只有当答案依赖的某个具体事实不在下面的 receipts 里、也不在常识里时才调工具。',
  '查规则事实用 query_rules，`kind` 取 pet/skill/learnset/term/type_row/type_multiplier/ruleset 之一，',
  '并给出该 kind 需要的定位参数（精灵用 pet_id，技能用 name）。',
  '参数里不要放 state_version（运行时会给）。不要编工具名，不要编参数名。',
].join('\n');

/**
 * 上面这段提示在**已提交产物**里的 sha256。
 *
 * 出处（同一份摘要，多处钉着）：`tests/evals/agent-trajectories-model-v1.manifest.json`、
 * `reports/roco/shadow-replay-*.json`、`docs/roco/SHADOW-REPLAY.md`。
 * 这里存的是**值**，不是算出来的结果——因为本模块不能引 `node:crypto`（见文件头）。
 * 真伪由测试用 `node:crypto` 现算并比对，所以它不可能是一句没人核对的注释。
 */
export const PROMPT_DIGEST_PIN = 'a5cb0fbcc53fbecd356b86f921030dac1954d737dfa1af731b452b2f04a6654d';

/** 提示的字符数（UTF-16 码元）。和摘要钉子成对：改一个字，两个都会变。 */
export const PROMPT_CHAR_COUNT = 524;

/** 可用工具名一律**取自** TOOL_CONTRACTS，不在这里另抄一份；抄一份就是等着漂。 */
const TOOL_NAMES = Object.freeze(Object.keys(TOOL_CONTRACTS));

/** 工具名 → 面板上的中文说法。键必须覆盖 TOOL_CONTRACTS 的全部工具（测试会逐键核对）。 */
const TOOL_LABELS = Object.freeze({
  read_state: '查看当前局面',
  search_rules: '检索规则与战术',
  compare_actions: '对比可选行动',
  simulate_branch: '模拟行动的后续走向',
  inspect_training: '查看培养情况',
  read_match: '查看整局统计',
  read_evidence: '查看某一回合',
  read_last_turn: '查看上一回合',
  query_rules: '查询规则事实',
  evaluate_team: '评估阵容',
  compare_team_change: '对比换人前后',
  plan_actions: '给出行动建议',
  summarize_battle: '复盘摘要',
});

/** 停止原因 → 中文说法。原因码本身沿用 `src/coach/local-model.js` 的词汇，不另造。 */
const STOP_LABELS = Object.freeze({
  'model-stop': '模型自己判断证据够了',
  unparseable: '模型这一轮没有给出可用的工具决定',
  'unknown-tool': '模型说的工具名不在可用列表里',
  'no-tool': '模型这一轮没有给出工具名',
  'no-gateway': '没有配置本地模型网关',
  'ask-failed': '模型这一轮没有答复',
});

// 玩家可读的说明：三件事必须说清——模型只提议工具、参数仍要过引擎校验、规则引擎说了算。
// 后半句是**共享**的，避免两个分支将来只改一处而漏掉另一处。
const MODEL_PROPOSES_ONLY = '本地模型只提出「要查哪个工具」，不替规则引擎做决定；'
  + '它给的参数仍要由规则引擎逐项校验后才生效，最终结论始终以规则引擎为准。';
const AGREE_NOTE = `这一次两边提出的工具提议一致。${MODEL_PROPOSES_ONLY}`;
const DISAGREE_NOTE = '这一次两边提出的工具提议不一致，面板如实并列，'
  + `不代表模型可以推翻规则引擎。${MODEL_PROPOSES_ONLY}`;

/**
 * 复现 `localModelPlanner` 里那个 `prompt()` 造出来的 user 提示。
 *
 * 键序（message → screen → tools → hints → receipts）、`hints` 里的条件键、
 * 以及 `receipts` 的取值都必须与评测一致——不然字节不同，摘要守卫就只是装饰。
 *
 * 三个条件键的判真方式**照抄**评测：`locked_pet` / `team` 用真值判断（空串、空数组、
 * null 一律不进提示），`planner_margin` 用 `!== undefined`（0 是合法边际量，必须进）。
 *
 * 注意：已发布的那次评测里 `receipts` **恒为 null**（模型臂只问一次，
 * 第一次发问时 receipts 还没产生）。所以要按发布口径复现，这里就必须传 null。
 */
export function toolPromptFor({task, hints, receipts = null}) {
  const h = hints || {};
  return JSON.stringify({
    message: task?.message,
    screen: h.mode === 'camp' ? 'camp' : 'battle',
    tools: Object.keys(TOOL_CONTRACTS),
    hints: {
      state_version: h.state_version,
      ...(h.locked_pet ? {locked_pet: h.locked_pet} : {}),
      ...(h.team ? {team: h.team} : {}),
      ...(h.planner_margin !== undefined ? {planner_margin: h.planner_margin} : {}),
    },
    receipts,
  });
}

/**
 * 问一次本地网关：一次请求、带超时，拿不到就**如实抛**，由调用方记成失败。
 *
 * 与 `scripts/roco/local-model-ask.mjs` 的 `gatewayAsk` 同款语义（那边是评测和影子回放共用的
 * 唯一实现，这里**刻意重写一遍**，理由见文件头「为什么不 import scripts/」）：
 *   - body 是网关认的 OpenAI 兼容形状，额外带 `timeout_ms`（网关自己也计时）；
 *   - 非 2xx → 抛一个带 `code` 的 Error，`code` 优先取 `error.code`，否则 `http-error`；
 *   - 返回 `{text, latency_ms}`。这里比 `gatewayAsk` 多一个延迟字段：面板要显示它，
 *     而面板不该自己去猜一次调用的耗时。
 *
 * `fetchImpl` 可注入，测试不必真的起网关。默认取全局 `fetch`（Node 18+ 自带）。
 */
export async function askGateway(baseUrl,
  {system = null, prompt, maxTokens = 96, temperature = 0, timeoutMs = 8000} = {},
  fetchImpl = fetch) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        messages: [...(system ? [{role: 'system', content: system}] : []),
          {role: 'user', content: prompt}],
        max_tokens: maxTokens, temperature, timeout_ms: timeoutMs,
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`),
        {code: payload?.error?.code || 'http-error'});
    }
    return {text: payload.choices?.[0]?.message?.content ?? '', latency_ms: Date.now() - started};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型输出里抠出第一个配平的 JSON 对象；抠不出来返回 null。
 *
 * 判据与评测的 `extractFirstJson` **逐行一致**：从第一个 `{` 起数花括号配平，
 * 配平处试一次 `JSON.parse`，失败就返回 null（不猜、不补、不截断）。
 * 模型爱写「好的，我建议：```json{...}```」，所以不能直接 `JSON.parse(全文)`。
 */
function extractFirstJsonObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 一次模型侧的工具提议：问网关 → 按评测的判据解析 → **永不抛**。
 *
 * 面板最怕的不是模型答错，而是「模型答错时页面炸了」，于是人只看到规则引擎那一列，
 * 误以为模型也同意。所以任何模型侧失败都在返回值里记一笔，不在异常里。
 *
 * 返回 `{choice, raw, latency_ms, error}`：
 *   - `choice` —— `{tool, args}` 或 `{stop: true, reason}`；
 *   - `raw`    —— 模型原文前 200 字（与评测落盘的截断长度一致），失败时为 null；
 *   - `error`  —— 失败码字符串或 null。刻意用字符串而不是 Error 对象：
 *                它要能原样穿过面板的 JSON 通道，不能被序列化成 `{}`。
 *
 * 判定顺序（照抄评测，只多一步「未知工具」的显式拒绝）：
 *   网关没配 / 抛错 → 停止；抠不出对象 → `unparseable`；`stop === true` → 模型自己喊停；
 *   没有 `tool` 字段 → `no-tool`；工具名不在 TOOL_CONTRACTS → `unknown-tool`；否则就是提议。
 *
 * 这里**不**往 args 里补 `state_version`：那是运行时的权威量，评测里也由运行时覆盖。
 * 面板只展示模型「想查什么」，参数是否会真的被采纳，由引擎的校验说了算。
 */
export async function modelToolChoice({system = LOCAL_TOOL_SYSTEM, prompt, baseUrl = null,
  maxTokens = 96, temperature = 0, timeoutMs = 8000, fetchImpl = fetch} = {}) {
  const started = Date.now();
  if (typeof baseUrl !== 'string' || !baseUrl) {
    return {choice: {stop: true, reason: 'no-gateway'}, raw: null,
      latency_ms: Date.now() - started, error: 'no-gateway'};
  }
  let text = null;
  let latency = null;
  try {
    const reply = await askGateway(baseUrl, {system, prompt, maxTokens, temperature, timeoutMs}, fetchImpl);
    text = reply.text;
    latency = reply.latency_ms;
  } catch (error) {
    const code = error?.code || 'ask-failed';
    return {choice: {stop: true, reason: code}, raw: null,
      latency_ms: Date.now() - started, error: code};
  }
  const raw = String(text ?? '').slice(0, 200);
  const parsed = extractFirstJsonObject(text);
  const stop = (reason) => ({choice: {stop: true, reason}, raw, latency_ms: latency, error: reason});
  if (!parsed || typeof parsed !== 'object') return stop('unparseable');
  // 「证据够了」是提示词明确鼓励的决定，不是失败：error 为 null，面板别把它画成红的。
  if (parsed.stop === true) {
    return {choice: {stop: true, reason: 'model-stop'}, raw, latency_ms: latency, error: null};
  }
  if (typeof parsed.tool !== 'string') return stop('no-tool');
  // 编工具名是评测专门在抓的失效模式（引擎会直接判非法），这里显式拒绝而不是照转。
  if (!TOOL_NAMES.includes(parsed.tool)) {
    return {choice: {stop: true, reason: 'unknown-tool', tool: parsed.tool}, raw,
      latency_ms: latency, error: 'unknown-tool'};
  }
  const args = (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
    ? parsed.args : {};
  return {choice: {tool: parsed.tool, args}, raw, latency_ms: latency, error: null};
}

/** 取出一个 choice 里的工具名；停止、没有工具名、非对象一律 null。 */
function toolNameOf(choice) {
  return (choice && typeof choice === 'object' && typeof choice.tool === 'string') ? choice.tool : null;
}

/**
 * 这一侧**到底有没有给出决定**：要么明确喊停，要么给了一个工具名。
 *
 * 必须把「没给」和「喊停」分开，否则 `ruleChoice: null` 配上模型喊停会算出
 * `null === null` → 一致，面板就会显示「两边一致」——而真实情况是规则那一侧
 * 什么都没说。这种「编出来的一致」正是这个模块最该防的东西。
 */
function hasDecision(choice) {
  return Boolean(choice && typeof choice === 'object'
    && (choice.stop === true || typeof choice.tool === 'string'));
}

/** 面板上给一个 choice 的中文标签。 */
function labelOf(choice) {
  if (!choice || typeof choice !== 'object') return '没有输出';
  if (choice.stop === true) {
    const text = STOP_LABELS[choice.reason] || `原因未说明（${choice.reason || '—'}）`;
    return `不调用工具：${text}`;
  }
  const tool = toolNameOf(choice);
  if (tool === null) return '没有输出';
  return TOOL_LABELS[tool] || (TOOL_NAMES.includes(tool) ? tool : `未知工具：${tool}`);
}

/**
 * 并列两边的工具提议。
 *
 * `agree` 比的是**工具名**（两边都喊停也算一致），**不比参数**。理由是刻意的：
 * 参数要过 `validToolArgs` 与真实引擎才算数，把两串参数摆在一起比「像不像」，
 * 会让人以为模型的参数也算一份权威——那正是这个面板要否掉的读法。
 *
 * 还有一条同样刻意的规矩：**任一侧没给出决定，就不是一致**。规则引擎那一侧如果
 * 根本不是「选工具」（例如它给的是行动建议），调用方应当传 null，此时 `agree` 为
 * false，面板也就不会把「没得比」画成「对上了」。
 *
 * `note` 是给玩家/负责人读的中文，必须一句话说清三件事：模型只提议工具、
 * 参数仍要过引擎校验、规则引擎是事实来源。里面**不出现**工程词（margin / score /
 * state_version / coverage / 花括号），否则这段文字会被当成「引擎在说黑话」。
 */
export function compareToolChoices({ruleChoice = null, modelChoice = null} = {}) {
  const agree = hasDecision(ruleChoice) && hasDecision(modelChoice)
    && toolNameOf(ruleChoice) === toolNameOf(modelChoice);
  return {
    agree,
    rule: labelOf(ruleChoice),
    model: labelOf(modelChoice),
    note: agree ? AGREE_NOTE : DISAGREE_NOTE,
  };
}

/**
 * 面板路由的**一步**入口：把上面几件事按顺序串好，只返回能直接渲染的东西。
 *
 * 规则引擎那一侧的提议由调用方给（它本来就要先算局面），本模块不重复实现规划器——
 * 面板要证明的是「模型也在参与」，不是「本模块也有一份规划器」。
 *
 * 想复现已发布的评测口径，调用方只需要给 `task`、`hints`（mode / state_version /
 * locked_pet / team），**不要**传 `planner_margin`、也**不要**传 receipts：
 * 那次评测里两个键都没有出现过，多传一个字节就不叫同一条提示了。
 */
export async function shadowToolDecision({baseUrl, task, hints, ruleChoice = null, receipts = null,
  system = LOCAL_TOOL_SYSTEM, maxTokens = 96, temperature = 0, timeoutMs = 8000,
  fetchImpl = fetch} = {}) {
  const prompt = toolPromptFor({task, hints, receipts});
  const model = await modelToolChoice({system, prompt, baseUrl, maxTokens, temperature, timeoutMs, fetchImpl});
  return {
    system,
    prompt,
    prompt_digest_pin: PROMPT_DIGEST_PIN,
    prompt_char_count: PROMPT_CHAR_COUNT,
    rule: ruleChoice,
    model,
    compare: compareToolChoices({ruleChoice, modelChoice: model.choice}),
  };
}
