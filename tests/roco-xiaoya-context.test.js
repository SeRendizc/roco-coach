// P0-05「小芽当前对象 / 资料通路」的判据（2026-09-28，task-03）。
//
// 这一份量的**不是**"函数存在"，而是四件能在真机上被玩家看到的事：
//   ① **知道我在看谁**：盒子详情页（`?pet=` / `body[data-box-pet]`）那一只 = 小芽嘴里的那一只；
//   ② **同一份配置**：性格 / 资质 / 天分档位 / 四个技能 **逐字**来自页面看的那条
//      `/api/roco/box?detail=` 回执，不是另拉一份 48 只的名单；
//   ③ **换一只跟着变**：焦点变了，下一问的答案跟着变（同一段会话里连问两只）；
//   ④ **历史可见**：重载后能看到这一段会话已经聊过的轮次；「新对话」「清空本次对话」
//      两个动作语义各自钉住（尤其：连点「新对话」不许把旧会话挤掉）。
//
// 反证（这一份必须能红）：把 `xiaoya.js` 的 `:237` 改回 `pets[0]`、或把
// `focusSnapshotFrom` 的取值改成"重新拉一份名单"，第 ②③ 组立刻红。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  focusFromUrl, focusSnapshotFrom, mergeFocusIntoProfile, detectFocus, createFocusProvider,
  focusFromClick, hostContextOf, FOCUS_KEY, FOCUS_EVENT,
} from '../src/client/xiaoya.js';
import {focusAsk, focusFactAnswer, focusAdviceAnswer, focusIntent, focusDetailOf,
  localFactAsk, runCoach, buildContext} from '../src/coach/runtime.js';
import {
  emptyChatStore, appendChatTurn, readChatStore, serializeChatStore, activeChatSession,
  beginNewChatSession, clearActiveChatSession, CHAT_LIMITS,
} from '../src/coach/client.js';
import {cultivationOf} from '../src/coach/individuals.js';
import {readMemory} from '../src/coach/memory.js';

const ROOT = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

// ── 夹具：与 `GET /api/roco/box?detail=own-0004` 的**真实回执**同形状 ──────────
// （逐字抄自演示服务 `http://127.0.0.1:8765/api/roco/box?detail=own-0004`，2026-09-28。）
const PAGE_DETAIL = {
  kind: 'detail', entity: 'instance', name: '迪莫', group: 'pet_000004', art: true, level: 60, badges: [],
  traits: [
    {label: '性格', value: '专注', status: 'known', reason: null},
    {label: '资质', value: {atk: 7, spd: 7, def: 10, spa: 0, hp: 0, spe: 0}, status: 'known', reason: null},
    {label: '特长', value: null, status: 'unknown', reason: '游戏数据里没有登记这一项，所以这一栏标「未知」，不猜。'},
    {label: '血脉', value: null, status: 'unknown', reason: '游戏数据里没有登记这一项，所以这一栏标「未知」，不猜。'},
    {label: '天分档位', value: '相当好的天分', status: 'known', reason: null},
  ],
  skills: [
    {order: 1, name: '光刃', element: '光系', category: '攻击', energy: 4, power_label: '120', desc: '对敌方精灵造成物理伤害。'},
    {order: 2, name: '防御', element: '普通系', category: '防御', energy: 1, power_label: '游戏数据里没有这一项', desc: '减伤70%，应对攻击。'},
    {order: 3, name: '棘突', element: '草系', category: '攻击', energy: 3, power_label: '100', desc: '对敌方精灵造成魔法伤害。'},
    {order: 4, name: '抽枝', element: '草系', category: '攻击', energy: 4, power_label: '90', desc: '造成物伤，应对状态：自己回复50%生命和5能量。'},
  ],
};
// 名单行里的 `id` 就是卡片上的 `select`（`xiaoya.js` 的 `loadMobileProfile` 取的两个键）。
const PAGE_ROW = {id: 'own-0004', select: 'own-0004', group: 'pet_000004', name: '迪莫', types: ['光'], level: 60};

/** 与 `xiaoya.js` 里现在那条 `?detail=` 用法同一条：页面取到什么，这里就取到什么。 */
const SNAPSHOT = focusSnapshotFrom(PAGE_DETAIL, {instanceId: 'own-0004', source: '/api/roco/box?detail=own-0004'});

/** 一份最小的上下文（小芽页面拼法与 `buildContext` 同源，只补判据要用的键）。 */
function contextWithFocus(detail = SNAPSHOT, extra = {}) {
  const profile = {pets: [PAGE_ROW, {id: 'own-0001', name: '喵喵', species_id: 'pet_000001'}],
    pool_summary: {total: 542, source: 'owned'}};
  const context = {...buildContext(null, profile, detail?.instance_id ?? null, null, 'meadow', ''),
    coachAllowed: true, ...extra};
  if (detail) context.focusDetail = detail;
  return context;
}

test('① 地址上这一只：只认 box.js 那一个参数名（`?pet=`），形状不对就 null', () => {
  assert.equal(focusFromUrl('?pet=own-0004'), 'own-0004');
  assert.equal(focusFromUrl('?pet=own-0004&x=1'), 'own-0004');
  assert.equal(focusFromUrl('?a=1&b=2'), null);
  assert.equal(focusFromUrl('?pet='), null);
  assert.equal(focusFromUrl('?pet=%20'), null);
  assert.equal(focusFromUrl('?pet=own-0004%20x'), null, '带空格的东西不许当个体 id 去查');
  assert.equal(focusFromUrl('?pet=' + 'x'.repeat(80)), null, '超长的不查');
  // 与 box.js 的 `petParams()` 同一个参数名（改一边必须改另一边）。
  assert.match(read('src/client/box.js'), /query\.get\('pet'\)/, 'box.js 的 ?pet= 读法变了');
});

test('② 同一份配置：快照逐字来自页面那条 ?detail= 回执，缺的不猜', () => {
  assert.equal(SNAPSHOT.name, '迪莫');
  assert.equal(SNAPSHOT.nature, '专注');
  assert.deepEqual(SNAPSHOT.talent, {atk: 7, spd: 7, def: 10, spa: 0, hp: 0, spe: 0});
  assert.equal(SNAPSHOT.talent_tier, '相当好的天分');
  assert.deepEqual(SNAPSHOT.skills.map((s) => s.name), ['光刃', '防御', '棘突', '抽枝']);
  assert.deepEqual(SNAPSHOT.skills.map((s) => s.order), [1, 2, 3, 4]);
  // 页面标「未知」的那两栏：值必须是 null，**不许**补 0/空串/"无"。
  assert.equal(SNAPSHOT.traits.find((t) => t.label === '特长').value, null);
  assert.equal(SNAPSHOT.traits.find((t) => t.label === '血脉').value, null);
  // 页面那一栏的原话也带着（读不出来时小芽照它说，不许自己编一句）。
  assert.match(SNAPSHOT.traits.find((t) => t.label === '特长').reason, /没有登记/);
  // 形状不对就 null（不炸、也不假装有一份）。
  assert.equal(focusSnapshotFrom(null), null);
  assert.equal(focusSnapshotFrom('x'), null);
});

test('②b 并入名单是**就地**的：条数一个都不变（计数类回答不许被焦点带偏）', () => {
  const profile = {pets: [{...PAGE_ROW}, {id: 'own-0001', name: '喵喵'}], pool_summary: {total: 542}};
  const merged = mergeFocusIntoProfile(profile, SNAPSHOT);
  assert.equal(merged.pets.length, profile.pets.length, '不许新增一行');
  assert.equal(merged.focus_patched, 1);
  assert.equal(merged.pets[0].nature, '专注');
  assert.deepEqual(merged.pets[0].talent, SNAPSHOT.talent);
  // 名单自带的值更接近真值 ⇒ 不许被覆盖。
  const own = {pets: [{...PAGE_ROW, nature: '勇敢'}], pool_summary: {}};
  assert.equal(mergeFocusIntoProfile(own, SNAPSHOT).pets[0].nature, '勇敢');
  // 这一只不在名单里 ⇒ 原样返回（只靠 focusDetail 带详情，不塞行）。
  const other = {pets: [{id: 'own-0001', name: '喵喵'}], pool_summary: {}};
  assert.equal(mergeFocusIntoProfile(other, SNAPSHOT), other);
});

test('③ 换一只跟着变：焦点变了，同一段会话里下一问的答案跟着变', async () => {
  const first = await runCoach({message: '这只是什么性格/带哪四个技能？', role: 'auto', context: contextWithFocus(),
    memory: {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []}});
  assert.match(first.text, /性格「专注」/);
  assert.match(first.text, /1 光刃/, '四个技能要按页面那一栏的顺序念出来');

  const second = focusSnapshotFrom({
    name: '魔力猫', group: 'pet_000007', level: 60,
    traits: [{label: '性格', value: '悠闲', status: 'known'},
      {label: '资质', value: {def: 7, spe: 7, spd: 10, spa: 0, atk: 0, hp: 0}, status: 'known'},
      {label: '天分档位', value: '了不起的天分', status: 'known'}],
    skills: [{order: 1, name: '抓挠', element: '普通系', category: '攻击', energy: 0, power_label: '35'}],
  }, {instanceId: 'own-0007'});
  const flipped = await runCoach({message: '这只是什么性格/带哪四个技能？', role: 'auto', context: contextWithFocus(second),
    memory: {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []}});
  assert.match(flipped.text, /魔力猫/);
  assert.match(flipped.text, /性格「悠闲」/);
  assert.doesNotMatch(flipped.text, /专注/, '换了对象还留着上一只的性格 = 焦点没跟上');
});

test('③b 认的是"眼前这一只"：点名了别的一只就不许答（会把 A 说成 B）', () => {
  assert.equal(focusAsk('这只是什么性格？', contextWithFocus()), true);
  assert.equal(focusAsk('它带哪四个技能？', contextWithFocus()), true);
  assert.equal(focusAsk('迪莫是什么性格？', contextWithFocus()), true, '点了焦点这一只的名也算');
  assert.equal(focusAsk('喵喵是什么性格？', contextWithFocus()), false, '点的是别一只 ⇒ 不许拿这一只顶');
  // 没有焦点就一律 false（老行为一字不变：仍由原来那几条路回答）。
  assert.equal(focusAsk('这只是什么性格？', contextWithFocus(null)), false);
  // 不是那几格的问题不许被吃掉（培养 / 战斗 / 闲聊各有各的路）。
  assert.equal(focusAsk('这只该怎么培养？', contextWithFocus()), false);
  assert.equal(focusAsk('这局我该换谁？', contextWithFocus()), false);
});

test('③c 事实回答走本地单发：0 次模型正文、正文与页面那一栏逐字一致', async () => {
  const context = contextWithFocus();
  assert.equal(focusDetailOf(context), context.focusDetail);
  assert.equal(localFactAsk('这只是什么性格？', {need: null, reason: null}, context), true);
  const answer = focusFactAnswer('这只是什么性格/天分/带哪四个技能？', context);
  // 逐字：性格 / 天分档位 / 四个技能名 / 资质六项（顺序与 box-drawer 的 STAT_ORDER 一致）。
  assert.match(answer.text, /性格「专注」/);
  assert.match(answer.text, /资质 生命 0 \/ 物攻 7 \/ 物防 10 \/ 魔攻 0 \/ 魔防 7 \/ 速度 0/);
  assert.match(answer.text, /天分档位「相当好的天分」/);
  for (const name of ['光刃', '防御', '棘突', '抽枝']) assert.ok(answer.text.includes(name), name);
  // 威力那一格页面写的是「游戏数据里没有这一项」⇒ 小芽也这么写（不许写 0）。
  assert.match(answer.text, /2 防御（普通系 · 防御 · 耗能 1 · 威力 游戏数据里没有这一项）/);
  assert.deepEqual(answer.trace, []);
  const ran = await runCoach({message: '这只是什么性格/天分/带哪四个技能？', role: 'auto', context,
    memory: {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []}});
  assert.equal(ran.text, answer.text);
  assert.equal(ran.agentStop, 'policy-fact-local', '本地单发：不许进模型');
});

