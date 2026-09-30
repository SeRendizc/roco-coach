/**
 * 判据：养成存档的**两种形状**与「拿不到存档」那句话的**唯一一份**（2026-09-25 的 500）。
 *
 * 缺陷现场（真机，对着 8765 那台演示服务，`src/client/roco.js` 的 `coachCampContext()` 送的真形状）：
 *   「培养点该往哪加？」⇒ **HTTP 500「本地服务无法完成请求」**
 *   栈：`teacher (src/coach/teacher.js:6)` ← `runCoach (src/coach/runtime.js:1146)`
 *   同一族另一种措辞「怎么培养」⇒ 200（先命中 `training-ask-elsewhere`）。
 *   ⇒ 措辞一变服务就崩，而 500 比"不知道"糟得多。
 *
 * 根因是**形状假设**：`profile.pets` 现在是候选池那一页的**公开行数组**（没有 level/points），
 * 而 `teacher()` 与训练点那一族只认**养成存档对象**。修法是"两条路归一"：
 *   ① 存档来源只在 `profile-shape.js` 里判定（`profile.growth` 新来路 / `profile.pets` 是对象的老路）；
 *   ② 拿不到存档时 `teacher()` 与 `training-ask-elsewhere` 返回**同一份**诚实回复；
 *   ③ 边界（`validateChat`）把畸形形状 400 掉，不让下一个 5xx 冒充"服务不可用"。
 *
 * 判据全部钉在**行为**上，另加两条**结构性**（同源/单源）与**反证**（数组不算存档、畸形必须 400）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCoach} from '../src/coach/runtime.js';
import {teacher, makeQuiz} from '../src/coach/teacher.js';
import {trainingSaveOf, trainingSaveMissing} from '../src/coach/profile-shape.js';
import {freshMemory} from '../src/coach/memory.js';
import {newProfile, PROFILE_STORAGE_KEY} from '../src/game/progression.js';
import {validateChat} from '../src/server/index.js';
import {configureRocoTools} from '../src/coach/toolbox.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 客户端**真的**发出来的名单行（`coachCampContext()` 逐字段同形：数组、没有 points、没有 tokens）。
const ROSTER = [
 {id: 'fox', name: '烬尾狐', types: ['火系'], role: '速攻', stats: {hp: 120, atk: 60, def: 50, spa: 40, spd: 45, spe: 70}, mechanism: null},
 {id: 'turtle', name: '潮甲龟', types: ['水系'], role: '坦克', stats: {hp: 160, atk: 45, def: 70, spa: 40, spd: 50, spe: 30}, mechanism: null},
];
const campContext = () => ({mode: 'camp', battle: null, profile: {pets: ROSTER}});
/** 加性新来路：`profile.growth`（客户端从本机存档带上来）。 */
const growthContext = ({tokens = 3, pets = {}} = {}) => ({
 mode: 'camp', battle: null,
 profile: {pets: ROSTER, growth: {tokens, pets: {...newProfile().pets, ...pets}}},
});
const countingProvider = () => {
 const seen = {plan: 0, generate: 0};
 return {seen, provider: {
  name: 'fake-cloud',
  async plan() { seen.plan += 1; return {stop: true}; },
  async generate(packet) { seen.generate += 1; return String(packet?.text ?? ''); },
 }};
};

test('① 存档来源只在 profile-shape.js 判定：两条来路都认，数组不算存档（反证）', () => {
 const array = trainingSaveOf(campContext());
 assert.equal(array, null, '名单数组**不是**存档（这是 500 的根源，不许再被当成存档）');
 const legacy = trainingSaveOf({profile: {pets: newProfile().pets, tokens: 4}});
 assert.equal(legacy?.source, 'profile', '老来路（profile.pets 是对象）必须照旧认');
 assert.equal(legacy?.tokens, 4);
 const growth = trainingSaveOf(growthContext({tokens: 7}));
 assert.equal(growth?.source, 'growth', '新来路（profile.growth）必须认');
 assert.equal(growth?.tokens, 7);
 // 反证：把 growth.pets 换成数组 ⇒ 必须回到 null（否则"名单"会被当成存档去算级别）
 assert.equal(trainingSaveOf({profile: {pets: ROSTER, growth: {tokens: 3, pets: ROSTER}}}), null,
  'growth.pets 是数组时必须当成"没有存档"，不许拿它当存档算');
 // 点数没给 ≠ 点数是 0：只报"未提供"，不拿 0 顶替
 assert.equal(trainingSaveOf({profile: {pets: newProfile().pets}}).tokens, null, '没给 tokens 就是 null，不是 0');
});

