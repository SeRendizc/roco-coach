/**
 * **跨模块集成**：一份配招从盒子 → 工作台 → 战斗入口，**只有一个事实源**。
 *
 * 为什么要有这一份：本仓这一程里**同类事故反复出现**——
 *   · 盒子详情页的「性格与资质」读服务端回执、六维面板读本机记录 ⇒ **同一屏两套数**（A7）；
 *   · 旧行动坞按**名册冻结配招**画四格、b3 面板按**引擎实时配招**画 ⇒ **两套口径**（C 段刚修）；
 *   · 战斗期 `team-workshop.js` 的 WIP 漏了一个导入就直接把工坊**点炸**。
 * 三次的形状不同、根子一样：**同一个事实被写了两份**。这一份判据盯的就是这条缝。
 *
 * 链路（每一步都对着真实代码，不是设想）：
 *   ① `box-loadout.js` 换招 ⇒ `writeSharedLoadout()`（`loadout-store.js` 是**唯一**实现）；
 *   ② `team-workshop.js` 挂载时 `readSharedLoadouts()` 读同一把键 ⇒ `state.loadouts`；
 *   ③ `roco.js` 开局时把 `state.teamWorkshop.loadouts` 交给 `battleLoadouts()`（`coach/roco-experience.js:879`）
 *      按**这一局的队伍**过滤，再放进 `body.loadouts` 发 `/api/roco/battle/new`。
 *
 * ③ 那层过滤是最容易出错的一环：服务端会**拒**「配招提到了不在这一局里的精灵」，
 * 所以多带一只 = 整局开不了。**反证**就在这一条上。
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  LOADOUT_STORE_KEY, SHARED_LOADOUT_SLOTS, isSharedLoadout,
  readSharedLoadout, readSharedLoadouts, writeSharedLoadout,
} from '../src/client/loadout-store.js';
import {battleLoadouts} from '../src/coach/roco-experience.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 假的 storage：够真到能验"写进去、读出来"这条链，且不碰真 localStorage。 */
const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
};

// ── ① 唯一事实源（结构钉）────────────────────────────────────────────────────
test('① 配招的存储键**只在** loadout-store.js 里出现（别处再写一份就是第二个事实源）', () => {
  const key = 'roco.workshop.loadouts.v1';
  assert.equal(LOADOUT_STORE_KEY, key);
  const offenders = [];
  for (const file of ['src/client/box-loadout.js', 'src/client/team-workshop.js',
    'src/client/roco.js', 'src/client/box.js', 'src/client/xiaoya.js']) {
    const src = read(file);
    // 只禁止**字面量**：import 常量是正确用法
    if (src.includes(`'${key}'`) || src.includes(`"${key}"`)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `这些文件里又出现了配招键的字面量（应当 import 常量）：${offenders.join('、')}`);
  // 而且两个消费方都确实是从那一个模块 import 的
  assert.match(read('src/client/box-loadout.js'), /from '\.\/loadout-store\.js'/);
  assert.match(read('src/client/team-workshop.js'), /from '\.\/loadout-store\.js'/);
});

test('② 盒子怎么写、工作台就怎么读（同一条键、同一份形状，真跑一遍）', () => {
  const storage = fakeStorage();
  const picked = ['skill_000273', 'skill_000286', 'skill_000340', 'skill_000624'];
  assert.equal(writeSharedLoadout(storage, 'pet_000004', picked), true, '盒子那一侧要写成功');
  assert.deepEqual(readSharedLoadout(storage, 'pet_000004'), picked, '工作台那一侧要读到同一份');
  // `readSharedLoadouts` 是工作台挂载时用的那个（返回 Map）
  const all = readSharedLoadouts(storage);
  assert.deepEqual(all.get('pet_000004'), picked);
  assert.equal(SHARED_LOADOUT_SLOTS, 4, '四格这个数与引擎的 battle/new 口径绑在一起');
  assert.ok(isSharedLoadout(picked));
});

test('② 反证：形状不合法的配招**不许**被当成有效（否则会一路带到开局）', () => {
  for (const bad of [[], ['a'], ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'c'],
    ['a', 'b', 'c', ''], 'not-an-array', null]) {
    assert.equal(isSharedLoadout(bad), false, `这个形状必须判不合法：${JSON.stringify(bad)}`);
  }
  const storage = fakeStorage();
  assert.equal(writeSharedLoadout(storage, 'pet_000004', ['a', 'b', 'c']), false,
    '三个技能不许写进去');
  assert.equal(readSharedLoadout(storage, 'pet_000004'), null);
});