test('③d 对战场上那一只：只有物种级公开信息，拿不到的照实说拿不到', () => {
  const battle = focusSnapshotFrom(null, {});
  assert.equal(battle, null);
  const detail = {instance_id: null, source: 'battle', live: true, battle_only: true,
    name: '迪莫', species_id: 'pet_000004', traits: [], skills: []};
  const context = contextWithFocus(null);
  context.focusDetail = detail;
  assert.equal(focusAsk('它带哪四个技能？', context), true);
  const answer = focusFactAnswer('它带哪四个技能？', context);
  assert.match(answer.text, /迪莫/);
  assert.match(answer.text, /读不到/, '不许拿别的数据补上它没有的四技能');
});

test('④ 焦点探测：DOM 优先于地址、地址优先于旧记录，旧记录要标成 last', () => {
  const body = {dataset: {boxPet: 'own-0004', boxView: 'pet'}};
  const doc = {body, getElementById: () => ({hidden: false})};
  assert.deepEqual(detectFocus({doc, loc: {search: '?pet=own-0009'}}),
    {instanceId: 'own-0004', scene: 'box-pet', source: 'box-pet', name: null},
    '页面上真画着谁比地址更准（地址可能还没跟上）');
  // 二级页收起了（回到列表）⇒ 地址还没清，但 DOM 已经不在那一屏 ⇒ 用地址。
  assert.equal(detectFocus({doc: {body, getElementById: () => ({hidden: true})}, loc: {search: '?pet=own-0009'}}).source,
    'box-pet-url');
  // 地址与 DOM 都没有：翻上一轮的记录，**如实标成 last**。
  const storage = {getItem: (key) => (key === FOCUS_KEY ? JSON.stringify({instanceId: 'own-0007', name: '魔力猫'}) : null)};
  assert.deepEqual(detectFocus({doc: {body: {dataset: {}}, getElementById: () => null}, loc: {search: ''}, storage}),
    {instanceId: 'own-0007', scene: 'last', source: 'last', name: '魔力猫'});
  // 什么都没有 ⇒ 老老实实 null（不许拿名单第一只冒充"你在看的那只"）。
  assert.equal(detectFocus({doc: {body: {dataset: {}}, getElementById: () => null}, loc: {search: ''}}).instanceId, null);
  // 坏记录当没有。
  assert.equal(detectFocus({doc: {body: {dataset: {}}, getElementById: () => null}, loc: {search: ''},
    storage: {getItem: () => '{坏'}}).instanceId, null);
});

test('④b provider：焦点换了才重新取详情（同一只不重复请求），订阅能收到变化', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const id = decodeURIComponent(String(url).split('detail=')[1]);
    return {ok: true, status: 200, json: async () => ({ok: true,
      player: {...PAGE_DETAIL, name: id === 'own-0004' ? '迪莫' : '魔力猫'}})};
  };
  let search = '?pet=own-0004';
  const provider = createFocusProvider({doc: {body: {dataset: {}}, getElementById: () => null},
    loc: {get search() { return search; }}, storage: null, win: {}, fetchImpl});
  const seen = [];
  const off = provider.subscribeContextChanged((context) => seen.push(context.focusName));
  const first = await provider.resolve();
  assert.equal(first.snapshot.name, '迪莫');
  assert.equal(provider.getContext().focusInstanceId, 'own-0004');
  await provider.resolve();
  assert.equal(calls.length, 1, '同一只连问两次不许重复取详情');
  search = '?pet=own-0007';
  const second = await provider.resolve();
  assert.equal(second.snapshot.name, '魔力猫');
  assert.equal(calls.length, 2);
  assert.ok(seen.includes('魔力猫'), '焦点变了要通知订阅方（界面那一行跟着换）');
  off();
  search = '?pet=own-0004';
  await provider.resolve();
  assert.equal(seen.at(-1), '魔力猫', '退订之后不再收到');
  // 读不出来：如实记原话，不假装有一份快照。
  const broken = createFocusProvider({doc: {body: {dataset: {}}, getElementById: () => null},
    loc: {search: '?pet=own-9999'}, storage: null, win: {},
    fetchImpl: async () => ({ok: false, status: 404, json: async () => ({ok: false, error: '找不到这个精灵或个体：own-9999'})})});
  const failed = await broken.resolve();
  assert.equal(failed.snapshot, null);
  assert.match(broken.failureOf(), /own-9999/);
  assert.equal(FOCUS_EVENT, 'xiaoya:focus');
});

