#!/usr/bin/env node
// 「49 例标准答案复核表」v3（2026-09-25）：把人类**直接写在表里的批注**抽出来当事实源，
// 再按这些批注推出的规则去优化尚未批阅的题（c21+）。本脚本只读评测产物、写 Markdown，**不改标准答案**。
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const EVAL = 'reports/live-model-eval.json';
const INV = 'reports/roco/packet-vs-gold-2026-09-25/packet-inventory-49-fields.json';
const OUT = 'reports/roco/gold-review-2026-09-25/GOLD-REVIEW.md';
const HUMAN_MARK = '<!--人类批注-->';
const ADVICE_SUFFIXES = [
  '（数字必须有出处）。', '不给"对手会做什么"。', '再按上面 9 条规则定"问模型/问引擎"。',
  '问模型 1 次（在不确定性下给建议）。', '别在对局上下文里硬答。', '**标准答案要按人类口径改写或废掉**。',
];
const BOILER = /（\*\*待人类确认\*\*：这条对不对？期望工具要不要改？）/;

/** 从上一版表里抽出人类写在「建议」行之后的批注（原话，逐字）。 */
function readHumanNotes() {
  if (!existsSync(OUT)) return {};
  const notes = {};
  let id = null;
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    const h = line.match(/^### (c\d+)/);
    if (h) { id = h[1]; continue; }
    if (!id) continue;
    const m = line.match(BOILER);
    if (m) {
      const tail = line.slice(m.index + m[0].length).trim();
      if (tail) notes[id] = tail;
      continue;
    }
    // v3 格式：`- **人类批注（原话，逐字）**：…`
    const m3 = line.match(/\*\*人类批注（原话，逐字）\*\*：\s*(.+)$/);
    if (m3) { notes[id] = m3[1].trim(); continue; }
    // v4：显式标记之后就是人类写的字
    const m4 = line.split(HUMAN_MARK);
    if (m4.length === 2 && m4[1].trim()) { notes[id] = m4[1].trim(); continue; }
    // v3 兜底：人类把字**直接写在「类推建议」行尾** ⇒ 按我生成的固定结尾把它切出来
    if (/\*\*类推建议\*\*/.test(line)) {
      const suffix = ADVICE_SUFFIXES.filter((t) => line.includes(t)).sort((a, b) => b.length - a.length)[0];
      if (suffix) {
        const rest = line.slice(line.indexOf(suffix) + suffix.length).trim();
        if (rest) notes[id] = rest;
      }
    }
  }
  return notes;
}
const HUMAN = readHumanNotes();

/** 兜底：人类在 2026-09-25 那版表里写的批注（**原话逐字**，防格式演进把它们冲掉）。 */
const HUMAN_FALLBACK = {
  c05: '前面的的确是，但换精灵还是防御建议问一下模型（4b应该就够 保证速度）',
  c06: '和上面说的一样，这不是能读取的信息，**我方确定出招前都不能知道对方动作**（这很重要！！）',
  c07: '各种模拟，可能计算量较大',
  c09: '培养是在培养页啊，这个和战斗没啥直接关系，你给的东西肯定不够啊，判断那个值得培养是要从配队、强度、属性、喜爱程度、难度、克制程度等等诸多元素交织下影响的，很复杂的好吧？？',
  c11: '同样涉及预判理论上都麻烦',
  c12: '没呢么简单好吗？',
  c14: '这你直接看能算出来？',
  c15: '没有回复药大哥',
  c16: '这还需要问啊，肯定不能啊，但你问引擎真有用？这种规则写哪里的，你查清楚',
  c19: '有的技能的确有，要判断清楚',
  c21: '这一大类规则类问题建议问模型，并预制相关规则知识库进RAG，快速查询判断',
  c22: '这很复杂的，我觉得你想简单了',
  c23: '这个我不知道，最好还是模型+RAG吧',
};
for (const [id, text] of Object.entries(HUMAN_FALLBACK)) if (!HUMAN[id]) HUMAN[id] = text;

// 人类裁决里明确给了次数的四条（原话在 chat 里给的）
const EXPLICIT = {
  c01: {model: 0, engine: 0},
  c02: {model: 1, engine: 0},
  c03: {model: 0, engine: 1},
  c04: {model: 0, engine: 1},
};

