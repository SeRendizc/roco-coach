/**
 * 判据：「**A 打 B 有没有优势**」这类**两只属性之间**的问句必须查引擎，不许拿别的游戏的相性表答。
 *
 * 起因（第 37 轮 20 问实测，对着 8765 那台演示服务）：
 *   「水系打火系有优势吗？」→ `state-in-packet`（**一次引擎都不查**）⇒ 模型答
 *   「水系打火系通常有优势，这是元素相克的基础规则…」；
 *   「龙系克制哪些属性？」→ 同一个洞，模型答「龙系一般克制龙系自身，**这是宝可梦类游戏的常见规则**…
 *   本游戏的具体克制表没有出现在我拿到的证据里」。
 *   —— 相性表就在引擎里（`type_row` 的 `offense` 是逐行数出来的），却让玩家拿到别的游戏的规则。
 *
 * 顺带修掉两个真缺陷：
 *   ① 词表有「克哪些」却没有「克制哪些」；
 *   ② 我把两个分支写成 `/(...)/ || /(...)/` —— **正则对象永远为真**，`||` 只返回左边那个，
 *      第二段是死代码（「光系和暗系谁克谁？」照样匹配不上）。判据 ① 的表里两种句式都列了，
 *      就是为了让这类"看着写了两条、其实只生效一条"的错**当场红**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {policyFor, defaultArgsFor, typePairAsk, typeChartAsk, runCoach} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {configureRocoTools} from '../src/coach/toolbox.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const camp = () => ({mode: 'camp', battle: null,
 profile: {pets: [{id: 'pet_000118', name: '音速犬', types: ['火系'], stats: {spe: 120}}]}});

test('① 两种句式的相性问句都必须路由到引擎（含曾经漏掉的那几条）', () => {
 const table = [
  // 句式一：A 打/对/克 B
  ['水系打火系有优势吗？', 'type-chart-ask'],
  ['水系打火系', 'type-chart-ask'],
  ['火系克草系吗？', 'type-chart-ask'],
  // 句式二：A 和/跟/与 B 谁克谁 / 有优势
  ['光系和暗系谁克谁？', 'type-chart-ask'],
  ['光系跟暗系谁更强？', 'type-chart-ask'],
  ['水系和火系哪个有优势？', 'type-chart-ask'],
  // 旧词表里本来就能命中的（回归钉）
  ['火系克什么？', 'type-chart-ask'],
  ['龙系克制哪些属性？', 'type-chart-ask'],
  ['冰系被什么克制？', 'type-chart-ask'],
  ['龙系怕什么？', 'type-chart-ask'],
  // 反证：这些**不是**相性问句，不许被抢走
  ['有哪些龙系精灵？', 'catalog-ask'],
  ['我想练一只抗龙系的伙伴，配哪四招？', 'catalog-ask'],
  ['音速犬有哪些技能？', 'learnset-ask'],
  ['应对是什么意思？', 'term-ask'],
 ];
  // 反证：**列清单**的问法不许被当成"一对一问句"（真机实测过的胡话：
  // 「龙系克制哪些属性？」被解析成「龙系 克 制哪些属性」，输出「龙系打制哪些系：不是克制关系」）
  for (const q of ['龙系克制哪些属性？', '火系克制什么属性？', '水系克制哪几个系？', '光系克什么？']) {
   assert.equal(typePairAsk(q), null, `「${q}」是列清单，不是一对一问句`);
   assert.equal(typeChartAsk(q), true, `「${q}」仍要算相性问句（只是不给 pair）`);
  }

 for (const [message, want] of table) {
  assert.equal(policyFor(message, camp())?.reason, want, `「${message}」的路由不对`);
 }
 // 反证：纯推荐类问句**不许**被当成相性问句（否则会拿倍率去回答"该养谁"）
 assert.equal(Boolean(policyFor('音速犬这个精灵怎么样？', camp())?.need), false,
  '「怎么样」是推荐类问句，不该去查相性表');
});

test('② 一对一问句要的是**攻击方那一行**，不是整张表；其余相性问句照旧拿整张表', () => {
 assert.deepEqual(defaultArgsFor('query_rules', camp(), '水系打火系有优势吗？'), {kind: 'type_row', type: '水系'},
  '「水系打火系」要查的是**水系那一行**（攻击方在前）');
 assert.deepEqual(defaultArgsFor('query_rules', camp(), '火系克什么？'), {kind: 'type_chart'},
  '没有点名两只的问句照旧拿整张表');
 assert.deepEqual(typePairAsk('光系和暗系谁克谁？'), {attacker: '光系', defender: '暗系'});
 assert.deepEqual(typePairAsk('火属性打水属性有优势吗？'), {attacker: '火系', defender: '水系'}, '「属性」要归一成「系」');
 assert.equal(typePairAsk('音速犬有哪些技能？'), null, '不是一对一问句时必须 null（不猜）');
 assert.equal(typeChartAsk('有哪些龙系精灵？'), false, '「按属性找精灵」不是相性问句');
});

test('③ 答案逐字来自引擎相性表：是克制就说倍率，不是克制就直说不是', async () => {
 // 用**注入的假引擎**（与 `tests/roco-ask-coverage.test.js` 同一手法）：不起 Python、跑得快，
 // 而且能直接断言"发给引擎的参数对不对"——这一族最容易错的就是把方向搞反。
 const asked = [];
 const rows = {
  水系: {record: 'type_row', key: '水系', offense: [{type: '火系', multiplier: 2}], weak: [{type: '草系', multiplier: 2}], resist: [], neutral_default: 1},
  火系: {record: 'type_row', key: '火系', offense: [{type: '草系', multiplier: 2}], weak: [{type: '水系', multiplier: 2}], resist: [], neutral_default: 1},
  光系: {record: 'type_row', key: '光系', offense: [{type: '暗系', multiplier: 2}], weak: [], resist: [], neutral_default: 1},
  暗系: {record: 'type_row', key: '暗系', offense: [], weak: [{type: '光系', multiplier: 2}], resist: [], neutral_default: 1},
 };
 const bridge = {
  baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
  async query(fact) {
   asked.push(fact);
   const row = rows[fact.type];
   if (!row) return {ok: false, ruleset_id: 'x', state_version: 0, error_type: 'not_found', error: `未知属性：${fact.type}`};
   return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
    evidence_ids: [`ev:types.json#${fact.type}`], error_type: null, failure_class: null, result: row};
  },
 };
 configureRocoTools({client: bridge, stateVersion: 0});
 const calls = {plan: 0, generate: 0};
 const provider = {name: 'stub-model', async plan() { calls.plan += 1; return {stop: true}; },
  async generate(packet) { calls.generate += 1; return String(packet?.text ?? ''); }};

 const answer = await runCoach({message: '水系打火系有优势吗？', role: 'auto', context: camp(),
  memory: freshMemory(), provider});
 assert.equal(answer.agentStop, 'policy-fact-local', `这一族要本地作答（0 次模型）：${answer.agentStop}`);
 assert.equal(calls.plan + calls.generate, 0, '纯事实问句不许问模型');
 assert.deepEqual(asked.map((f) => [f.kind, f.type]), [['type_row', '水系'], ['type_row', '火系']],
  '要查**攻击方那一行**（水系在前），反方向那格也要读回来');
 const text = String(answer.text);
 assert.match(text, /水系打火系：\*\*克制\*\*（×2）/, `要给出引擎的倍率：${text}`);
 assert.match(text, /火系打水系：不是克制关系/, '反方向要照实说（火系那一行里没有水系）');
 // 2026-09-27（审计 ②，**改钉不删**）：原来要求正文里出现 `type_row` 或 `types.json`
 //（引擎字段名/数据文件名）。判据的意思没变 —— **必须写出依据来自相性表**；现在查那句人话，
 // 并加一条反向：正文里**不许**出现字段名或文件名（出处留在 evidence 里）。
 assert.match(text, /依据：游戏图鉴的相性表/, '要写出依据来自相性表');
 assert.doesNotMatch(text, /type_row|types\.json/, `正文里不许出现字段名/文件名：${text}`);

 // 反向问句：结论必须跟着方向翻过来（火系打水系不是克制）
 asked.length = 0;
 const reverse = await runCoach({message: '火系打水系有优势吗？', role: 'auto', context: camp(),
  memory: freshMemory(), provider});
 assert.deepEqual(asked.map((f) => f.type), ['火系', '水系'], '反向问句要查火系那一行');
 assert.match(String(reverse.text), /火系打水系：\*\*不是克制关系\*\*/, `方向不许反：${reverse.text}`);

 // 「A 和 B 谁克谁」：两个方向都要摆出来（同一个回执里读得到）
 asked.length = 0;
 const both = await runCoach({message: '光系和暗系谁克谁？', role: 'auto', context: camp(),
  memory: freshMemory(), provider});
 const bothText = String(both.text);
 assert.match(bothText, /光系打暗系：\*\*克制\*\*（×2）/, bothText);
 assert.match(bothText, /暗系打光系：不是克制关系/, bothText);

 // 反证：引擎说"没有这一格"时不许编（把行删掉，必须走回退而不是拿常识答）
 delete rows['水系'];
 const missing = await runCoach({message: '水系打火系有优势吗？', role: 'auto', context: camp(),
  memory: freshMemory(), provider});
 assert.doesNotMatch(String(missing.text), /×2/, `引擎查不到时不许报倍率：${missing.text}`);
});