test('⑤ 历史可见：重载读到旧轮次；「新对话」「清空本次对话」两件事各自成立', () => {
  let store = emptyChatStore();
  store = appendChatTurn(store, 'user', '这只是什么性格？', 1000);
  store = appendChatTurn(store, 'assistant', '性格「专注」。', 1001);
  // 重载：序列化 → 反序列化（页面刷新走的就是这一条）。
  const reloaded = readChatStore(serializeChatStore(store));
  const session = activeChatSession(reloaded);
  assert.deepEqual(session.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(session.turns[0].content, '这只是什么性格？', '重载后第一条就是聊过的那一轮');

  // 「新对话」：换一段，旧的那段**留在**列表里。
  const fresh = beginNewChatSession(reloaded, 2000);
  assert.notEqual(fresh.activeId, reloaded.activeId);
  assert.equal(fresh.sessions.length, 2);
  assert.equal(fresh.sessions.find((s) => s.id === reloaded.activeId).turns.length, 2);

  // 连点「新对话」不许造出一串空会话（上限 8 条，真会话会被挤掉）。
  let spam = fresh;
  for (let i = 0; i < 12; i += 1) spam = beginNewChatSession(spam, 3000 + i);
  assert.equal(spam.sessions.length, 2, '空会话不该越点越多');
  assert.ok(spam.sessions.some((s) => s.turns.length === 2), '旧对话必须还在');

  // 「清空本次对话」：只清这一段；别的会话一个字段不动。
  const cleared = clearActiveChatSession(reloaded, 4000);
  assert.equal(activeChatSession(cleared).turns.length, 0);
  assert.equal(cleared.sessions.length, 1);
  assert.equal(cleared.activeId, reloaded.activeId, '清空 ≠ 新开一段');
  assert.ok(CHAT_LIMITS.sessions >= 8);
});

test('⑥ 不许跨域串味（P0-05 ④）：洛手的焦点问到的是洛手的数据，不是旧游戏那三只', async () => {
  // 修前的老路是把上下文建成 `pet-coach-growth-v1`（烬尾狐/潮甲龟/林鹿）——
  // 那三只属于本仓练习引擎，与 622 图鉴不是一套。小芽这一页现在一律送手游那一侧，
  // 判据钉两件事：① 名字不出现；② 出现的必须是页面上那一只的真名。
  const legacy = ['烬尾狐', '潮甲龟', '林鹿'];
  const answer = await runCoach({message: '这只是什么性格？', role: 'auto', context: contextWithFocus(),
    memory: {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []}});
  for (const name of legacy) assert.ok(!answer.text.includes(name), `旧游戏语料不许出现：${name}`);
  assert.match(answer.text, /迪莫/);
  // 取名单那一条也必须点明是手游盒子（不是练习局存档）。
  const source = read('src/client/xiaoya.js');
  assert.match(source, /\/api\/roco\/box\?kind=mine/, '手游名单那一条通路还在');
  assert.match(source, /\/api\/roco\/box\?detail=/, '焦点详情那条通路必须与页面同源');
  assert.match(read('src/client/box.js'), /\/api\/roco\/box\?detail=/, 'box.js 详情页取的也是这一条');
});

test('⑦ 反漂移：小芽读的那几个页面钩子必须还在（改一边不改另一边会红）', () => {
  const box = read('src/client/box.js');
  assert.match(box, /document\.body\.dataset\.boxPet = select/, 'box.js 写 body[data-box-pet] 那一行');
  assert.match(box, /body\.dataset\.boxView = 'pet'/, "box.js 写 body[data-box-view]='pet' 那一行");
  assert.match(box, /getElementById\('pet-view'\)|\$\('pet-view'\)/, 'box.js 的 #pet-view 那一屏');
  const workshop = read('src/client/team-workshop.js');
  assert.match(workshop, /data-tw-instance=/, '工作台候选卡上的个体钩子');
  const xiaoya = read('src/client/xiaoya.js');
  assert.match(xiaoya, /dataset\?\.boxPet/, '小芽读的就是上面那几个钩子');
  assert.match(xiaoya, /data-tw-instance/, '小芽读工作台候选卡');
  // 焦点详情不许自己再拼一份取值：只许读 `?detail=` 回执里 page 那一层。
  assert.match(xiaoya, /body\.player/, '详情取值只有一处');
  assert.match(xiaoya, /body\?\.ok === false/, 'HTTP 不是唯一判据：body.ok 也要看');
});

// ── 2026-09-29 Codex 监工第 1 条（硬崩溃）与第 2 条（同一只刷新后要跟上）──────
//
// 这两条都不是"想出来的边界"，是**实测**：
//   ① Codex 拿 `traits: []` 掉了一次 `TypeError: Cannot read properties of null (reading 'text')`；
//   ② 刷新/回滚写的是本机记录，而 `createFocusProvider` 原来只在**个体编号**变化时才拉详情
//      ⇒ 同一只刷完再问，小芽读的还是旧那一份。

/** 六种"缺字段"形状 —— 每一种都必须**诚实降级**：不编、不抛。 */
const DEGRADED = {
  'traits 为空数组': {name: '喵喵', instance_id: 'own-0001', live: true, traits: [], skills: []},
  'traits 只有部分键（只有性格）': {name: '喵喵', instance_id: 'own-0001', live: true,
    traits: [{label: '性格', value: '稳重'}], skills: []},
  '性格值为 null': {name: '喵喵', instance_id: 'own-0001', live: true,
    traits: [{label: '性格', value: null, reason: '页面上没有这一项'}], skills: []},
  'skills 为空数组': {name: '喵喵', instance_id: 'own-0001', live: true,
    traits: [{label: '性格', value: '稳重'}], skills: []},
  '只有名字（其余什么都没有）': {name: '喵喵', instance_id: 'own-0001', live: true},
  'live:false（上一轮看的那一只）': {name: '喵喵', instance_id: 'own-0001', live: false,
    traits: [{label: '性格', value: '稳重'}], skills: []},
};
const FOCUS_QUESTIONS = ['这只是什么性格？', '它带哪四个技能？', '这只的资质/天分是多少？',
  '这只的等级是多少？', '这是哪一只？'];

test('⑧ 缺字段不许炸：六种形状 × 五个问句，全部要么短答要么如实说"读不到"', () => {
  for (const [label, detail] of Object.entries(DEGRADED)) {
    for (const question of FOCUS_QUESTIONS) {
      let answer = null;
      assert.doesNotThrow(() => { answer = focusFactAnswer(question, {focusDetail: detail}); },
        `${label} / ${question}：读了 null 的字段（修前正是这里 TypeError）`);
      // 答不出来就必须**说清哪一格读不到**，不许安静地返回一句空话。
      if (answer) assert.match(answer.text, /喵喵|读不到|性格|资质|技能|等级|Lv/, `${label} / ${question}：答句不能是空的`);
      assert.ok(!/undefined|null|NaN|\[object/.test(answer?.text ?? ''), `${label} / ${question}：正文里不许漏内部形状`);
    }
  }
  // `focusDetail` 整个为 null ⇒ 交回别的路（不抛、也不冒充能答）。
  for (const question of FOCUS_QUESTIONS) {
    assert.equal(focusFactAnswer(question, {focusDetail: null}), null, question);
    assert.equal(focusFactAnswer(question, null), null, question);
  }
  // 有值的形状仍然要答对（反证：上面那几条不是在"一律不答"）。
  const ok = focusFactAnswer('这只是什么性格？', {focusDetail: DEGRADED['traits 只有部分键（只有性格）']});
  assert.match(ok.text, /性格「稳重」/, '有值就必须答出那个值 —— 把有的说成没有也是骗玩家');
});

test('⑨ 意图分叉：事实问短答，建议问给建议 + 理由（不许把建议问降级成复述）', () => {
  const detail = {...SNAPSHOT, species_id: 'pet_000004'};
  const context = {focusDetail: detail};
  assert.equal(focusIntent('这只是什么性格？', context), 'fact');
  assert.equal(focusIntent('它带哪四个技能？', context), 'fact');
  assert.equal(focusIntent('这只的资质/天分是多少？', context), 'fact');
  for (const advice of ['这只适合什么性格？为什么？', '这只该用什么性格', '这只的性格怎么优化？',
    '这只的技能该怎么优化？', '它该不该换个性格？']) {
    assert.equal(focusIntent(advice, context), 'advice', advice);
    assert.equal(focusFactAnswer(advice, context), null, `${advice}：建议问不许走事实复述`);
  }
  // 事实问短答：问性格就只回答性格那一格，不再把资质/技能整段倒出来。
  const fact = focusFactAnswer('这只是什么性格？', context);
  assert.match(fact.text, /性格「专注」/);
  assert.doesNotMatch(fact.text, /光刃/, '问性格不该顺带把四个技能端出来');
  assert.doesNotMatch(fact.text, /资质 生命/, '问性格不该顺带把资质端出来');
});

test('⑨b 建议答：有推荐 + 有理由 + 指得到依据；拿不到依据的层如实说拿不到', async () => {
  const detail = {...SNAPSHOT, species_id: 'pet_000004'};
  const advice = await focusAdviceAnswer('这只适合什么性格？为什么？', {focusDetail: detail});
  assert.ok(advice, '建议问必须给出建议，不许 null');
  assert.match(advice.text, /\*\*建议\*\*/, '要有明确的推荐段');
  assert.match(advice.text, /把.{1,4}抬 \+10%（\d+ → \d+），代价是.{1,4}掉 -10%（\d+ → \d+）/,
    '每条推荐必须带**现算的**取舍（换来什么 / 牺牲什么）');
  assert.match(advice.text, /full-catalog\.json/, '理由要指得到登记数据（种族值来源）');
  assert.match(advice.text, /性格表/, '理由要指得到性格表');
  assert.match(advice.text, /零突破/, '假设要写在明面上');
  // 当前那一只的性格只能当**依据**出现（"你现在带的…"），不能当答案。
  assert.match(advice.text, /你现在带的「专注」实际做的是：/);
  // 资质/技能这两层没有登记的加成 ⇒ 明确说给不了，不许编一个"该用哪种资质"。
  const talentAdvice = await focusAdviceAnswer('这只的资质该怎么优化？', {focusDetail: detail});
  assert.match(talentAdvice.text, /给不了/, '没有登记依据的那一层必须如实说给不了');
  // 页面送来 `race` 的那条路（**浏览器里唯一能走的路** —— `raceOf()` 要 `import('node:fs')`：
  // 真机实测过，先调它会让这一支整段抛异常、玩家拿到陪练那句「哪句不清楚，我再讲一遍」）。
  const browserish = await focusAdviceAnswer('这只适合什么性格？为什么？', {focusDetail: {...detail,
    race: {hp: 120, atk: 80, def: 105, spa: 80, spd: 105, spe: 92}}});
  assert.match(browserish.text, /\*\*建议\*\*/, '页面送来种族值时也要给得出建议');
  assert.match(browserish.text, /种族值：页面「六维（60 级）」/, '依据要说清这一份种族值是从页面那一栏来的');
  assert.match(browserish.text, /代价是/, '仍然要带取舍');
  // 种族值查不到时也不许编（用一个不存在的物种 id）。
  const noRace = await focusAdviceAnswer('这只适合什么性格？', {focusDetail: {...detail, species_id: null}});
  assert.match(noRace.text, /种族值/, '拿不到依据要说清卡在哪一层');
  // 不是建议问就 null（不许抢事实问的那条路）。
  assert.equal(await focusAdviceAnswer('这只是什么性格？', {focusDetail: detail}), null);
});

test('⑩ 同一只刷新/回滚：失效条件看的是**培养指纹 + 刷新计数**，不是只看个体编号', async () => {
  // 一份会变的本机记录：内容变（刷新）→ 指纹变；回滚 → 指纹回去而 revision 只增不减。
  const state = {nature: '稳重', talent: {hp: 7, atk: 0, def: 0, spa: 10, spd: 0, spe: 9}, vs: 0, ts: 0};
  const record = () => ({individual_id: 'own-0001', level: 60, nature: state.nature, talent: {...state.talent},
    talent_boosts: state.ts ? [{tier: 1, stat: 'spa', delta: 10}] : [], rolls: {nature: state.vs, talent: state.ts}});
  const fetchImpl = async () => ({ok: true, status: 200,
    json: async () => ({ok: true, player: {...PAGE_DETAIL, name: '喵喵', group: 'pet_000001', entity: 'instance'}})});
  const provider = createFocusProvider({doc: {body: {dataset: {}}, getElementById: () => null},
    loc: {search: '?pet=own-0001'}, storage: null, win: {}, fetchImpl,
    readCultivation: () => cultivationOf(record())});
  const seen = [];
  provider.subscribeContextChanged((context) => seen.push(`${context.visibleSnapshot?.nature}|${context.visibleSnapshot?.fingerprint}`));

  const first = await provider.resolve();
  assert.equal(first.snapshot.cultivation_source, 'local-record', '培养那几样必须来自本机记录（与页面同一份）');
  assert.equal(first.snapshot.nature, '稳重');
  const keyBefore = provider.getContext().buildRevision;

  // ① 刷新性格：同一只、编号没变 —— 只看编号的旧实现会在这里继续读旧的。
  state.nature = '踏实'; state.vs = 1;
  const afterRefresh = await provider.resolve();
  assert.equal(afterRefresh.snapshot.nature, '踏实', '刷新之后必须是新的那一份');
  assert.notEqual(provider.getContext().buildRevision, keyBefore, '内容指纹变了 ⇒ buildRevision 必须变');

  const revisionAfterRefresh = provider.getContext().buildRevision;
  assert.match(revisionAfterRefresh, /1\.0$/, `刷新后 revision 应记到 1.0：${revisionAfterRefresh}`);
  // ② 回滚：内容回到刷新前 —— 指纹回去（回滚那一下**内容真的变过**），
  //    而 revision **只增不减**（"刷了一次又退回去"净效果为零的操作只有它认得出来）。
  state.nature = '稳重';
  const afterUndo = await provider.resolve();
  assert.equal(afterUndo.snapshot.nature, '稳重', '回滚之后念刷新前那一份');
  assert.ok(provider.getContext().buildRevision.endsWith('|1.0'),
    `回滚不许动 revision（只增不减）：${provider.getContext().buildRevision}`);
  assert.equal(afterUndo.snapshot.fingerprint, first.snapshot.fingerprint,
    '回滚之后内容指纹逐字回到刷新前 —— 这就是"屏幕上的数字回去"的机器可读版本');
  assert.ok(seen.length >= 3, '每一次变化都要通知订阅方（界面上那一行跟着换）');
  // 数字跟着变 = 回答跟着变（端到端一遍，用的是同一个上下文装配）。
  const answer = await runCoach({message: '这只是什么性格？', role: 'auto',
    context: {...buildContext(null, {pets: []}, 'own-0001', null, 'meadow', ''), coachAllowed: true,
      focusDetail: {...provider.getContext().visibleSnapshot, live: true}},
    memory: {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []}});
  assert.match(answer.text, /性格「稳重」/);
});

test('⑪ 培养那几样与页面**同一份来源**：注入本机记录时不许再念服务端回执里那份', () => {
  // 服务端回执说「专注」，本机记录（页面上画的就是它）说「踏实」 ⇒ 必须念本机那一份。
  const cultivation = {individual_id: 'own-0004', level: 60, nature: '踏实',
    talent: {hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6}, talentBase: {}, boosts: 0,
    tier: {label: '了不起的天分', reason: null}, fingerprint: 'id=own-0004|nature=踏实|talent=hp1.atk2.def3.spa4.spd5.spe6|boosts=-',
    revision: '1.0'};
  const snapshot = focusSnapshotFrom(PAGE_DETAIL, {instanceId: 'own-0004', cultivation});
  assert.equal(snapshot.nature, '踏实', 'A7 之后页面读本机记录 ⇒ 小芽也必须读它');
  assert.deepEqual(snapshot.talent, cultivation.talent);
  assert.equal(snapshot.talent_tier, '了不起的天分');
  assert.equal(snapshot.cultivation_source, 'local-record');
  // 技能/名字这些**物种冻结事实**仍然来自回执（刷新改不了它们）。
  assert.equal(snapshot.name, '迪莫');
  assert.deepEqual(snapshot.skills.map((s) => s.name), ['光刃', '防御', '棘突', '抽枝']);
  // 反证：不注入本机记录时仍退回回执（图鉴物种页/还没建记录的那一帧）—— 这是**退路**不是主路。
  assert.equal(focusSnapshotFrom(PAGE_DETAIL, {instanceId: 'own-0004'}).cultivation_source, 'server-detail');
});

test('⑨c 端到端路由（这一条是**改钉**：函数对了不等于路由接上了）', async () => {
  // 真机踩到过：`focusAdviceAnswer` 本身写对了、单测直接调它也绿，
  // 但 `localFactAnswer` 的**分发**漏了 —— 玩家在页面上问建议问，拿到的还是陪练那句
  // 「你想问哪一段，我再说一遍。」。所以这一条必须从 `runCoach` 进去。
  const detail = {...SNAPSHOT, species_id: 'pet_000004',
    race: {hp: 120, atk: 80, def: 105, spa: 80, spd: 105, spe: 92}};
  const context = {...buildContext(null, {pets: [{id: 'own-0004', name: '迪莫'}],
    pool_summary: {total: 542, source: 'owned'}}, 'own-0004', null, 'meadow', ''), coachAllowed: true,
    focusDetail: {...detail, live: true}};
  const memory = {journal: [], reflections: {}, watches: [], quizCount: 0, goal: null, dialogue: []};
  const adviceRun = await runCoach({message: '这只适合什么性格？为什么？', role: 'auto', context, memory, conversation: []});
  assert.match(adviceRun.text, /\*\*建议\*\*/, '建议问必须走到建议那一支');
  assert.match(adviceRun.text, /代价是/, '建议要带取舍');
  assert.equal(adviceRun.agentStop, 'policy-fact-local', '仍然是 0 次模型调用');
  const factRun = await runCoach({message: '这只是什么性格？', role: 'auto', context, memory, conversation: []});
  assert.match(factRun.text, /性格「专注」/);
  assert.doesNotMatch(factRun.text, /\*\*建议\*\*/, '事实问不许被建议那一支抢走');
  assert.notEqual(factRun.text, adviceRun.text, '两次的回答必须明显不同');
});

// ── art-finish D①-b / D①-c（2026-09-29）：六槽钩子要有人读、焦点不许滞后一拍 ──
//
// D 的独立验收在真机上量到两条：`data-tw-slot-instance` **有写入、无读取方**（点六槽不派发焦点）；
// 而且**点完立刻读** `[data-xy-focus]` 仍是"没在看"，要**再问一句**才变（滞后一拍）。
// 这两条直接决定"小芽知道我在看谁"这条主线成不成立，所以钉在纯函数 + provider 两层上。

/** 一个最小的假元素（只实现 `closest`/`getAttribute`/`querySelector`，够 `focusFromClick` 用）。 */
function fakeEl(attrs = {}, kids = {}) {
  const self = {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (sel) => kids[sel] ?? null,
    closest: (sel) => (sel.replace(/^\[|\]$/g, '') in attrs ? self : null),
    textContent: kids.text ?? '',
  };
  return self;
}

test('⑫ 点第 N 格 → 焦点是**这一格的个体 id**（不许按名字猜物种）', () => {
  // 六槽卡片：`data-tw-slot-instance` 是这一格装的那个个体（team-workshop.js 写的钩子）。
  const slot = fakeEl({'data-tw-slot-instance': 'own-0004', 'data-tw-slot': '3'},
    {'.tw-who': {textContent: '迪莫'}});
  const inner = {...fakeEl(), closest: (sel) => (sel === '[data-tw-slot-instance]' ? slot : null)};
  assert.deepEqual(focusFromClick(inner),
    {instanceId: 'own-0004', scene: 'team-slot', name: '迪莫'});
  // 候选池那张卡（`data-tw-instance`）：槽位钩子不在时用它。
  const card = fakeEl({'data-tw-instance': 'own-0007'}, {'.tw-name': {textContent: '魔力猫'}});
  const innerCard = {...fakeEl(), closest: (sel) => (sel === '[data-tw-instance]' ? card : null)};
  assert.deepEqual(focusFromClick(innerCard),
    {instanceId: 'own-0007', scene: 'team-candidate', name: '魔力猫'});
  // 空钩子（空格位/名字重复那种）不许当成焦点 —— 空串不是 id。
  const empty = fakeEl({'data-tw-slot-instance': '  '});
  const innerEmpty = {...fakeEl(),
    closest: (sel) => (sel === '[data-tw-slot-instance]' ? empty : null)};
  assert.equal(focusFromClick(innerEmpty), null);
  // 点在不带钩子的地方 ⇒ 不改变焦点。
  assert.equal(focusFromClick(fakeEl()), null);
  assert.equal(focusFromClick(null), null);
  // 反漂移：这两个钩子名必须还在 `team-workshop.js` 里写着（改一边不改另一边要红）。
  assert.match(read('src/client/team-workshop.js'), /data-tw-slot-instance=/,
    '六槽卡片的个体钩子（writer 那一半）');
  assert.match(read('src/client/team-workshop.js'), /data-tw-instance=/,
    '候选池卡片的个体钩子');
});

test('⑬ 点完**立刻**就是焦点（不许滞后一拍）：状态里同步换人，不用等下一次 resolve', async () => {
  const provider = createFocusProvider({doc: {body: {dataset: {}}, getElementById: () => null},
    loc: {search: ''}, storage: null, win: {}, fetchImpl: async () => { throw Error('本用例不该联网'); }});
  const seen = [];
  provider.subscribeContextChanged((context) => seen.push({id: context.focusInstanceId,
    live: context.focusLive, snap: context.visibleSnapshot}));
  assert.equal(provider.getContext().focusInstanceId, null, '起点：没在看具体的某一只');
  // 玩家那一下点击（同步事实）⇒ 状态必须**当场**跟上。
  provider.notePicked({instanceId: 'own-0004', scene: 'team-slot', name: '迪莫'});
  const now = provider.getContext();
  assert.equal(now.focusInstanceId, 'own-0004', '点完立刻读就必须是这一只（滞后一拍 = 这条红）');
  assert.equal(now.focusName, '迪莫');
  assert.equal(now.focusLive, true);
  assert.equal(now.visibleSnapshot, null, '详情还没取回来 ⇒ 快照是 null，但"在看谁"已经有答案');
  assert.ok(seen.some((row) => row.id === 'own-0004'), '订阅方（那一行）当场收到');
  // 再点另一格：还是当场换。
  provider.notePicked({instanceId: 'own-0007', scene: 'team-slot', name: '魔力猫'});
  assert.equal(provider.getContext().focusInstanceId, 'own-0007');
  // 空 id 不许把焦点清掉（误点空格位不该让"我在看谁"消失）。
  provider.notePicked({instanceId: '', scene: 'team-slot'});
  assert.equal(provider.getContext().focusInstanceId, 'own-0007');
});

test('⑭ 兜底不许把**没过守卫的模型正文**漏给玩家（值守卫拦下的东西不许从降级路出去）', async () => {
  // 由来（Lead 在已提交状态里抓到的真回归，玩家可见）：`executeCoach` 的守卫降级原来写的是
  // `text: data.localText ?? data.text` —— 服务端**没给 `localText`** 时就把模型那段
  // 没过事实守卫的正文原样端出去，回执还标着 `local-fallback`（看着像"本机算的"）。
  // 打桩实测：`{provider:'deepseek',text:'造成99999伤害，必胜'}` ⇒ 玩家看到「99999」。
  //
  // 这一份钉的是**同一件事在 `requestCoach` 那一层**：喂一段过不了守卫的模型正文、
  // **且不给 `localText`** ⇒ 正文必须来自确定性那一份（本机 runCoach），绝不含假数值；
  // 反证：把兜底改回 `data.localText ?? data.text` ⇒ 本用例立刻红（响度实测见交付）。
  const {createGame} = await import('../src/game/engine.js');
  const {newProfile} = await import('../src/game/progression.js');
  const {freshMemory} = await import('../src/coach/memory.js');
  const payload = {message: '这回合怎么打', role: 'auto',
    context: buildContext(createGame(17), newProfile(), 'fox'), memory: freshMemory(), stateToken: 42};
  const original = globalThis.fetch;
  const stub = (coach) => {
    globalThis.fetch = async (url) => ({ok: true, json: async () => (String(url).includes('bootstrap')
      ? {csrf: 'test-only'} : coach)});
  };
  try {
    // ① 模型正文没过守卫、且**没有** localText ⇒ 不许出现那段原文里的假数值
    stub({provider: 'deepseek', text: '造成99999伤害，必胜', evidence: ['实际伤害38'], memory: freshMemory()});
    const {requestCoach} = await import('../src/coach/client.js');
    const a = await requestCoach(payload);
    assert.equal(a.provider, 'local-fallback', '没过守卫必须如实标成本机兜底');
    assert.equal(a.stateToken, 42, '状态令牌照旧带回来');
    assert.ok(!String(a.text).includes('99999'), `守卫拦下的假数值不许漏出去：${a.text}`);
    assert.ok(!String(a.text).includes('必胜'), '模型那段原文一个字都不许端出去');
    assert.ok(String(a.text).trim().length > 0, '兜底也要给得出一句话');
    // ② 服务端**给**了 localText ⇒ 用服务端算好的那一份（那是引擎/工具的确定性正文）
    stub({provider: 'deepseek', text: '造成99999伤害，必胜', localText: '这一回合优先考虑「火花」。',
      evidence: [], memory: freshMemory()});
    const b = await requestCoach({...payload, message: '这回合怎么打（第二次）'});
    assert.equal(b.provider, 'local-fallback');
    assert.equal(b.text, '这一回合优先考虑「火花」。', '有 localText 就用它');
    assert.equal(b.deterministicFrom, 'server', '要能看出这一份是从哪儿来的');
  } finally {
    globalThis.fetch = original;
  }
});

// ── task-12（丙，2026-09-29）：产品页（roco.html）必须用**同一份**焦点实现与同一份资料通路 ──
//
// 背景（art-finish D①-a 的真相比原描述严重）：工作台页上还有**第二个**小芽实现
//（`#companion-card`，接线在 `roco.js`）。它当时：没密钥时 `/api/coach` **0 次**、
// 答「我在。…请配置密钥」、没有焦点。Lead 拍板走"丙"——**不新起第三套**，只把**共享模块**接进去。
test('⑮ 丙：产品页的焦点只用共享实现；断线档不许再退回"请配置密钥"', () => {
  const roco = read('src/client/roco.js');
  const html = read('src/client/roco.html');
  // ① 焦点**只有一份实现**：import `xiaoya.js` 那两个导出，不许在本文件里重写一份。
  // ⚠ 2026-09-29 改钉（task-13 甲③）：同一行 import 现在多带了 `migrateLegacyMemory`
  //（两套记忆键合并）—— 断言从"逐字三个名字"改成"这一行确实 import 了那两个焦点导出"，
  // 意图一个字没松：**焦点只有一份实现**，`roco.js` 只能 import。
  assert.match(roco, /import \{[^}]*\bcreateFocusProvider\b[^}]*\bfocusFromClick\b[^}]*\} from '\.\/xiaoya\.js'/,
    'roco.js 要 import 共享的焦点 provider/解析函数');
  assert.doesNotMatch(roco, /function focusFromClick\s*\(/, '解析函数不许有第二份');
  assert.doesNotMatch(roco, /function createFocusProvider\s*\(/, 'provider 不许有第二份');
  // ② 焦点要真的进上下文（否则"我看的那只"还是传不进去）
  assert.match(roco, /context\.focusDetail = \{\.\.\.focus\.snapshot/,
    '聚焦对象必须挂进 /api/coach 的上下文');
  // ③ 落点：那一行（玩家看得见"正在看谁"）。
  // ⚠ 2026-09-30 **改钉**（task-13 甲④-1：旧面板退役）。旧断言原文留档：
  //     assert.match(html, /id="companion-focus"/, '小芽面板里要有焦点那一行');
  // 为什么改：`#companion-card` 整块已经从 `roco.html` 退役（同一页只留 `xiaoya.js` 一套实现），
  // 所以焦点那一行由**浮层自己的**元素承担；**意图一个字没松**：屏幕上必须有一处写着"在看谁"。
  assert.doesNotMatch(html, /id="companion-card"/, '甲④ 之后旧面板的 DOM 不许回来');
  assert.match(read('src/client/xiaoya.js'), /id = mode === 'page' \? 'xy-focus' : 'xiaoya-focus'/,
    '新家要有焦点那一行（浮层里的小芽焦点 chip）');
  // ④ 断线档：不许再有"没配密钥就直接 return 离线模板"那一支（P0-01 的第二份实现）
  // ⚠ 只看**代码行**（`\n\s*if`）：旧写法在文件里以注释留档（"旧写法原文留档，别再改回来"），
  //   那一段当然会被同一个正则命中 —— 判据不能把留档当成代码。
  assert.doesNotMatch(roco, /\n\s*if \(!configured\) \{/,
    '没密钥也要先走服务端；离线模板只当请求失败后的兜底');
  assert.match(roco, /if \(!configured\) document\.body\.dataset\.rocoCompanionBoundary/,
    '这一档只记一个数据钩子，不再直接改屏');
  // ⑤ 共享模块的入口要能被 import（`xiaoya.js` 必须导出这两个）
  const xiaoya = read('src/client/xiaoya.js');
  assert.match(xiaoya, /export function createFocusProvider/, '导出 provider');
  assert.match(xiaoya, /export function focusFromClick/, '导出解析函数');
});

test('⑯ 甲①：宿主动局上下文口（`mountXiaoya({contextProvider})`）—— 局中不许退成"没有对战况"', async () => {
  // 为什么必须有它（Lead 写死的顺序）：`xiaoya.js` 原来把上下文写死成"没有对局"
  //（`buildContext(null, …, 'meadow', …)`），而产品页的小芽要在**对局中**回答"我现在该换谁"。
  // 没有这个口就退役旧面板 = **功能倒退**，不是"少一套 UI"。
  const {hostContextOf, readHostContext} = await import('../src/client/xiaoya.js');
  // ① 规整：缺什么就是什么，不猜、不补
  assert.deepEqual(hostContextOf(null), {game: null, archive: null, stageId: null, extra: null});
  assert.deepEqual(hostContextOf('游戏'), {game: null, archive: null, stageId: null, extra: null});
  const game = {id: 'g1', mode: 'camp'};
  const full = hostContextOf({game, archive: {current: game}, stageId: '  meadow-2  ',
    extra: {roco_battle: {turn: 3}, roco_plan: {recommendation: '换人'}, empty: null, missing: undefined}});
  assert.equal(full.game, game);
  assert.deepEqual(full.archive, {current: game});
  assert.equal(full.stageId, 'meadow-2', 'stageId 要去空白（它是真实关卡 id）');
  assert.deepEqual(full.extra, {roco_battle: {turn: 3}, roco_plan: {recommendation: '换人'}},
    'null/undefined 的键**不并进去**（拿不到就不加那个字段）');
  assert.equal(hostContextOf({stageId: '   '}).stageId, null, '空白 stageId 当成没给');
  assert.equal(hostContextOf({extra: []}).extra, null, '数组不是 extra');
  // ② 宿主 provider 抛异常 ⇒ 如实记一句，但**不许把问话打断**
  const broken = await readHostContext(() => { throw Error('宿主这一屏还没准备好'); });
  assert.deepEqual(broken.context, {game: null, archive: null, stageId: null, extra: null});
  assert.match(broken.failure, /宿主这一屏还没准备好/, '原因要带回来（进 context.hostContextFailure）');
  const none = await readHostContext(null);
  assert.equal(none.failure, null, '没给 provider 就不算失败');
  // ③ 端到端：局中的问句要真的拿到战况（把上游那段装配跑一遍）
  const battle = {id: 'match-1', mode: 'pvp-local', version: '0.6', turn: 4, phase: 'battle',
    result: null, environment: null, player: {active: 0, pets: []}, enemy: {active: 0, pets: []},
    history: [], log: [], frames: []};
  const provided = hostContextOf({game: null, stageId: 'meadow',
    extra: {roco_battle: {battle_id: 'match-1', turn: 4, self: [{name: '迪莫', hp: 30, max_hp: 40, energy: 3}]}}});
  const context = buildContext(provided.game, {pets: [{id: 'own-0004', name: '迪莫'}]}, 'own-0004',
    provided.archive, provided.stageId ?? 'meadow', '我现在该换谁');
  Object.assign(context, provided.extra);
  assert.equal(context.battle, null, '这一档没有引擎整局对象（与旧面板一致）');
  assert.equal(context.roco_battle.turn, 4, '对局公开战况必须真的进去 —— 没有它 = 功能倒退');
  assert.equal(context.roco_battle.self[0].hp, 30);
  // ④ 反证：把口摘掉（provider 给 null）⇒ 战况就没了 —— 局中判据必须因此变红
  const withoutPort = buildContext(null, {pets: [{id: 'own-0004', name: '迪莫'}]}, 'own-0004',
    null, 'meadow', '我现在该换谁');
  assert.equal(withoutPort.roco_battle, undefined, '没接上下文口时上下文里就没有战况');
});

test('⑰ 甲③：两套记忆键合并 —— 旧键有数据 ⇒ 迁移后新键读得到（不许丢玩家记忆）', async () => {
  const {migrateLegacyMemory, mergeMemories, LEGACY_MEMORY_KEY, MEMORY_MIGRATED_FLAG} =
    await import('../src/client/xiaoya.js');
  const fakeStorage = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {map, getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k)};
  };
  const legacy = JSON.stringify({version: 1, goal: '稳健', preference: 'brief', favorite: '音速犬',
    lessons: ['失败后先看资源'], journal: [{id: 'j-old', time: '2026-01-01T00:00:00.000Z'}],
    events: [{id: 'm-old', result: 'loss', time: '2026-01-01T00:00:00.000Z'}], quizCount: 3});
  const current = JSON.stringify({version: 1, lastTopic: 'focus',
    journal: [{id: 'j-new', time: '2026-02-01T00:00:00.000Z'}]});
  // ① 旧键有数据、新键也有一部分 ⇒ 两边都要在（新键优先，旧的补缺）
  const store = fakeStorage({[LEGACY_MEMORY_KEY]: legacy, 'xiaoya-memory-v1': current});
  const first = migrateLegacyMemory(store);
  assert.equal(first.migrated, true, '旧键有数据 ⇒ 必须真的迁移');
  assert.equal(first.reason, 'merged');
  const after = readMemory(store.getItem('xiaoya-memory-v1'));
  assert.equal(after.goal, '稳健', '旧键的目标要读得到');
  assert.equal(after.favorite, '音速犬', '旧键的本命要读得到');
  assert.equal(after.preference, 'brief');
  assert.equal(after.lastTopic, 'focus', '新键自己那一份要保留');
  assert.deepEqual(after.lessons, ['失败后先看资源']);
  assert.deepEqual(after.journal.map((row) => row.id), ['j-old', 'j-new'], '两边的记录都在');
  assert.equal(after.events.length, 1, '旧键的对局记录也带过来');
  assert.equal(after.quizCount, 3);
  // ② 旧键**内容一个字不删**，只打一次标记
  const legacyAfter = store.getItem(LEGACY_MEMORY_KEY);
  assert.match(legacyAfter, /失败后先看资源/, '旧键里的内容不许被删');
  assert.match(legacyAfter, /migrated_to/, '旧键只加迁移标记');
  assert.equal(store.getItem(MEMORY_MIGRATED_FLAG), 'yes');
  // ③ 再跑一次不许重复合并（也不会把标记弄丢）
  const second = migrateLegacyMemory(store);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'already');
  // ④ 旧键没数据 ⇒ 什么都不做（但记一次"看过了"，之后不再反复读）
  const empty = fakeStorage({'xiaoya-memory-v1': current});
  assert.equal(migrateLegacyMemory(empty).reason, 'no-legacy');
  assert.equal(empty.getItem('xiaoya-memory-v1'), current, '没旧数据时不许动新键');
  // ⑤ 没有 storage（隐私模式/Node）⇒ 不许炸
  assert.equal(migrateLegacyMemory(null).reason, 'no-storage');
  // ⑥ 合并函数本身：标量缺就用旧的、列表取并集
  const merged = mergeMemories({goal: '速攻', lessons: ['a']}, {goal: null, lessons: ['b']});
  assert.equal(merged.goal, '速攻');
  assert.deepEqual(merged.lessons, ['a', 'b']);
  // ⑦ 产品页也读同一个键（否则"合并"只合了一半）
  const rocoSrc = read('src/client/roco.js');
  assert.match(rocoSrc, /const MEMORY_KEY = 'xiaoya-memory-v1'/, '产品页要用同一个记忆键');
  assert.match(rocoSrc, /migrateLegacyMemory\(localStorage\)/, '产品页读记忆之前要先迁移一次');
});