test('② 客户端真形状下 teacher() 不许抛：返回与「拿不到存档」那份**逐字相同**的话', () => {
 const context = campContext();
 let packet = null;
 assert.doesNotThrow(() => { packet = teacher(context); }, 'teacher() 拿到名单数组不许抛（500 就是这里抛的）');
 assert.deepEqual(packet, trainingSaveMissing(context), '两条路必须是同一份（同源），不许各写一套');
 assert.match(packet.text, /营地/, '要说清这份存档在哪一页');
 assert.match(packet.text, /直接说/, '要给"直接说数"这条立刻能走的路');
 assert.doesNotMatch(packet.text, /\d+\s*个训练点/, '一个点数都不许编');
});

test('③ 端到端：客户端真形状下问「培养点该往哪加？」不再 500，且本地作答、0 次模型调用', async () => {
 const {seen, provider} = countingProvider();
 const answer = await runCoach({message: '培养点该往哪加？', role: 'auto', context: campContext(),
  memory: freshMemory(), provider});
 assert.equal(answer.agentStop, 'policy-fact-local', `要走本地事实：${answer.agentStop}`);
 assert.equal(seen.plan + seen.generate, 0, '这一族不许问模型');
 // 2026-09-27 改钉（加点退役）：这一族现在答的是**否定句 + 指路**，不再是"存档在哪一页"。
 assert.match(String(answer.text), /没有加点/, '要直说这一版没有加点');
 assert.match(String(answer.text), /我的盒子/, '要说清培养在哪做');
 assert.doesNotMatch(String(answer.text), /训练点 ?\d|培养格|还差\s*\d+\s*点/, '一个旧口径的数都不许报');
});

test('④ 加了 profile.growth ⇒ 本地答出**等级/经验**，并说清没有加点（原版有的照旧给）', async () => {
 const fox = {level: 2, xp: 10};
 // 2026-09-27：加点退役 ⇒ 夹具不再需要 `points`；`focus` 要在（等级是"这一只"的）。
 const context = {...growthContext({tokens: 3, pets: {fox}}), focus: 'fox'};
 const {seen, provider} = countingProvider();
 const answer = await runCoach({message: '培养点该往哪加？', role: 'auto', context,
  memory: freshMemory(), provider});
 assert.equal(answer.agentStop, 'policy-fact-local', `存档在 ⇒ 本地答：${answer.agentStop}`);
 assert.equal(seen.plan + seen.generate, 0, '全在手里，不必问模型');
 // 2026-09-27 改钉（加点退役）：有存档时也**不再算加点账**；但**等级/经验照旧报**（原版有的）。
 assert.match(String(answer.text), /Lv\.2/, `等级来自存档，照实说：${answer.text}`);
 assert.match(String(answer.text), /没有加点/, '并说清这一版没有加点');
 assert.doesNotMatch(String(answer.text), /培养格|训练点 ?\d/, '不许报旧口径的数');
 // teacher() 这一档也一样：有存档 ⇒ 说清"培养＝改性格/改天分" + 等级，而不是加点建议
 const advice = teacher(context);
 assert.ok(advice?.headline && /培养/.test(advice.headline), `有存档就该给得出这一档的话：${JSON.stringify(advice?.headline)}`);
 assert.match(advice.text, /没有加点/, '老师那一档也说同一件事');
 assert.doesNotMatch(advice.text, /培养格|训练点 ?\d|\+12 生命/, '老师那一档不再给加点数值');
});

test('⑤ 存档在、但这只不在里面 ⇒ 走"not-in-save"那份，且不许报别只的等级', () => {
 const context = {mode: 'camp', battle: null,
  profile: {pets: ROSTER, growth: {tokens: 3, pets: {turtle: {level: 3, xp: 0, points: {hp: 0, atk: 0, speed: 0}}}}}};
 const packet = teacher({...context, focus: 'fox'});
 assert.match(packet.text, /没有「烬尾狐」/, `要点名这一只不在存档里：${packet.text}`);
 assert.doesNotMatch(packet.text, /\d+\s*个训练点/, '这一只算不了就不报数');
 assert.match(packet.text, /直接说/, '照旧给"直接说数"这条路');
});