test('④ 查学习表必须走精简投影（否则第一枪回执就超 10000 字符预算，整族答不出来）', async () => {
 // 实测：`{kind:'learnset',name:'音速犬'}` 整包 23798 字节，超过运行时对**第一枪回执**的
 // 10000 字符预算（`runtime.js:2820`）⇒ 直接 `stopped:'receipt-budget'`，模型什么都看不到。
 // 精简投影同一份数据 7166 字节（雪影娃娃 8028）⇒ 进得去。
 const bridge = {
  baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
  async query(fact) {
   assert.equal(fact.kind, 'learnset');
   assert.equal(fact.compact, true, '学习表必须带 compact:true');
   return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
    evidence_ids: ['ev:learnsets.json#pet_000118'], error_type: null, failure_class: null,
    result: {record: 'learnset', pet_id: 'pet_000118', native: [{skill_id: 'skill_000001', name: '火花', element: '火系', power: 40}],
     blood: [], stones: [], total: 1, compact: true}};
  },
 };
 configureRocoTools({client: bridge, stateVersion: 0});
 const args = defaultArgsFor('query_rules', camp(), '音速犬有哪些技能？');
 assert.equal(args.compact, true, `查学习表要带精简投影：${JSON.stringify(args)}`);
 assert.equal(args.kind, 'learnset');
 // 反证：别的查询不许乱带 compact（它是 learnset 专用开关）
 assert.equal(defaultArgsFor('query_rules', camp(), '音速犬的速度是多少？').compact, undefined,
  '精灵/技能查询不许带 compact');
});