test('⑱ 甲②①：记忆面板搬进 xiaoya —— 同一套语义/同一批函数/同一套 id，且不许"两个名字"', () => {
  const src = read('src/client/xiaoya.js');
  const roco = read('src/client/roco.js');
  // ① 语义来源只有一份：`memoryItems` / `deleteMemoryItem` / `MEMORY_GROUPS` 都从 `coach/memory.js` 来
  assert.match(src, /import \{[^}]*\bmemoryItems\b[^}]*\bdeleteMemoryItem\b[^}]*\bMEMORY_GROUPS\b[^}]*\} from '\.\.\/coach\/memory\.js'/,
    '记忆的读取与删除必须用共享实现');
  assert.match(src, /memoryItems\(state\.memory\)\.filter\(\(row\) => row\.group === 'stated'\)/,
    '与旧面板同一条口径：只列玩家自己说过的（stated）');
  assert.match(src, /deleteMemoryItem\(state\.memory, \{id\}\)/, '删除走同一个函数');
  assert.match(src, /if \(!result\.deleted\) return;/, '没这条就不改页面、也不假装成功（旧面板同一条口径）');
  // ② DOM 形状**沿用同一套名字**（同一个语义同一个名字 —— Lead 批的只有这一种"复用"）
  assert.match(src, /id="memory-list"/, '沿用 #memory-list');
  assert.match(src, /class="mem-label"/, '沿用 .mem-label');
  assert.match(src, /class="mem-forget" data-forget=/, '沿用 .mem-forget + data-forget');
  // ③ **不许**给同一件东西再起一个旧名字（`#say-input`/`#say-reply` 这类别名 Lead 明确不批）
  assert.doesNotMatch(src, /say-input|say-reply/, 'xiaoya 里不许出现旧面板的输入/回复 id');
  // ④ 入口与钩子
  assert.match(src, /id = 'open-memory'/, '要有「查看记忆」入口（与旧面板同一个名字）');
  assert.match(src, /document\.body\.dataset\.xyMemory = rows\.length/, '面板换了主人 ⇒ 钩子换成 xy-memory');
  // ⑤ **甲④-1 已退役**（2026-09-30 改钉）。旧断言原文留档：
  //     assert.match(roco, /function renderMemory\(\)/, '甲④ 之前旧面板的 renderMemory 不许删');
  //     assert.match(read('src/client/roco.html'), /id="memory-pop"/, '甲④ 之前旧面板的 #memory-pop 不许删');
  // 现在反过来钉"它真的不在了"：`#memory-pop` / `#memory-list` 的 DOM 只在 xiaoya 那边有；
  // roco.html 里不许再出现旧面板（甲④-2 还要清掉 roco.js 里的死函数与替身）。
  assert.doesNotMatch(read('src/client/roco.html'), /id="memory-pop"|id="companion-card"/,
    '旧面板的 DOM 不许回到 roco.html');
  assert.doesNotMatch(read('src/client/roco.html'), /id="model-chip"/, '`#model-chip` 现在由 xiaoya 写（同名同语义）');
});

