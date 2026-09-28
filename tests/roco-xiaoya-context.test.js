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
  FOCUS_KEY, FOCUS_EVENT,
} from '../src/client/xiaoya.js';
import {focusAsk, focusFactAnswer, focusAdviceAnswer, focusIntent, focusDetailOf,
  localFactAsk, runCoach, buildContext} from '../src/coach/runtime.js';
import {
  emptyChatStore, appendChatTurn, readChatStore, serializeChatStore, activeChatSession,
  beginNewChatSession, clearActiveChatSession, CHAT_LIMITS,
} from '../src/coach/client.js';
import {cultivationOf} from '../src/coach/individuals.js';

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