// ── ③ 到引擎的那一层过滤（最容易把整局弄开不了的地方）──────────────────────
test('③ battleLoadouts：**只带这一局里有的**那些物种（多带一只会让服务端拒整局）', () => {
  // ⚠ 契约是**普通对象**，不是 Map —— 我第一次喂了个 `Map`，`Object.entries(map)` 得到 `[]`
  //   ⇒ 函数返回 null、判据红。**判据红得对**：它逼我去查了这条缝，查出下面那次转换（见 ③b）。
  const chosen = {
    pet_000004: ['s1', 's2', 's3', 's4'],   // 在队里 ⇒ 要带
    pet_000271: ['t1', 't2', 't3', 't4'],   // 在队里 ⇒ 要带
    pet_000999: ['x1', 'x2', 'x3', 'x4'],   // **不在队里**（选过又换掉了）⇒ 必须丢
  };
  const teamSpecies = ['pet_000004', 'pet_000271', 'pet_000112'];
  const out = battleLoadouts({loadouts: chosen, teamSpecies});
  assert.ok(out, '有在队配招时应当给出对象');
  assert.deepEqual(Object.keys(out).sort(), ['pet_000004', 'pet_000271'],
    '只许带这一局队伍里有的物种');
  assert.deepEqual(out.pet_000004, ['s1', 's2', 's3', 's4']);
  assert.equal(Object.hasOwn(out, 'pet_000999'), false,
    '不在队里的配招必须丢掉 —— 带上它服务端会拒**整局**（玩家选过又换人是正常编辑过程）');
});

test('③b 工作台**内部是 Map**、对外 `emit()` 转成普通对象 —— 这次转换是集成缝，钉住它', () => {
  const src = read('src/client/team-workshop.js');
  // 内部确实是 Map
  assert.match(src, /loadouts = new Map\(readSharedLoadouts\(\)\)/,
    '工作台内部那份是 Map（`readSharedLoadouts()` 返回的就是 Map）');
  // 对外必须先转成普通对象，否则下游 `Object.entries()` 拿到空 ⇒ 配招**静默丢失**
  assert.match(src, /loadouts: Object\.fromEntries\(\[\.\.\.loadouts\.entries\(\)\]/,
    'emit() 必须把 Map 转成普通对象（`Object.fromEntries`）—— 少了这一步配招会静默丢');
  // 真跑一遍这次转换：Map → fromEntries → battleLoadouts，四技能必须原样活下来
  const asMap = new Map([['pet_000004', ['s1', 's2', 's3', 's4']]]);
  const asObject = Object.fromEntries([...asMap.entries()].map(([k, v]) => [k, v.slice()]));
  const out = battleLoadouts({loadouts: asObject, teamSpecies: ['pet_000004']});
  assert.deepEqual(out, {pet_000004: ['s1', 's2', 's3', 's4']}, '转换之后四技能要原样带着走');
  // 反证：**跳过**这次转换（直接喂 Map）⇒ 下游拿不到东西
  assert.equal(battleLoadouts({loadouts: asMap, teamSpecies: ['pet_000004']}), null,
    '直接喂 Map 会得到 null —— 这正是"少了转换就静默丢配招"的形状');
});

test('③ 结构钉：roco.js 开局时确实走这条链（工作台的 loadouts → battleLoadouts → body.loadouts）', () => {
  const src = read('src/client/roco.js');
  assert.match(src, /battleLoadouts\(\{/, 'roco.js 必须调 battleLoadouts 来组装');
  assert.match(src, /state\.teamWorkshop\?\.loadouts/, '来源必须是工作台那份（不是另取一处）');
  assert.match(src, /if \(loadouts\) body\.loadouts = loadouts;/, '组装结果要真的进开局请求体');
  // 反证：不许在这个位置又手写一份 loadout 过滤
  assert.doesNotMatch(src, /body\.loadouts = state\.teamWorkshop/,
    '不许绕过 battleLoadouts 直接把内存那份塞进请求体');
});
