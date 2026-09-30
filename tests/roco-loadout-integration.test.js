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
  LOADOUT_STORE_KEY, LOADOUT_STORE_INDIVIDUAL_KEY, SPECIES_SCOPE_NOTE, SHARED_LOADOUT_SLOTS,
  isSharedLoadout, readIndividualLoadout, readSharedLoadout, readSharedLoadouts,
  resolveLoadout, teamLoadouts, writeIndividualLoadout, writeSharedLoadout,
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
  const individualKey = 'roco.workshop.loadouts.v2';
  assert.equal(LOADOUT_STORE_KEY, key);
  assert.equal(LOADOUT_STORE_INDIVIDUAL_KEY, individualKey,
    'S1 的个体级键也只有一处定义（`loadout-store.js`）');
  const offenders = [];
  for (const file of ['src/client/box-loadout.js', 'src/client/team-workshop.js',
    'src/client/roco.js', 'src/client/box.js', 'src/client/xiaoya.js']) {
    const src = read(file);
    // 只禁止**字面量**：import 常量是正确用法
    if (src.includes(`'${key}'`) || src.includes(`"${key}"`)) offenders.push(`${file}（v1）`);
    if (src.includes(`'${individualKey}'`) || src.includes(`"${individualKey}"`)) offenders.push(`${file}（v2）`);
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

// ── ④ S1（分计划 08 · 缺口 G01）：配招记录**按个体**，旧物种级记录只读兼容 ──────────
//
// 缺口原状：v1 的键是**物种**（`pet_…`）⇒ 同物种两只个体共用一份记录，A 配的招会出现在 B 身上。
// 08 的必做反例②就是「同物种不同个体不能相互覆盖配招」。处置（Lead 裁决 Q2）：
//   · 新键 v2（个体级 `own-…`）+ **兼容读取**旧 v1 键，**不删旧键**；
//   · 读到旧记录必须如实标注「物种级（未区分个体）」；
//   · 下一次编辑写个体级（单向迁移、幂等）；两条同时在 ⇒ **个体级优先**。
// 下面每条都带**两向变异**（把正确的做法改坏 ⇒ 必须红）。

test('④ S1：同物种两只个体**不共用**一份配招（个体级键是正主）', () => {
  const storage = fakeStorage();
  const a = ['skill_A1', 'skill_A2', 'skill_A3', 'skill_A4'];
  const b = ['skill_B1', 'skill_B2', 'skill_B3', 'skill_B4'];
  assert.equal(writeIndividualLoadout(storage, 'own-0001', a), true);
  assert.equal(writeIndividualLoadout(storage, 'own-0002', b), true);
  assert.deepEqual(readIndividualLoadout(storage, 'own-0001'), a);
  assert.deepEqual(readIndividualLoadout(storage, 'own-0002'), b,
    '同物种的第二只必须是它自己的四个 —— 这是 G01 的判据本体');
  // **两向变异①**：写成**物种级**（旧行为）⇒ 同种的另一只必然继承同一份
  const bad = fakeStorage();
  writeSharedLoadout(bad, 'pet_000004', a);
  assert.deepEqual(resolveLoadout(bad, {instanceId: 'own-0002', speciesId: 'pet_000004'}).ids, a,
    '物种级记录会被同种的另一只继承 —— 这就是产品不许再写旧键的理由');
});

test('④b S1：旧物种级记录**读得到、标注得出、不被改写**；个体级优先；兼容分支不是装饰', () => {
  const storage = fakeStorage();
  const legacy = ['skill_L1', 'skill_L2', 'skill_L3', 'skill_L4'];
  const own = ['skill_N1', 'skill_N2', 'skill_N3', 'skill_N4'];
  writeSharedLoadout(storage, 'pet_000004', legacy);        // 玩家**以前**配的（旧键，只读）
  const onlyLegacy = resolveLoadout(storage, {instanceId: 'own-0001', speciesId: 'pet_000004'});
  assert.equal(onlyLegacy.scope, 'species');
  assert.equal(onlyLegacy.note, SPECIES_SCOPE_NOTE,
    '读到旧记录必须**如实标注**「物种级（未区分个体）」，不许静默当成个体级');
  assert.deepEqual(onlyLegacy.ids, legacy);
  // 下一次编辑 ⇒ 写个体级新键（单向迁移）
  assert.equal(writeIndividualLoadout(storage, 'own-0001', own), true);
  const after = resolveLoadout(storage, {instanceId: 'own-0001', speciesId: 'pet_000004'});
  assert.equal(after.scope, 'individual');
  assert.equal(after.note, null, '个体级是自己的记录，不需要那句免责说明');
  assert.deepEqual(after.ids, own, '两条同时存在时**个体级优先**');
  assert.deepEqual(readSharedLoadout(storage, 'pet_000004'), legacy,
    '旧键**只读不删**：内容一个字都不许被这次编辑改掉');
  // **两向变异②**：把兼容读取关掉（只看个体级）⇒ 旧记录读不到。用它证明那条分支是**必需的**
  const fresh = fakeStorage();
  writeSharedLoadout(fresh, 'pet_000004', legacy);
  assert.equal(readIndividualLoadout(fresh, 'own-0001'), null,
    '（模拟"关掉兼容读取"的读数：个体级里什么都没有）');
  assert.deepEqual(resolveLoadout(fresh, {instanceId: 'own-0001', speciesId: 'pet_000004'}).ids, legacy,
    '开着兼容读取才读得到旧记录 —— 这一条不是装饰（关了它这里就红）');
});

test('④c S1：单向迁移**幂等**（同样的键集合写成同样的字节）+ 队级解析只带配过的', () => {
  const a = fakeStorage();
  const b = fakeStorage();
  const ids = ['skill_N1', 'skill_N2', 'skill_N3', 'skill_N4'];
  writeIndividualLoadout(a, 'own-0001', ids);
  const first = a.getItem(LOADOUT_STORE_INDIVIDUAL_KEY);
  writeIndividualLoadout(a, 'own-0001', ids.slice());       // 再写一次同样的内容
  assert.equal(a.getItem(LOADOUT_STORE_INDIVIDUAL_KEY), first, '同样内容重复写 ⇒ 字节相同（幂等）');
  // 键顺序不影响字节（先写 own-0002 再写 own-0001 与反过来结果一致）
  writeIndividualLoadout(b, 'own-0002', ids);
  writeIndividualLoadout(b, 'own-0001', ids);
  const c = fakeStorage();
  writeIndividualLoadout(c, 'own-0001', ids);
  writeIndividualLoadout(c, 'own-0002', ids);
  assert.equal(b.getItem(LOADOUT_STORE_INDIVIDUAL_KEY), c.getItem(LOADOUT_STORE_INDIVIDUAL_KEY),
    '落盘前按键排序 ⇒ 写入顺序不影响字节');
  // 队级解析：引擎要的仍是**物种键**（个体维度只活在本机记录这一层）
  const team = fakeStorage();
  writeIndividualLoadout(team, 'own-0001', ids);
  const out = teamLoadouts(team, [{instance: 'own-0001', species: 'pet_000004'},
    {instance: 'own-0007', species: 'pet_000271'}]);
  assert.deepEqual(out.loadouts, {pet_000004: ids}, '只有配过的那一只进 loadouts（没配的走引擎规范配招）');
  assert.equal(out.sources.pet_000004.scope, 'individual');
  assert.equal(out.sources.pet_000004.instance_id, 'own-0001');
  assert.deepEqual(out.conflicts, []);
  // **两向变异③**：把队级解析的输入换成"旧物种级" ⇒ 来源标注必须变成 species + 那句话
  const legacyTeam = fakeStorage();
  writeSharedLoadout(legacyTeam, 'pet_000004', ids);
  const legacyOut = teamLoadouts(legacyTeam, [{instance: 'own-0001', species: 'pet_000004'}]);
  assert.equal(legacyOut.sources.pet_000004.scope, 'species');
  assert.equal(legacyOut.sources.pet_000004.note, SPECIES_SCOPE_NOTE,
    '队级解析也要把来源如实带出来（界面靠它写那句话）');
});