test('⑤ 手游侧页面**不许**出现练习引擎的宠物名（注释里说明边界可以，玩家看得见的地方不行）', async () => {
 // 那条边界本身要在注释里讲清楚（`xiaoya.js` 就写着"为什么不用本仓 MVP 存档"），
 // 所以判据只查**去掉注释之后**剩下的文本 —— 也就是玩家真能读到的部分。
 const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')      // /* 块注释 */
  .replace(/<!--[\s\S]*?-->/g, '')          // HTML 注释
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');  // 整行 // 注释
 const names = ['烬尾狐', '潮甲龟', '林鹿'];
 // 2026-09-27：`nurture.html` 已退役删除 ⇒ 从清单里去掉。
 const files = ['src/client/roco.html', 'src/client/xiaoya.js', 'src/client/box.html',
  'src/client/roco.js', 'src/client/index.html'];
 for (const file of files) {
  const text = strip(readFileSync(join(ROOT, file), 'utf8'));
  for (const name of names) {
   assert.ok(!text.includes(name), `${file} 的玩家可见文案里出现了练习引擎的宠物名「${name}」`);
  }
 }
 // 反证：判据本身要真的能抓到 —— 拿一条合成文案试一次（不然它可能只是"什么都没查"）
 assert.ok(strip('<p>本命是潮甲龟</p>').includes('潮甲龟'), '合成样本必须被抓到');
 assert.ok(!strip('// 说明：潮甲龟是练习引擎的\n<p>正文</p>').includes('潮甲龟'), '注释里的说明不算泄漏');
});