test('⑲ 甲②②：`#model-list` + `#open-connect` 搬进 xiaoya —— 同名 id/class、同一数据源、不写 chip', () => {
  const src = read('src/client/xiaoya.js');
  const roco = read('src/client/roco.js');
  // ① 同一个数据源（`/api/models`）与同一套 id/class
  assert.match(src, /fetch\('\/api\/models'/, '三格模型状态的来源必须是同一条只读接口');
  assert.match(src, /id="model-list" role="list"/, '沿用 #model-list');
  assert.match(src, /class="model-cell" data-model-id=/, '沿用 .model-cell + data-model-id');
  assert.match(src, /class="mc-name"/, '沿用 .mc-name');
  assert.match(src, /class="mc-state \$\{m\.connected \? 'ok' : 'no'\}"/, '沿用 .mc-state（ok/no 两档）');
  assert.match(src, /id="open-connect"/, '沿用 #open-connect');
  assert.match(src, /window\.open\('connect\.html', 'roco-connect'/, '与旧面板逐字同一条行为：独立小窗');
  // ② 拿不到数据不许猜（写「未知」，与旧面板同一条口径）
  assert.match(src, /const state = rows\.length \? \(m\.connected \? '已连' : '未连'\) : '未知'/);
  // ③ 一个读取点只能有一个写入者：这一块**不许**碰 `#model-chip`
  const block = src.slice(src.indexOf('const statusFold'), src.indexOf('const actions = document.createElement'));
  assert.doesNotMatch(block, /model-chip/, '三格那一块不许写 #model-chip（旧面板踩过"两个写入者"的坑）');
  // ④ 钩子换名字（面板换主人）；旧面板的 `data-roco-models` 退役时一起消失
  assert.match(src, /document\.body\.dataset\.xyModels =/);
  assert.doesNotMatch(src, /dataset\.rocoModels/, 'xiaoya 不该写旧面板的钩子');
  // ⑤ 甲④ 之前旧面板那一份还在
  assert.match(roco, /async function renderModelList\(\)/, '旧面板的 renderModelList 甲④ 之前不许删');
});

test('⑳ 甲②③：activityLine 逐字渲染 + popup 也有 role 选择 + `#model-chip` 由 xiaoya 写', () => {
  const src = read('src/client/xiaoya.js');
  // ① activityLine：用服务端给的那一句，页面不重拼（重拼=第二份事实）
  assert.match(src, /const activityLine = typeof answer\?\.activityLine === 'string' \? answer\.activityLine\.trim\(\) : ''/,
    '要读服务端算好的 activityLine');
  assert.match(src, /basis\.textContent = activityLine;/, '逐字放进去（不重新拼措辞）');
  assert.match(src, /class = 'say-basis'|className = 'say-basis'/, '与旧面板同一个 class 名');
  // ② role：popup 也放，且**只有一份 handler**（page 的静态按钮与 popup 的注入按钮同源）
  assert.match(src, /const ROLE_CHOICES = \[\['auto', '自动'\], \['companion', '陪练'\], \['strategist', '军师'\], \['teacher', '老师'\]\]/,
    'popup 的 4 个 role 与 page 同一份定义');
  assert.match(src, /if \(mode !== 'page'\) \{/, 'page 模式用静态标记，只有 popup 注入');
  assert.doesNotMatch(src, /if \(mode === 'page'\) \{\s*document\.querySelectorAll\('\[data-xy-role\]'\)/,
    '绑定不许再按模式分两份');
  const binds = src.match(/querySelectorAll\('\[data-xy-role\]'\)\.forEach\(\(button\) => \{/g) ?? [];
  assert.equal(binds.length, 1, `role 的绑定只能有一处（实测 ${binds.length}）`);
  // ③ `#model-chip`：甲④ 退役后由 xiaoya 这一块写（判据 live-model-status 的读取点）
  assert.match(src, /capEl\.id = 'model-chip'/, '能力状态那一块就叫 #model-chip（同名同语义，不是再加一个）');
  assert.match(src, /capEl\.href = 'connect\.html'/, '判据要"连接入口"，玩家也要点得动');
  assert.match(src, /capEl\.dataset\.rocoModel = model === 'ok' \? 'connected' : 'offline'/,
    '要写判据读的那个钩子，且**只按真实状态**写（不许为了绿写假的）');
  assert.match(src, /document\.body\.dataset\.rocoModelConfigured = model === 'ok' \? 'yes' : 'no'/);
  assert.doesNotMatch(src, /xy-capability'|xiaoya-capability'/, '不再有第二个能力状态元素（同一件东西一个名字）');
});

// ── U07（2026-09-30，task-01）：小芽唯一入口 + 稳定侧栏面板 ─────────────────────
//
// 这一组量的四件事都是用户截图里看得见的（07/08/09）：
//   ① **每页只有一套入口**：`roco.html` 页头已经有 `#coach-entry`，`xiaoya.js` 又往
//      `.header-actions` 追加了一个 `#xiaoya-open` ⇒ 右上角两个一模一样的「✦ 小芽」；
//   ② 版式：面板高度是死的、次级区全摊开 ⇒ 输入行被长回答挤出面板；
//   ③ 新消息：`addEntry()` 无条件 `log.scrollTop = log.scrollHeight` ⇒ 玩家往上翻历史时被顶回底部；
//   ④ 连通状态自相矛盾：标题「DeepSeek 已回答」+ 状态行「云端模型：状态未知」。

test('㉑ U07-① 每页只有一套入口：`entryButton:false` 不造 `#xiaoya-open`，把手走**真开关**', async () => {
  const src = read('src/client/xiaoya.js');
  // ① 开关只有一份：`injectPopup` 返回真 `setOpen`，把手调它（不再 `.click()` 一个可能不存在的按钮）
  assert.match(src, /export function mountXiaoya\(\{mode = 'popup', host = null, contextProvider = null, entryButton\} = \{\}\)/,
    '挂载选项要收 `entryButton`（不传 = 与改动前逐字一样）');
  assert.match(src, /const wantButton = entryButton !== false;/,
    '只有**明确传 false** 才不造入口（`undefined` 必须保持现状：box.html / workshop.html 不变）');
  assert.match(src, /if \(wantButton\) \{/, '按钮的创建要被它挡住');
  assert.match(src, /open: \(\) => \{ if \(panel && !panel\.isOpen\(\)\) panel\.setOpen\(true\); \}/,
    'handle.open() 走真开关（没有 FAB 时也真的开）');
  assert.match(src, /close: \(\) => \{ if \(panel && panel\.isOpen\(\)\) panel\.setOpen\(false\); \}/,
    'handle.close() 同理');
  // ⚠ 改钉不删：旧写法原文留档（FAB 不存在时 `?.click()` 是空转，把手返回了面板没动）。
  //    旧断言（当时钉的就是"复用真按钮的 handler"）：
  //      assert.match(src, /open: \(\) => \{ if \(!handle\.isOpen\(\)\) document\.getElementById\('xiaoya-open'\)\?\.click\(\); \}/);
  //    判据只认**代码行**，不认留档注释（同 ⑮ 那条口径）：先摘掉 `/* … */` 块注释，再丢掉整行 `//` 注释。
  const codeLines = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeLines, /document\.getElementById\('xiaoya-open'\)\?\.click\(\)/,
    '`?.click()` 那一套必须消失（`entryButton:false` 时它是空转）');
  assert.match(src, /旧写法原文留档[\s\S]{0,300}document\.getElementById\('xiaoya-open'\)\?\.click\(\)/,
    '改钉不删：旧写法原文留在注释里（日期 + 依据）');
  // ② 默认档不许变：`#xiaoya-open` / `#xiaoya-close` 仍然造（判据 regression-key-questions 在 box.html 上点它）
  assert.match(src, /button\.id = 'xiaoya-open';/, '默认档仍然有 #xiaoya-open');
  assert.match(src, /id="xiaoya-close"/, '面板自己的关闭按钮不许动');
  assert.match(src, /setOpen,/, '真开关要能被把手拿到');
  assert.match(src, /hasEntryButton: wantButton/, '有没有入口按钮要如实报出来（验收读它，不数 DOM 猜）');
  // ③ 真函数：把一个最小 DOM 装上，`entryButton:false` 时页面上不许出现那个 id，而 open() 必须真的开
  const {mountXiaoya} = await import('../src/client/xiaoya.js');
  const doc = fakeDom();
  const previous = {document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage, location: globalThis.location};
  Object.assign(globalThis, {document: doc, window: doc.defaultView, location: {search: '', href: 'http://x/'}});
  try {
    const handle = mountXiaoya({mode: 'popup', entryButton: false});
    assert.ok(handle, '要返回把手');
    assert.equal(doc.getElementById('xiaoya-open'), null, '`entryButton:false` ⇒ 页面上**不许**有第二个入口按钮');
    assert.equal(doc.getElementById('xiaoya-pop')?.hidden, true, '面板初始是收起的');
    assert.equal(handle.hasEntryButton(), false, '把手如实说"这一份没有入口按钮"');
    handle.open();
    assert.equal(handle.isOpen(), true, '没有 FAB 时 handle.open() 必须真的把面板打开（旧写法在这一步空转）');
    assert.equal(doc.getElementById('xiaoya-pop')?.hidden, false);
    handle.close();
    assert.equal(handle.isOpen(), false, 'handle.close() 同理');
    // ④ 反证：同一个把手在**默认档**下必须造按钮 —— 否则"唯一入口"就把 box.html 的入口也砍掉了
    doc.body.dataset.xiaoyaMounted = 'no';
    const boxHandle = mountXiaoya({mode: 'popup'});
    assert.ok(doc.getElementById('xiaoya-open'), '默认档（不传 entryButton）必须仍然造 #xiaoya-open');
    assert.equal(boxHandle.hasEntryButton(), true);
    boxHandle.open();
    assert.equal(boxHandle.isOpen(), true);
    // 挂载会顺手发起几件异步事（能力状态探针 / 模型三格）：等它们在这个假 DOM 上跑完再收工，
    // 否则它们在测试结束后才落到 `document.body` 上 —— 那是"测试尾巴上炸"，不是产品的问题。
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    Object.assign(globalThis, previous);
  }
});

//: 一份够 `mountXiaoya` 起步的最小 DOM（不是 jsdom：本仓的判据一律不引第三方依赖）。
function fakeDom() {
  class Node {
    constructor(tag = null) {
      this.tagName = String(tag ?? '').toUpperCase(); this.children = []; this.parentNode = null;
      this.dataset = {}; this.attributes = {}; this.style = {}; this.hidden = false;
      this.textContent = ''; this._html = '';
    }
    set className(value) { this._class = value; } get className() { return this._class ?? ''; }
    // ⚠ id 要**登记**：`injectPopup()` 是 `pop.id = 'xiaoya-pop'` 这样写的，
    //   而 `handle.isOpen()` 读 `document.getElementById('xiaoya-pop')` —— 不登记就永远量不到。
    set id(value) { this.attributes.id = String(value); byId.set(String(value), this); }
    get id() { return this.attributes.id ?? ''; }
    set innerHTML(value) { this._html = String(value); } get innerHTML() { return this._html; }
    set type(value) { this.attributes.type = value; } get type() { return this.attributes.type ?? ''; }
    append(...nodes) { for (const node of nodes) this.appendNode(node); }
    appendNode(node) {
      if (node == null) return node;
      if (typeof node === 'string') { this.textContent += node; return node; }
      node.parentNode?.remove?.(node);
      node.parentNode = this; this.children.push(node); return node;
    }
    insertBefore(node, ref) {
      const at = ref == null ? this.children.length : this.children.indexOf(ref);
      this.appendNode(node);
      const moved = this.children.pop();
      this.children.splice(at < 0 ? this.children.length : at, 0, moved);
      return moved;
    }
    replaceChildren() { for (const child of this.children) child.parentNode = null; this.children = []; }
    remove() { this.parentNode?.removeChild?.(this); }
    removeChild(node) { const at = this.children.indexOf(node); if (at >= 0) this.children.splice(at, 1); return node; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) {
      if (name === 'id') { byId.delete(String(this.attributes.id ?? '')); delete this.attributes.id; return; }
      delete this.attributes[name];
    }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener() {}
    removeEventListener() {}
    scrollIntoView() {}
    getContext() { return null; }
    focus() {}
    insertAdjacentHTML() {}
    get scrollTop() { return this._scrollTop ?? 0; } set scrollTop(value) { this._scrollTop = value; }
    get scrollHeight() { return 0; } get clientHeight() { return 0; }
    getBoundingClientRect() { return {top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0}; }
  }
  const byId = new Map();
  const doc = new Node('#document');
  //: `window` 也要够用（`mountXiaoya` 会在它上面挂 popstate/hashchange/自定义事件的监听）。
  doc.defaultView = {addEventListener() {}, removeEventListener() {}, location: {search: ''}, rocoDemo: null};
  doc.head = new Node('head'); doc.body = new Node('body');
  doc.documentElement = new Node('html');
  doc.getElementById = (id) => byId.get(id) ?? null;
  // 页面里那几个**静态** id（真实页面由 HTML 写好）；其余（面板 / 状态两行 / 收起区）由 `mountXiaoya` 自己造。
  for (const id of ['xiaoya-log', 'xiaoya-form', 'xiaoya-input', 'xiaoya-send', 'xiaoya-status', 'xiaoya-quick']) {
    const node = new Node('div'); node.id = id;
    // `#xiaoya-log` 要有父节点：状态那几块是 `log.parentNode.insertBefore(...)` 插进去的。
    if (id === 'xiaoya-log') doc.body.append(node);
  }
  doc.createElement = (tag) => new Node(tag);
  doc.addEventListener = () => {};
  return doc;
}

test('㉒ U07-④ 连通状态不自相矛盾：答完那一句自己的证据必须写进状态行', async () => {
  const {capabilityEvidenceOf, capabilityLines} = await import('../src/client/xiaoya.js');
  // ① 云端答过 ⇒ 证据说"模型此刻在"；这一行就**不许**再写"状态未知"（截图 08 的逐字矛盾）
  const deep = capabilityEvidenceOf({provider: 'deepseek', text: '嗯', toolTrace: [{tool: 'query_rules'}]},
    {roco_battle: {ruleset_config_id: 'mobile_s4_candidate_v3'}});
  assert.equal(deep.model, 'ok', '`provider:deepseek` 就是"云端模型此刻确实在"的证据');
  assert.equal(deep.tools, 'ok', '带了工具回执 ⇒ 本机规则服务刚刚真的跑过');
  assert.equal(deep.rulesetId, 'mobile_s4_candidate_v3', '这一局绑定的规则配置要从上下文里取出来（已知就要写出来）');
  const lines = capabilityLines({tools: deep.tools, model: deep.model, rulesetId: deep.rulesetId});
  assert.match(lines.modelLine, /云端模型：已连接/, '模型答过就必须写"已连接"');
  assert.doesNotMatch(lines.modelLine, /状态未知|未连接/, '同一屏里不许一边说模型答了、一边说不知道模型在不在');
  assert.match(lines.toolsLine, /资料查询：可用/, '工具刚跑过就必须写"可用"');
  assert.match(lines.toolsLine, /规则集 mobile_s4_candidate_v3/, '规则集已知要逐字写出来');
  // ② 规则服务**确实不在**时如实说不存在（不许含糊成"未知"）
  const down = capabilityEvidenceOf({provider: 'local', text: '这条要查服务端的资料，但这份资料现在用不了。',
    taskFailure: {missing: '本机规则服务（规则 / 图鉴 / 相性表）没连上'}});
  assert.equal(down.tools, 'down', '回答点名缺规则服务 ⇒ 状态行说"不可用"，不是"未知"');
  assert.match(capabilityLines({tools: 'down', missing: ['本机规则服务（规则 / 图鉴 / 相性表）没连上']}).toolsLine,
    /资料查询：不可用/);
  // ③ 没有证据时**一个字都不许改**（改钉不删：旧文案原文留档，探针说不清就是这两句）
  assert.deepEqual(capabilityEvidenceOf({provider: 'local', text: '嗯', evidence: [{k: 1}]}, null),
    {model: null, tools: null, rulesetId: null}, '只有 evidence、没有工具回执，不够格说"规则服务跑过"');
  const silent = capabilityLines({tools: 'unknown', model: 'unknown'});
  assert.equal(silent.toolsLine, '资料查询：还没拉起来（规则服务是第一次查询才启动的；问一句就会拉起它）');
  assert.equal(silent.modelLine, '云端模型：状态未知（只影响自由发挥的文字）');
  // ④ 探针说"没连"时仍然要**明说**（判据 live-model-status 的正则 `/未连接|没连|未连/` 不许破）
  assert.match(capabilityLines({tools: 'unknown', model: 'off'}).modelLine, /未连接/);
  // ⑤ 接线：答完那一刻先按证据同步重画，再去问探针（顺序反了就会留一帧自相矛盾）
  const src = read('src/client/xiaoya.js');
  assert.match(src, /const noteAnswerEvidence = \(answer, context = null\) => \{/);
  assert.match(src, /paintCapability\(probeInfo\);\s*\n\s*void refreshCapability\(true\);/,
    '先按证据重画（同步），再刷新探针（异步）');
  assert.match(src, /noteAnswerEvidence\(answer, context\);/, 'ask() 里要真的调它（函数对了不等于接上了）');
  // ⑥ 探针读不到时也不许把刚证实的真相改口（"这一句就是模型答的"不能说成"未连接"）
  assert.match(src, /const model = answerEvidence\.model === 'ok' \? 'ok' : 'unknown';/,
    '探针失败那一支要按回答证据说，不许一律写 offline');
});

test('㉓ U07-③ 新消息不许顶掉阅读位置：贴底才跟随，否则原地不动 + 提示', async () => {
  const {readingPositionOf} = await import('../src/client/xiaoya.js');
  // ① 纯函数：底部跟随 / 读历史不跟随 —— 两侧都钉住
  assert.equal(readingPositionOf({scrollTop: 700, scrollHeight: 1000, clientHeight: 300}).following, true,
    '贴底 ⇒ 跟随（新消息跟着走）');
  assert.equal(readingPositionOf({scrollTop: 0, scrollHeight: 1000, clientHeight: 300}).following, false,
    '往上翻了 700px ⇒ 不许跟随（位置要保持）');
  assert.equal(readingPositionOf({scrollTop: 0, scrollHeight: 300, clientHeight: 300}).following, true,
    '内容还没超出一屏 ⇒ 算贴底');
  assert.equal(readingPositionOf({scrollTop: 660, scrollHeight: 1000, clientHeight: 300}).following, true,
    '距底 40px（滚动条取整/半行的高度）仍然算贴底，不许因为一点点误差就不跟随');
  assert.equal(readingPositionOf({scrollTop: 640, scrollHeight: 1000, clientHeight: 300}).following, false,
    '距底 60px（超过阈值）就是"在读历史"，不许跟随');
  // ② 接线：`addEntry` 必须**先量位置再 append**，并且不许再无条件贴底
  const src = read('src/client/xiaoya.js');
  assert.match(src, /const \{following\} = readingPosition\(\);/, 'append 之前先量');
  assert.match(src, /if \(following\) log\.scrollTop = log\.scrollHeight;/,
    '只有"本来就在底部"才贴底');
  assert.match(src, /else \{ log\.scrollTop = keep; newMsg\.hidden = false; \}/,
    '读历史时写回原位置并给"有新消息"提示');
  // ⚠ 改钉不删：旧写法原文留档（无条件贴底 = 把阅读位置顶掉，用户截图那一屏就是这么丢的）。
  //    旧断言（当时钉的是"新消息一定要看得见"）：
  //      assert.match(src, /log\.append\(entry\);\s*\n\s*if \(log\) log\.scrollTop = log\.scrollHeight;/);
  assert.doesNotMatch(src, /log\.append\(entry\);\s*\n\s*if \(log\) log\.scrollTop = log\.scrollHeight;/,
    '无条件贴底那一句必须消失');
  assert.match(src, /id = 'xy-new-msg'/, '要有"↓ 有新消息"提示（不是静默不跟随）');
  assert.match(src, /if \(readingPosition\(\)\.following\) newMsg\.hidden = true;/,
    '玩家自己滚回底部 ⇒ 提示消失');
});

test('㉔ U07-② 版式：标题栏与输入行固定、对话区独立滚动、次级区默认收起', () => {
  const css = read('src/client/style.css');
  // ⚠ 判据只认**代码**，不认"改钉不删"的留档注释（同 ⑮ 那条口径：注释里当然有旧写法）。
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const src = read('src/client/xiaoya.js');
  // ① 对话区是**唯一**的滚动块：flex 收缩 + min-height:0 + 自己滚 + 不把滚动传给整页
  assert.match(cssCode, /\.xy-log\{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain/,
    '中间对话区独立滚动（min-height:0 是它能被压缩的前提；overscroll-behavior 挡住整页跟着滚）');
  // ⚠ 改钉不删：旧规则原文留档（`min-height:60px` 是地板，次级区展开时把输入行挤出面板）：
  //    .xy-log{flex:1;overflow-y:auto;margin:10px 0;min-height:60px}
  assert.doesNotMatch(cssCode, /\.xy-log\{flex:1;overflow-y:auto;margin:10px 0;min-height:60px\}/,
    '旧那条会顶出输入行的规则必须从代码里消失');
  // ② 输入行与快捷问不参与压缩（钉在面板底部）
  assert.match(cssCode, /\.xy-form\{display:flex;gap:7px;flex:0 0 auto\}/);
  assert.match(cssCode, /\.xy-quick\{[^}]*flex:0 0 auto\}/);
  // ③ 高度：给底部动作坞留位置（`--bottombar`），不再是一个"没算动作坞"的死高度
  assert.match(cssCode, /height:clamp\(320px,calc\(100dvh - 82px - var\(--bottombar,0px\)\),620px\)/,
    '面板高度要跟着视口与底部动作坞算 —— 不遮挡主要战斗动作');
  assert.doesNotMatch(cssCode, /height:min\(560px,calc\(100dvh - 82px\)\)/,
    '旧那个没给动作坞留位置的高度必须从代码里消失');
  assert.match(css, /旧规则留档[\s\S]{0,400}height:min\(560px,calc\(100dvh - 82px\)\)/,
    '改钉不删：旧高度原文留在注释里（日期 + 依据）');
  // ④ 二级区默认收起，且**同名 id 一个都不许丢**（判据 ⑲/⑳ 与 demo-acceptance 都按这些名字读）
  assert.match(src, /const more = document\.createElement\('details'\);/, '二级区是个 <details>');
  assert.match(src, /more\.id = 'xy-fold-more';/);
  assert.match(src, /moreBody\.append\(actions, memoryPanel, statusFold\);/,
    '动作 / 记忆 / 模型三格搬进收起区（id 不变）');
  assert.match(src, /moreBody\.append\(roles\);/, '身份那一排也在收起区');
  assert.doesNotMatch(src, /moreBody\.append\([^)]*capEl/, '`#model-chip` **不许**进收起区（判据要它一直可见、高度 ≥24）');
  assert.match(src, /meta\.append\(capEl, chip\);/, '两行状态常驻在 .xy-pop-meta');
  // ⑤ 单独页面（xiaoya.html）也是同一套三层：四行网格，对话那行才是 1fr
  assert.match(cssCode, /\.xy-page-body\{display:grid;grid-template-rows:auto auto minmax\(0,1fr\) auto;/,
    'page 模式：状态/收起区/对话(1fr，唯一滚动)/输入');
});


// ── U08（2026-09-30，task-04）：局中建议卡片 —— 面板只渲染 + 只广播 ──────────────
//
// 这一组钉的是"客户端那一半"的契约（Lead 在 `roco.js` 里绑的是同一条事件）：
//   ① 有 `rocoAdvice` 才画卡片，画在气泡里、默认收起，五行齐全（**风险永远有**）；
//   ② 没有 `rocoAdvice`（或只有一句空话）⇒ **不画**，也不许退化成「你自己定/说说你倾向哪边」；
//   ③ 按钮只做一件事：`document.dispatchEvent(new CustomEvent('roco:advice-adopt',
//      {detail:{advice, mode}}))` —— 面板不碰对局状态、不自己发 `/api/roco/*`、不执行动作；
//   ④ 上屏文字里不许有 `hint-budget` / `below-threshold` 这类内部 token（截图 09 就是被它脏的）。

/** U08 的一份**真实形状**夹具（逐字照 `src/coach/coach-advice.js` 的 `adviceForPosition()` 产出）。 */
const ADVICE = {
  headline: '换火神上场',
  reason: '对手是草系，它这一手大概率打你水系',
  upside: '换上去之后你扛草系 ×0.5',
  risk: '但对方可能换成电系，那一只没有抗性',
  alternates: [{label: '继续出招', note: '留着聚能，下回合爆发'}],
  unknown: ['对手这一回合的选择'],
  actionLabel: '换上第2位', actionKind: 'switch', legalActionId: 'switch#2:换上第2位', legalIndex: 2,
  action: {legalActionId: 'switch#2:换上第2位', legalIndex: 2, kind: 'switch', label: '换上第2位', display: '火神'},
  kind: 'switch-advantage',
};

test('㉕ U08：建议卡片的五段与两个按钮（风险永远在；只有 action 才画「采用建议」）', async () => {
  const {adviceCardOf, ADVICE_RISK_FALLBACK} = await import('../src/client/xiaoya.js');
  const card = adviceCardOf(ADVICE);
  assert.equal(card.headline, '换火神上场', '首选行动用服务端的 headline');
  assert.equal(card.reason, '对手是草系，它这一手大概率打你水系');
  assert.equal(card.upside, '换上去之后你扛草系 ×0.5');
  assert.equal(card.risk, '但对方可能换成电系，那一只没有抗性', '风险段必须原样带出来');
  assert.deepEqual(card.alternates, [{label: '继续出招', note: '留着聚能，下回合爆发'}]);
  assert.equal(card.action.legalActionId, 'switch#2:换上第2位', '可执行目标原样交给宿主（面板不解析、不执行）');
  // ① headline 缺席 ⇒ 退到 action.display（Lead 给的第二顺位），不是退成一句废话
  assert.equal(adviceCardOf({...ADVICE, headline: null}).headline, '火神');
  // ② **风险不许省**：服务端没写风险 ⇒ 画兜底话（不是空行、不是"未提供"）
  const noRisk = adviceCardOf({...ADVICE, risk: null});
  assert.equal(noRisk.risk, ADVICE_RISK_FALLBACK);
  assert.match(noRisk.risk, /没写.*不等于.*没风险/);
  // ③ 理由缺席就是空（如实说没有 —— 不许编一个理由），收益缺席同样不画这一行
  assert.equal(adviceCardOf({...ADVICE, reason: ''}).reason, '');
  assert.equal(adviceCardOf({...ADVICE, upside: undefined}).upside, '');
  // ④ 反证：没有建议 / 只有空壳 ⇒ **不画卡片**（U08 反证那一档）
  assert.equal(adviceCardOf(null), null);
  assert.equal(adviceCardOf('换上火神'), null);
  assert.equal(adviceCardOf({}), null, '空对象 ⇒ 不画（不许因为它没字段就编一张卡）');
  assert.equal(adviceCardOf({headline: '   ', action: null}), null);
});

test('㉖ U08：卡片真的画进气泡里（最小 DOM 上跑真函数）—— 默认收起 + 只广播，不执行', async () => {
  const src = read('src/client/xiaoya.js');
  // ① 接线：`addEntry` 里由**回答**带着 `rocoAdvice` 才画（历史轮次没有结构化建议，不画空壳）
  assert.match(src, /if \(answer\?\.rocoAdvice\) decorateAdvice\(entry, answer\.rocoAdvice, setStatus\);/,
    '卡片接线在 addEntry 里、只有服务端给了 rocoAdvice 才画');
  // ② 面板不许自己执行：不碰对局状态、不自己发 roco 接口、不调宿主行动
  //    （只切 `decorateAdvice` **这一个函数体** —— 别把后面 mountXiaoya 里的请求也切进来。）
  const adviceBlock = src.slice(src.indexOf('export function decorateAdvice'),
    src.indexOf('/**\n * 「正在看谁」那一行 + 两个动作按钮的样式。'));
  assert.ok(adviceBlock.includes('return fold;'), '切片要正好落在 decorateAdvice 函数体上');
  assert.doesNotMatch(adviceBlock, /fetch\(|playAction|rocoDemo|state\.view/, '建议卡片这一层不许执行/请求任何东西');
  assert.match(adviceBlock, /document\.dispatchEvent\(new CustomEvent\(ADVICE_EVENT, \{detail: \{advice, mode\}\}\)\);/,
    '唯一的动作 = 广播这一条事件（detail 形状与宿主约定逐字一致）');
  assert.match(src, /export const ADVICE_EVENT = 'roco:advice-adopt';/, '事件名与 Lead 绑定的一致');
  // ③ 真 DOM（最小实现）：画出来的卡片默认收起、五段齐全、两个按钮都在、点了只广播
  const doc = fakeDom();
  const previous = {document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage, location: globalThis.location};
  Object.assign(globalThis, {document: doc, window: doc.defaultView, location: {search: '', href: 'http://x/'}});
  try {
    const {decorateAdvice} = await import('../src/client/xiaoya.js');
    const bubble = doc.createElement('div');
    const notices = [];
    const fired = [];
    doc.dispatchEvent = (event) => { fired.push(event); return true; };
    const card = decorateAdvice(bubble, ADVICE, (text) => notices.push(text));
    assert.ok(card, '要画出一张卡');
    assert.equal(card.tagName, 'DETAILS');
    assert.equal(card.open, undefined, '默认**收起**（不是展开）');
    assert.equal(bubble.children.includes(card), true, '卡片在回答气泡**里面**');
    const rows = card.children.find((n) => n.className === 'xy-advice-body').children
      .filter((n) => n.className === 'xy-advice-row').map((n) => n.dataset.xyAdviceRow);
    assert.deepEqual(rows, ['reason', 'upside', 'risk', 'alternate'],
      '四行按名字画（理由/收益/风险/备选）；首选行动在 summary 上');
    assert.match(card.children[0].textContent, /首选行动：换火神上场/);
    const buttons = card.children.find((n) => n.className === 'xy-advice-body').children
      .filter((n) => n.className === 'xy-advice-actions')[0].children;
    assert.deepEqual(buttons.map((b) => b.id), ['xiaoya-advice-view', 'xiaoya-advice-adopt']);
    assert.deepEqual(buttons.map((b) => b.textContent), ['查看', '采用建议']);
    // ④ 「查看」= mode view；「采用」= mode adopt；两者都只是**广播**
    buttons[0].onclick();
    buttons[1].onclick();
    assert.deepEqual(fired.map((e) => [e.type, e.detail.mode, e.detail.advice.headline]),
      [['roco:advice-adopt', 'view', '换火神上场'], ['roco:advice-adopt', 'adopt', '换火神上场']]);
    assert.equal(notices.length, 2, '两次点击各回一句人话（"没有替你点" / "交给这一页"）');
    assert.match(notices[0], /没有.*替你点/);
    assert.match(notices[1], /交给这一页/);
    // ⑤ 只有 action 存在才画「采用建议」；没有 action ⇒ 只画「查看」，且 detail 里照样带原 advice
    const bubble2 = doc.createElement('div');
    const card2 = decorateAdvice(bubble2, {...ADVICE, action: null}, null);
    const buttons2 = card2.children.find((n) => n.className === 'xy-advice-body').children
      .filter((n) => n.className === 'xy-advice-actions')[0].children;
    assert.deepEqual(buttons2.map((b) => b.id), ['xiaoya-advice-view'], '没有可执行目标就不给「采用建议」');
    assert.equal(doc.getElementById('xiaoya-advice-adopt'), null, '旧卡上的 id 要摘掉（同名 id 只有一组）');
    // ⑥ 反证：把 rocoAdvice 拿掉 ⇒ 这一个函数什么都不画（不是画一张空卡）
    assert.equal(decorateAdvice(doc.createElement('div'), null), null);
    assert.equal(decorateAdvice(doc.createElement('div'), {headline: ''}), null);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('㉗ U08/U09：内部 token 不许上屏（hint-budget / below-threshold 那一类）', async () => {
  const {sanitizeAdviceText, adviceCardOf} = await import('../src/client/xiaoya.js');
  // 截图 09 的原话脏点：`依据 hint-budget` / `below-threshold`
  assert.equal(sanitizeAdviceText('依据 hint-budget'), '依据');
  assert.equal(sanitizeAdviceText('（below-threshold）'), '');
  assert.equal(sanitizeAdviceText('这一手值得留到局后看一看（hint-budget）'), '这一手值得留到局后看一看');
  assert.equal(sanitizeAdviceText('规则配置 pvp-standard-six-pet 里的天气声明'),
    '规则配置 里的天气声明');
  // 不许误伤：中文、数字、大写缩写、乘号都不动
  assert.equal(sanitizeAdviceText('扛草系 ×0.5，PVP 第 3 回合'), '扛草系 ×0.5，PVP 第 3 回合');
  assert.equal(sanitizeAdviceText('换上第2位（火神）'), '换上第2位（火神）');
  // 卡片里也一样干净（值走同一个清洗口）
  const card = adviceCardOf({headline: '换火神上场 below-threshold', reason: '对手是草系 hint-budget',
    risk: '对方可能换电系 below-threshold', action: {label: '换上第2位'}});
  assert.equal(card.headline, '换火神上场');
  assert.equal(card.reason, '对手是草系');
  assert.doesNotMatch(card.risk, /below-threshold|hint-budget/);
});
