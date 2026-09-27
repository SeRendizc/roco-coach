/**
 * 判据：**本机的个体记录**（`src/client/box-individuals.js`）—— 盒子页"再养一只同种/刷新/回滚"的存档层。
 *
 * 为什么单独一份：这一层此前**一个单元判据都没有**（只有真机验收），而它正好是三轮里出过事的地方：
 *   · 2026-09-27 真机 29 号：`localIndividualsGrouped` 第一版返回 `Map`，而消费方
 *     `drawerHtml` 是按 `extras[group.species_id]` 取的 —— `map['pet_000012']` 是 `undefined`，
 *     被 `?? []` 兜住 ⇒ **一声不响什么都不画**（加了个体、状态行还说"在下面这一行里"）。
 *   · 同一天：`localOnly` 没往 `state.selected` 里带 ⇒ 比大小时请求照发，玩家看到一句
 *     服务端的参数报错，而不是"这只是本机新养的"。
 * 这两条都是"形状/传递"类的错，正是单元判据该管的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {individualsForRows, refreshIndividual, undoIndividual, addIndividualFor,
  localIndividualsOf, localIndividualById, localIndividualsGrouped, resetIndividualsForTest}
  from '../src/client/box-individuals.js';

/** 最小的 localStorage 假件（这一层只用到 getItem/setItem/removeItem）。 */
function withStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  resetIndividualsForTest();
  return {
    raw: () => JSON.parse(store.get('roco.box.individuals.v1') ?? '{}'),
    corrupt: (text) => store.set('roco.box.individuals.v1', text),
  };
}

const CARD = (select, group, name) => ({select, group, name, types: ['虫系'], level: 100, locked: false});
const ROWS = [CARD('own-0001', 'pet_000012', '铠甲虫'), CARD('own-0002', 'pet_000062', '音速犬')];

test('① 一页行 → 记录表：同一次调用里的记录会复用（刷新次数不会被页面重载重置）', () => {
  withStorage();
  const first = individualsForRows(ROWS);
  assert.deepEqual(Object.keys(first), ['own-0001', 'own-0002']);
  first['own-0001'] = refreshIndividual('talent', 'own-0001').individual;
  assert.equal(first['own-0001'].refreshes.talent, 2, '刷一次剩 2 次');
  const again = individualsForRows(ROWS);
  assert.equal(again['own-0001'].refreshes.talent, 2, '再来一页不许把次数重置回 3');
  // 反证：换一个个体的编号，次数必须是全新的 3（否则就是"全局一份"）
  const extra = individualsForRows([CARD('own-0002', 'pet_000062', '音速犬')]);
  assert.equal(extra['own-0002'].refreshes.talent, 3, '别的个体不受影响');
});

test('② 再养一只同种：编号往后排、最多 6 只、两只互不影响', () => {
  withStorage();
  individualsForRows(ROWS);
  const added = [];
  for (let i = 0; i < 5; i += 1) {
    const one = addIndividualFor(ROWS[0]);
    assert.equal(one.ok, true, `第 ${i + 2} 只应当能加出来：${one.reason ?? ''}`);
    added.push(one.individual_id);
  }
  assert.deepEqual(added, ['own-0001-b', 'own-0001-c', 'own-0001-d', 'own-0001-e', 'own-0001-f']);
  const sixth = addIndividualFor(ROWS[0]);
  assert.equal(sixth.ok, false, '第 7 只必须被拒（不泛滥）');
  assert.match(sixth.reason, /6 个个体/, `理由要说清：${sixth.reason}`);
  // 新个体：次数是全新的 3+3、天分归零并标注、性格记 null 并标注
  const fresh = localIndividualById('own-0001-b');
  assert.deepEqual(fresh.refreshes, {nature: 3, talent: 3});
  assert.equal(fresh.nature, null);
  assert.equal(fresh.nature_source, 'new-individual（新抓到的个体还没有性格数据 ⇒ 记 null）');
  assert.deepEqual(fresh.talent_boosts, []);
  assert.equal(localIndividualById('own-0001').refreshes.talent, 3, '原来那只不受影响');
});