test('⑥ 结构性：那句话只有一份（runtime.js 不许再抄一遍），键也只有一份', () => {
 const runtime = readFileSync(join(ROOT, 'src/coach/runtime.js'), 'utf8');
 assert.doesNotMatch(runtime, /营地页问我/, '这句话只许住在 profile-shape.js（抄第二份必然漂，判据 ② 会当场红）');
 assert.match(runtime, /trainingSaveMissing/, 'runtime.js 必须**引用**那一份');
 const shape = readFileSync(join(ROOT, 'src/coach/profile-shape.js'), 'utf8');
 assert.match(shape, /export function trainingSaveMissing/, '那一份的本体在这里');

 // `pet-coach-growth-v1` 这个键：带引号的字面量只许出现在引擎那一处
 const holders = [];
 for (const file of walk(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  // 2026-10-01（task-37，**只修比较口径、期望值一字不改**）：`walk()` 用 `join()` 拼的是**平台原生**路径，
  // Windows 上 `file.slice(ROOT.length)` 得到 `src\game\progression.js`，而期望值是 `/` 写法 ⇒ 必红。
  // 这里归一化的是**比较用的**分隔符（不是改产品、也不是改期望值）。
  // 旧写法留档（改钉不删）：holders.push(file.slice(ROOT.length));
  if (/['"]pet-coach-growth-v1['"]/.test(text)) holders.push(file.slice(ROOT.length).replace(/\\/g, '/'));
 }
 assert.deepEqual(holders, ['src/game/progression.js'],
  `localStorage 键只许有一处字面量（现在：${holders.join('、')}）`);
 assert.equal(PROFILE_STORAGE_KEY, 'pet-coach-growth-v1', '键值本身钉住，改它等于让所有老存档读不到');
 // 2026-09-27：`nurture.js` 已随培养页退役删除，清单里去掉它。
 for (const client of ['app.js', 'xiaoya.js']) {
  const text = readFileSync(join(ROOT, 'src/client', client), 'utf8');
  assert.match(text, /PROFILE_STORAGE_KEY/, `${client} 必须从引擎取那个键，不许自己写`);
 }
});

test('⑥b 手游侧页面**故意不送**养成存档（把别份存档当玩家进度 = 编事实）', () => {
 // 这是一条**有意为之地钉住**的判据（不是"暂时没做"）：本机那份存档是练习局夹具
 // （烬尾狐/潮甲龟/林鹿三只自研宠 + 练习用训练点），与 622 图鉴不是一套数据。
 // 把它当 `profile.growth` 送上去，小芽就会对着一只手游宠说"烬尾狐 Lv.3 还差 5 格" ——
 // 人类已经因为同一件事点名过「还有老版的宠物名字」（见 src/client/xiaoya.js 的 loadMobileProfile）。
 // 将来真有**拥有这份存档**的页面要接，改这条判据（连同它的名字）是一次显式决定。
 const mobile = readFileSync(join(ROOT, 'src/client/roco.js'), 'utf8');
 assert.doesNotMatch(mobile, /growth\s*:/, 'roco.js（手游训练场页）不许把练习局存档当 growth 送上去');
 assert.doesNotMatch(mobile, /coachGrowth/, 'coachGrowth() 这条接线已被撤掉，不许悄悄回来');
 assert.match(mobile, /故意不送/, '理由要留在源码里（下一个人得知道这不是忘了）');
});

test('⑦ 边界：畸形形状 400（不是 500），三种合法形状放行', () => {
 const body = (profile) => ({message: '培养点该往哪加？', role: 'auto',
  context: {mode: 'camp', battle: null, profile}, memory: {version: 1}});
 assert.doesNotThrow(() => validateChat(body({pets: ROSTER})), '公开层名单数组必须放行');
 assert.doesNotThrow(() => validateChat(body({pets: newProfile().pets, tokens: 3})), '养成存档对象必须放行');
 assert.doesNotThrow(() => validateChat(body({pets: ROSTER, growth: {tokens: 3, pets: newProfile().pets}})),
  '加性 growth 必须放行');
 for (const [what, profile, why] of [
  ['pets 是数字', {pets: 42}, /名单无效|存档无效/],
  ['pets 是空串', {pets: ''}, /名单无效|存档无效|教练上下文无效/],
  ['tokens 是字符串', {pets: newProfile().pets, tokens: '3'}, /训练点无效/],
  ['growth 是数组', {pets: ROSTER, growth: []}, /养成存档无效/],
  ['growth.tokens 是字符串', {pets: ROSTER, growth: {tokens: '3', pets: {}}}, /养成存档无效：tokens/],
  ['growth.pets 是数组', {pets: ROSTER, growth: {tokens: 3, pets: []}}, /养成存档无效：pets/],
  ['growth 里某只不是对象', {pets: ROSTER, growth: {tokens: 3, pets: {fox: 3}}}, /养成存档无效：fox/],
  ['points 出现负数', {pets: ROSTER, growth: {tokens: 3, pets: {fox: {level: 2, xp: 0, points: {hp: -1}}}}}, /养成存档无效：fox\.points\.hp/],
  ['level 越界', {pets: ROSTER, growth: {tokens: 3, pets: {fox: {level: 999, xp: 0}}}}, /养成存档无效：fox\.level/],
 ]) assert.throws(() => validateChat(body(profile)), why, `${what} 必须在边界被 400 掉`);
});

/** 递归列出某个目录下的 .js 文件（判据要用它做"只许有一处"的结构断言）。 */
function walk(dir) {
 const out = [];
 for (const name of readdirSync(dir)) {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) out.push(...walk(path));
  else if (name.endsWith('.js')) out.push(path);
 }
 return out;
}

test('⑧ 手游精灵编号当 focus：不许崩（小芽页真形状），且合法编号仍照旧生效（反证）', async () => {
 // 2026-09-25 真机复现：小芽页送 focus=`own-XXXX`（手游盒子个体编号，见 src/client/xiaoya.js:222），
 // 出题代码把它当本仓练习引擎的物种编号交给 createGame() ⇒ 「请选择三只不同的宠物」⇒ HTTP 500。
 // 实测触发面：小芽页那种 payload 17/38 条 500；不带 focus 就是 200。
 const base = {profile: {pets: newProfile().pets}};
 for (const focus of ['own-0001', 'pet_000118', 'pet_999999', '', null, undefined]) {
  assert.doesNotThrow(() => makeQuiz({...base, focus}),
   `focus=${JSON.stringify(focus)} 不是本仓物种编号时必须回落到默认那只，而不是崩`);
 }
 // 反证：合法的本仓编号（turtle=潮甲龟）出的题**必须还是那一只** —— 不许图省事一律用默认
 const turtle = makeQuiz({...base, focus: 'turtle'});
 assert.match(turtle.question, /潮甲龟/, `合法 focus 必须照旧生效：${turtle.question.slice(0, 60)}`);
 const fallback = makeQuiz({...base, focus: 'own-0001'});
 assert.doesNotMatch(fallback.question, /潮甲龟/, '认不出的编号不许瞎认成某一只');
 // 第二条同根路径：存档在 + 手游编号（teacher 也会先调 pet()）
 assert.doesNotThrow(() => teacher({profile: {pets: ROSTER, growth: {tokens: 3, pets: newProfile().pets}}, focus: 'own-0001'}),
  '存档在时 teacher() 也不能因为 focus 认不出而崩');
 // 端到端：小芽页真形状 + 出题 ⇒ 不许 500，正文是那道题
 const {provider} = countingProvider();
 const answer = await runCoach({message: '出个小测验', role: 'auto',
  context: {mode: 'camp', battle: null, profile: {pets: ROSTER}, focus: 'own-0001'},
  memory: freshMemory(), provider});
 assert.match(String(answer.text), /假设练习/, `要正常出题：${String(answer.text).slice(0, 60)}`);
});

test('⑨ 存档里有这一只、只是没带等级 ⇒ 说「缺的是等级」，不许说「没有这只」', () => {
 // 2026-09-27 改钉（加点退役）：这一档原来判的是"没带 `points`（点数与已用培养格）"。
 // 加点退役之后那一族只剩**等级与经验**，所以"缺明细"的形状换成"没有可用的等级字段"。
 const grow = (pets) => ({mode: 'camp', battle: null, profile: {pets: ROSTER, growth: {tokens: 3, pets}}});
 const packet = teacher({...grow({fox: {xp: 0}}), focus: 'fox'});        // 在存档里，但没有 level
 assert.match(packet.text, /没带上它的\*\*等级与经验\*\*|缺/, `要说清缺的是哪一部分：${packet.text}`);
 assert.doesNotMatch(packet.text, /没有「烬尾狐」/, '这只明明在存档里，不许说成"没有这只"');
 // 对照一：这只真的不在存档里 ⇒ 才说"没有这一只"
 const missing = teacher({...grow({turtle: {level: 1, xp: 0}}), focus: 'fox'});
 assert.match(missing.text, /没有「烬尾狐」/, '真不在存档里时才点名说没有');
 // 对照二：有等级就正常答（等级/经验照旧是原版有的东西），并说清没有加点
 const ok = teacher({...grow({fox: {level: 2, xp: 10}}), focus: 'fox'});
 assert.match(ok.text, /Lv\.2/, `有等级就报等级：${ok.text}`);
 assert.match(ok.text, /没有加点/, '并说清这一版没有加点');
 assert.doesNotMatch(ok.text, /培养格|训练点/, '不许再提那一套');
});

test('⑩ 出题用**玩家自己那只**（目标 ③）：能拿到面板就用它，拿不到就不出题（不许拿练习引擎那只冒充）', async () => {
 // 手游两页送的形状不同：营地页的候选池行**自带六维**；小芽页只有个体 id + 物种 id ⇒ 查一次图鉴。
 const asked = [];
 configureRocoTools({stateVersion: 0, client: {
  baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
  async query(fact) {
   asked.push(fact);
   return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
    evidence_ids: ['ev:pets.json#pet_000118'], error_type: null, failure_class: null,
    result: {record: 'pet', pet_id: 'pet_000118', name: '皇家狮鹫', types: ['风系'],
     stats: {hp: 107, atk: 116, def: 127, spa: 69, spd: 65, spe: 120}}};
  },
 }});
 const {provider} = countingProvider();
 const quiz = async (context) => runCoach({message: '出一道练习题', role: 'auto', context,
  memory: freshMemory(), provider});

 // ① 小芽页形状：没有六维 ⇒ 必须查一次图鉴，题干用的是**图鉴那只**
 asked.length = 0;
 const mobile = await quiz({mode: 'camp', battle: null, focus: 'own-0001',
  profile: {pets: [{id: 'own-0001', species_id: 'pet_000118', name: '皇家狮鹫', types: ['风系'], level: 12}]}});
 assert.deepEqual(asked.map((f) => [f.kind, f.pet_id]), [['pet', 'pet_000118']],
  '小芽页没有六维 ⇒ 要按物种 id 查一次图鉴');
 assert.match(String(mobile.text), /皇家狮鹫速度 120/, `题干要用玩家自己那只的面板：${mobile.text}`);

 // ② 营地页形状：候选池行自带六维 ⇒ 直接用，不必查引擎
 asked.length = 0;
 const camp = await quiz({mode: 'camp', battle: null, profile: {pets: [
  {id: 'pet_000137', name: '仪式巨像', types: ['地系'], stats: {hp: 401, atk: 120, def: 150, spa: 110, spd: 105, spe: 60}}]}});
 assert.equal(asked.length, 0, '名单行自带六维时不该再查一次图鉴');
 assert.match(String(camp.text), /仪式巨像速度 60/, `题干要用名单里那只：${camp.text}`);

 // ③ 反证：面板拿不到 ⇒ **不出题**（题干里不许出现任何"速度 N"，更不许换成练习引擎那只）
 asked.length = 0;
 const none = await quiz({mode: 'camp', battle: null, profile: {pets: [{id: 'own-9', name: '神秘精灵'}]}});
 assert.match(String(none.text), /没有能出题的面板|出不了/, `要如实说清为什么不出题：${none.text}`);
 assert.doesNotMatch(String(none.text), /速度 \d+，对手速度/, '拿不到面板就不许编一道题');
 assert.doesNotMatch(String(none.text), /烬尾狐|潮甲龟|林鹿/, '更不许拿练习引擎那只冒充玩家的精灵');
});

test('⑪ 老路不变：没有名单数组（营地 MVP 页）时仍用练习引擎那只出题', async () => {
 const {provider} = countingProvider();
 const answer = await runCoach({message: '出一道练习题', role: 'auto',
  context: {mode: 'camp', battle: null, profile: {pets: newProfile().pets, tokens: 3}},
  memory: freshMemory(), provider});
 assert.match(String(answer.text), /速度 \d+，对手速度 \d+/, `老路照旧出题：${answer.text}`);
 assert.match(String(answer.text), /假设练习/, '题干口径不变');
});