const evalJson = JSON.parse(readFileSync(EVAL, 'utf8'));
const inv = JSON.parse(readFileSync(INV, 'utf8'));
// 金标送审状态（人类口径 1）：每条金标带**内容指纹**与 `draft / approved`。
// 表里显示它，是为了让"你审的是哪一版答案"看得见 —— 改了答案 ⇒ 指纹变 ⇒ 自动退回 draft。
const REVIEW_STATE_PATH = 'data/roco/gold/review-state.json';
const REVIEW = existsSync(REVIEW_STATE_PATH)
  ? JSON.parse(readFileSync(REVIEW_STATE_PATH, 'utf8'))
  : {cases: {}, note: '（还没有 review-state：所有金标一律按未审处理）'};
/** 判据正文：**取自 `--dump-cases`**（报告里函数已被 JSON 抹成 null，只有 dump 里还是真函数）。 */
const criteriaText = (id) => {
  const c = CRITERIA.get(id);
  if (!c) return '（这条没有 answer 判据：只看 calls/tools）';
  return [c.must?.length ? `must: ${c.must.join(' ｜ ')}` : null,
    c.mustNot?.length ? `mustNot: ${c.mustNot.join(' ｜ ')}` : null,
    c.why ? `why: ${c.why}` : null].filter(Boolean).join('；') || '（空）';
};
/** 提议的"问模型几次"（来自 `--dump-cases`，**未审**）。 */
const PROPOSALS = (() => {
  try {
    const env = {...process.env};
    for (const key of ['DEEPSEEK_API_KEY', 'ROCO_EVAL_ORIGIN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    const out = execFileSync(process.execPath, ['scripts/eval-live-s04.js', '--dump-cases'],
      {cwd: '.', env, encoding: 'utf8', timeout: 120000});
    const parsed = JSON.parse(out);
    return new Map([...parsed.cases, ...parsed.wrong_pet_cases].map((row) => [row.id, row.review ?? null]));
  } catch (error) {
    return new Map([['__error__', String(error.message).slice(0, 120)]]);
  }
})();
const CRITERIA = (() => {
  try {
    const env = {...process.env};
    for (const key of ['DEEPSEEK_API_KEY', 'ROCO_EVAL_ORIGIN', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
    const out = execFileSync(process.execPath, ['scripts/eval-live-s04.js', '--dump-cases'],
      {cwd: '.', env, encoding: 'utf8', timeout: 120000});
    const parsed = JSON.parse(out);
    return new Map([...parsed.cases, ...parsed.wrong_pet_cases].map((row) => [row.id, row.criteria ?? null]));
  } catch {
    return new Map();
  }
})();
const proposalOf = (id) => {
  const row = PROPOSALS.get(id);
  if (!row) return '未提议';
  return `${JSON.stringify(row.model_calls)}（${row.basis}）[${row.status}]`;
};
const goldLabel = (id) => {
  const row = REVIEW.cases?.[id];
  return row ? `${row.revision} / **${row.status}**` : '未登记';
};
const byId = new Map((inv.cases || inv.rows || []).map((r) => [r.id, r]));
const has = (paths, kw) => paths.some((p) => String(p).includes(kw));
const facts = (paths) => [['血量', '.hp'], ['能量', 'energy'], ['双方名单/道具', 'pets'],
  ['合法行动', 'legalActions'], ['逐招伤害预览', 'damage'], ['规划回执', 'plan'],
  ['某回合原始事件', 'events'], ['训练点/培养格', 'token']]
  .map(([k, kw]) => `${k} ${has(paths, kw) ? '有' : '无'}`).join('｜');

// —— 由人类 c01–c20 批注推出的规则（v3）———————————————————————————————
// 每条都标了"它来自哪条批注"，改规则时要能追溯。
// 已查实的硬事实（2026-09-25，人类纠正后我逐处核过；写进表头，避免再猜）
const KNOWN_FACTS = [
  'v3 标准 PVP 的合法动作类 = `["skill","charge","switch","surrender","magic"]`'
    + '（`data/roco/rulesets/mobile-s4-candidate-v3.json:191` 的 `allowed_kinds`）——**没有 `item`**。',
  'UI「道具」面板只有两格：**愿力强化**（`wish_power_up`）与**首领化**（`leader_form`）'
    + '（`src/client/roco.html:503` 起，逐格 `data-b3-item-id`）⇒ **v3 PVP 里没有「回复药」这道具**。',
  '`potion 回复药 / cleanse 净化药 / ether 能量果` 三个道具属于**营地那套引擎**'
    + '（`src/game/engine.js:89` 的 `ITEMS`），不在 v3 PVP 的合法动作里。',
  '「出招前不可能知道对手动作」= **PVP 的公平与博弈本身**（人类原话：「这是洛克王国手游的规则，这是 pvp 大哥，'
    + '公平、博弈知道吗？」）。实现落点：公开面按 `allowed_kinds` 给合法动作、**不含对手待执行动作**'
    + '（`src/coach/toolbox.js` 的 `plan_actions` 契约明写「不得含真实随机种子或对手待执行动作」；'
    + '私有状态含真 seed，划在本地对局域、不许传给教练侧，见 `roco/src/roco_env/service.py`）。',
];
const RULES = [
  ['**出招前不可能知道对手要做什么**（c06 原话：「这不是能读取的信息，我方确定出招前都不能知道对方动作（这很重要！！）」）',
   '凡是"预测对手下一手"的问句：**不许把预测当事实**；要么说清"这是分支/可能性"，要么如实说不知道。涉及预判的题（c11 也说"理论上都麻烦"）先别写死标准答案。'],
  ['**不许读对手非公开数据**（c02 原话：「我方不能读取对面任何非公开数据」）',
   '对手道具/后备/手牌这类，先定"哪些属于公开面"；不在公开面的一律不读、也不猜。'],
  ['**事实题不该问模型**（c01 原话：「直接查现场数据就行，问啥模型」）',
   '纯粹"是多少/是什么/发生了什么"⇒ 问模型 0 次；系统直接给，且**数字必须能在资料/回执里找到**。'],
  ['**决策题要问模型**（c05 原话：「换精灵还是防御建议问一下模型（4b 应该就够 保证速度）」）',
   '要"比较/建议/判断"的 ⇒ 问模型 ≥1（小模型即可，注意延迟）；事实由系统喂进来。'],
  ['**模拟很贵**（c07 原话：「各种模拟，可能计算量较大」）',
   '推演类要按"贵"来设计：能少算就少算，别每轮都全量模拟。'],
  ['**机制要先确认还在不在**（c15 原话：「没有回复药大哥」；c02 同）',
   '用药/道具这类，先确认真实规则里是否还有这个机制；**旧机制不能当标准答案**。'],
  ['**跨页面的问题不是在局上下文能答的**（c09 原话：培养要在培养页看，涉及配队/强度/属性/喜爱/难度/克制"很复杂"）',
   '培养/养成类问句要么补足资料，要么明确"这需要另一套上下文"，别在对局上下文里硬答。'],
  ['**规则类问题先查清规则写在哪**（c16 原话：「你问引擎真有用？这种规则写哪里的，你查清楚」）',
   '规则类问句先定位到数据/规则文件（真源），再由引擎给结论；不允许"模型记得的规则"。'],
  ['**同一类要逐条分辨**（c19 原话：「有的技能的确有，要判断清楚」）',
   '技能/机制这类不能一刀切，要按条目核实。'],
];

const rows = [], sections = [], counts = {};
for (const r of evalJson.rows || []) {
  const paths = ((byId.get(r.id) || {}).inventory || {}).paths || [];
  const calls = Number.isFinite(r.calls) ? r.calls : (r.toolTrace || []).length;
  const want = r.expect?.calls?.[0] ?? 0;
  const traceable = r.validation?.valid === true || Number(r.evidenceCount || 0) > 0;
  const stop = String(r.agentStop || '');
  const note = HUMAN[r.id] || '';
  const judged = Boolean(note) || Boolean(EXPLICIT[r.id]);
  const flag = calls >= want ? 'OK' : stop.startsWith('policy') ? (traceable ? '旧标准可能过期' : '★真缺口') : (stop ? '模型少问' : '记账缺');
  counts[flag] = (counts[flag] || 0) + 1;

  // 按新规则给"类推建议"（只对没批注的题）
  const isPrediction = /下一手|预判|对方.*会|对手.*会|他.*会出|猜/.test(r.question);
  const isDecision = /要不要|该不该|怎么打|哪个好|干嘛|值不值|划算|该带谁|该换|推荐|判断|比较|模拟/.test(r.question);
  const isPureFact = /还剩多少|是多少|多少血|什么属性|哪个系|有哪些|发生了什么|有没有/.test(r.question) && !isDecision;
  const isTraining = /培养|训练点|培养格|加点/.test(r.question);
  const deadMech = /药|道具/.test(r.question);
  let advice;
  if (note) advice = `**人类批注（原话，逐字）**：${note}`;
  else if (isPrediction) advice = '**类推建议（待你确认）**：⚠ 触犯 c06 那条（出招前不可能知道对手动作）——**这条旧标准答案大概率要重写**：'
    + '建议改成"说明这是可能性/分支，或如实说不知道"，问引擎 0 次、问模型 1 次（在不确定性下给建议）。';
  else if (isTraining) advice = '**类推建议（待你确认）**：⚠ 按 c09 —— 养成类超出对局上下文，**先补资料或另立上下文**，别在对局上下文里硬答。';
  else if (deadMech) advice = '**类推建议（待你确认）**：⚠ **题目过时**——v3 PVP 的合法动作里没有 `item`，'
    + 'UI 也只有「愿力强化/首领化」两格 ⇒ 这条问的「药/道具」在 v3 PVP 里不存在，**标准答案要按人类口径改写或废掉**。';
  else if (isPureFact) advice = `**类推建议（待你确认）**：事实题 ⇒ 问模型 **0** 次；${has(paths, '.hp') || has(paths, 'energy') ? '资料已在手上 ⇒ 问引擎 **0** 次（数字必须有出处）' : '手上缺这点事实 ⇒ 问引擎 **1** 次'}。`;
  else if (isDecision) advice = '**类推建议（待你确认）**：决策题 ⇒ 问模型 **1** 次（小模型够，注意延迟）；'
    + `${has(paths, 'legalActions') ? '合法行动已在手上' : '合法行动**不在**手上 ⇒ 要问引擎'}；预判部分按 c06 只给可能性、不给"对手会做什么"。`;
  else advice = `**类推建议（待你确认）**：先看这点事实在不在手上（${facts(paths)}），再按上面 9 条规则定"问模型/问引擎"。`;

  rows.push(`| ${r.id} | ${note ? '人类已批注' : judged ? '人类已裁决' : '待判'} | ${note ? '见批注' : EXPLICIT[r.id] ? `${EXPLICIT[r.id].model} / ${EXPLICIT[r.id].engine}` : '? / ?'} | ${calls} | ${stop || '-'} | ${goldLabel(r.id)} |`);
  const q = String(r.question);
  const rag = /第\s*\d+\s*回合|上一回合|整局|统计|回顾/.test(q)
    ? '对局历史（`read_evidence` / `read_last_turn` / `read_match`）→ 模型解读'
    : /规则|机制|术语|定义|消耗|威力|优先级|相性|克制|属性|系别|多少级|进化/.test(q)
      ? '**规则知识库**（术语表 / 相性表 / 机制卡：`query_rules` + `search_rules`）→ 模型判断（c21 的批注：这类要预制进 RAG）'
      : /学得到|有什么技能|技能池|配招/.test(q)
        ? '图鉴 / 学习表（`query_rules{kind:learnset}`）→ 模型组织'
        : /换|阵容|比较|模拟|该不该|要不要|怎么打|哪个好/.test(q)
          ? '合法行动 + 推演（`compare_actions` / `simulate_branch`）+ 名单事实 → 模型决策（**博弈：不给对手动作**）'
          : /还剩多少|是多少|多少血|什么属性/.test(q)
            ? '不需要检索（事实已在手上）→ 模型 0 次；但数字必须有出处'
            : '待定（请人类指定检索源）';
  sections.push([
    `### ${r.id}${note ? '　—　【人类已批注】' : judged ? '　—　【人类已裁决】' : flag === 'OK' ? '' : `　—　（${flag}）`}`,
    '', `- **玩家这么问**：${r.question}`,
    `- **旧标准答案（待废）**：至少问引擎 **${want}** 次；期望工具：${(r.expect?.tools || []).join(' / ') || '（未写）'}`,
    // 2026-09-25（人类点名）：**判据正文本身**必须展示出来 —— 指纹保护的就是这部分，
    // 人类点"批准"时看不到它，等于在批准一个自己没看见的东西。这里打印**源码形态**（与指纹一致）。
    `- **判据正文（指纹保护的部分）**：${criteriaText(r.id)}`,
    `- **提议：问模型几次**：\`${proposalOf(r.id)}\`（**draft，等你审** —— 人类口径：事实题 0 次、决策题 ≥1 次）`,
    `- **金标送审（人类口径 1）**：\`${goldLabel(r.id)}\` —— 改了这条答案 ⇒ 指纹变 ⇒ **自动退回 draft**，`
      + '必须重新送审；`node scripts/roco/gold-review-state.mjs --check` 会指出哪几条漂移。',
    `- **旧注释**：${String(r.why || '（无）').slice(0, 180)}`,
    `- **小芽实际**：问引擎 ${calls} 次；停止原因 \`${stop || '（无记录）'}\`；答复里的数字${traceable ? '**都能在资料/回执里找到**' : '**找不到出处**'}`,
    `- **它当时手上有什么**：${facts(paths)}`,
    `- **RAG 视角（机器初判，待你改）**：${rag}`,
    `- ${advice}${note ? '' : ` ${HUMAN_MARK}`}`, '',
  ].join('\n'));
}

// 2026-09-25：标题里的条数不再写死 —— 人类拍板新增 g01–g05 之后，49 → 54；
// 写死的数字会让复核表与金标实际条数对不上（而这张表就是给人对着审的）。
const caseCount = (evalJson.rows ?? evalJson.cases ?? []).length;
const md = [`# ${caseCount} 例「标准答案」复核表 v3（按人类 c01–c20 批注优化）`, '',
  `> 生成：${new Date().toISOString()}｜人类批注（自动从上一版抽取，未改一字）：**${Object.keys(HUMAN).length}** 条`,
  '> 本表**不改标准答案**；标准答案由人类重做。', '',
  '## 人类的总判断（2026-09-25，原话）', '',
  '- 「**我觉得很多都需要模型+RAG呢**」——即：多数题目应当是"**先检索（RAG）再让模型判断/解释**"，而不是"直接从包里读"或"只让引擎算"。',
  '- 「这一大类规则类问题建议问模型，并**预制相关规则知识库进 RAG**，快速查询判断」（c21 批注）。',
  '- 「这很复杂的，我觉得你想简单了」（c22）／「这个我不知道，最好还是模型+RAG吧」（c23）。',
  '- 现状对照：**RAG 的"检索"这一半其实已经在**（工具就是检索：`query_rules` 查图鉴/学习表/相性/术语，`search_rules` 查规则与战术卡，`read_*` 查对局历史）；',
  '  缺的是**触发时机**（该检索的没检索）与**资料够不够**（规则知识库要不要按 c21 预制得更全）。',
  '',
  '## 已查实的硬事实（人类纠正后逐处核过）', '',
  ...KNOWN_FACTS.map((f) => `- ${f}`), '',
  '## 由你 c01–c20 的批注推出的规则（v3）', '',
  ...RULES.map(([r1, r2], i) => `${i + 1}. ${r1}\n   - 落地：${r2}`), '',
  '## 我领到的行动项（不是"改标准答案"，是我该去查/改的东西）', '',
  '- **查清"我方确定出招前不能知道对方动作"这条规则写在哪个文件里**（c16 也问了"这种规则写哪里"），并确认引擎的推演接口是不是按"分支/可能性"给的，而不是给一个"对手会做什么"的结论。',
  '- **查清"回复药/道具"这个机制现在还在不在**（c15、c02），以及对手道具属不属于公开面。',
  '- **养成/培养类问句的上下文**（c09）：要么补齐资料，要么明确它不在对局上下文里答。',
  '- 上面三条查完之前，**涉及它们的题我不动产品**。', '',
  '## 总表', '',
  '| 题号 | 状态 | 人类裁决(模型/引擎) | 实际问引擎 | 停止原因 | 金标送审(指纹/status) |', '|---|---|---|---|---|---|',
  ...rows, '', `> 分布（按旧标准）：${JSON.stringify(counts)}`,
  `> 金标送审：共 ${Object.keys(REVIEW.cases || {}).length} 条，`
    + `approved ${Object.values(REVIEW.cases || {}).filter((c) => c.status === 'approved').length} 条`
    + '（人类口径 1：**审之前不许拿去刷指标**；`--require-approved` 会让评测在未审时以退出码 3 停下）', '', '## 逐条', '', ...sections].join('\n');
mkdirSync('reports/roco/gold-review-2026-09-25', {recursive: true});
writeFileSync(OUT, md);
console.log(`写出 ${OUT}｜抽取到人类批注 ${Object.keys(HUMAN).length} 条：${Object.keys(HUMAN).join(',')}`);