test('③ **形状**：`localIndividualsGrouped` 必须回普通对象（`extras[key]` 取得到）—— Map 会静默不画', () => {
  withStorage();
  individualsForRows(ROWS);
  addIndividualFor(ROWS[0]);
  const extras = localIndividualsGrouped(['own-0001', 'own-0002']);
  assert.equal(extras instanceof Map, false, '不许回 Map（消费方是按 `extras[species_id]` 取的）');
  assert.equal(Object.getPrototypeOf(extras), Object.prototype, '要是一个普通对象');
  assert.ok(Array.isArray(extras['pet_000012']), `按种类取得到数组：${JSON.stringify(Object.keys(extras))}`);
  assert.deepEqual(extras['pet_000012'].map((one) => one.individual_id), ['own-0001-b'],
    '只留"服务端那一页没画的"');
  // 反证：Map 的取法在这份数据上必须取不到（把这句写下来，免得下一个人又改回 Map）
  const asMap = new Map(Object.entries(extras));
  assert.equal(asMap['pet_000012'], undefined, 'Map 用方括号取不到 —— 这就是当时"什么都不画"的原因');
  assert.equal(asMap.get('pet_000012').length, 1, 'Map 必须用 get()，形状不对就会静默失败');
});

test('④ 刷新/回滚：成不成都回一句人话，不抛给页面', () => {
  withStorage();
  individualsForRows(ROWS);
  assert.equal(refreshIndividual('talent', 'own-0001').ok, true);
  assert.equal(refreshIndividual('nature', 'own-0001').ok, true);
  assert.equal(undoIndividual('own-0001').ok, true, '刷过就能回滚');
  // 刚退过一步 ⇒ 再点回滚要给"只能退一步"这句话（人类 2026-09-27 口述）
  const afterUndo = undoIndividual('own-0001');
  assert.equal(afterUndo.ok, false, '刚退过一步不能马上再退');
  assert.match(afterUndo.reason, /只能退一步/, `理由要说清：${afterUndo.reason}`);
  // 再刷一次（还有余量）⇒ 又能退一步：这一条把"不是回一次"钉住
  assert.equal(refreshIndividual('talent', 'own-0001').ok, true);
  assert.equal(undoIndividual('own-0001').ok, true, '中间刷过 ⇒ 可以再退一步');
  // 没刷过的那一只：这句话是"没有可撤的"（与"已经用过"分开说）
  assert.equal(undoIndividual('own-0002').ok, false, '没刷过就回滚 ⇒ 也要有一句话');
  assert.match(undoIndividual('own-0002').reason, /还没有可以回滚的刷新/);
  assert.equal(refreshIndividual('talent', 'own-9999').ok, false, '不在本机记录里的个体不许瞎刷');
  assert.match(refreshIndividual('talent', 'own-9999').reason, /不在本地记录里/);
});

test('⑤ 存档坏掉/写不进去时有兜底：不抛、不把页面挂死', () => {
  const harness = withStorage();
  harness.corrupt('{这不是 JSON');
  const rows = individualsForRows(ROWS);
  assert.ok(rows['own-0001']?.individual_id === 'own-0001', '读坏了就当成空存档，重新造一份');
  // 写不进去（隐私模式）：不报错，只是这次不持久
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(refreshIndividual('talent', 'own-0001').ok, true, '写不进去也不许抛给页面');
});

test('⑥ 本机同种个体查询：`localIndividualsOf` 按编号排序、`fallback` 只在没有记录时用', () => {
  withStorage();
  individualsForRows(ROWS);
  addIndividualFor(ROWS[0]);
  assert.deepEqual(localIndividualsOf('pet_000012').map((one) => one.individual_id),
    ['own-0001', 'own-0001-b'], '同种的（含加出来的）按编号排序');
  assert.equal(localIndividualsOf('pet_999999').length, 0, '没有记录就是空数组');
  assert.equal(localIndividualsOf('pet_999999', {fallback: {individual_id: 'x'}}).length, 1,
    '给了 fallback 才回退');
  // 反证：本机记录与**服务端那一页**是两件事 —— 记录里没有的编号就是没有
  assert.equal(localIndividualById('own-0001-c'), null);
});

test('⑦ 页面真的把这份记录接上了（静态接线 + 形状一致）', () => {
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /localIndividualsGrouped\(state\.rows\.map\(\(row\) => row\.select\)\)/,
    'box.js 要按"服务端这一页画了哪些"算出 extras');
  assert.match(box, /drawerListHtml\(state\.rows, \{[^}]*extras\}/, 'extras 必须真的传给抽屉');
  // 验收钩子：`data-box-extras` 是"这一页交出去几个额外个体"（真机 29 号读的就是它）
  assert.match(box, /dataset\.boxExtras = String\(Object\.values\(extras\)/,
    '页面的自报钩子要与 extras 的形状一致（Object.values，不是 Map.values）');
});
