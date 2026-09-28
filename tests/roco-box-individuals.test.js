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
import {individualsForRows, refreshIndividual, undoIndividual, addIndividualFor, removeIndividual,
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

test('② 再养一只同种：**同种至多一对**（本机最多加 1 只）、两只互不影响', () => {
  // ⚠ 2026-09-28 改钉（人类：「点一下再养一只莫名其妙出现然后又**多一只**还删不掉」）：
  // 原来每次点都再加一只（`-b`…`-f`，最多 6 只）⇒ 连点几下堆一排同名卡。
  // 人类对"同种多只"的口径是**一对**（2026-09-28 批准演示对时就是这么说的）⇒ 本机**至多加 1 只**。
  withStorage();
  individualsForRows(ROWS);
  const first = addIndividualFor(ROWS[0]);
  assert.equal(first.ok, true, `第一只应当能加出来：${first.reason ?? ''}`);
  assert.equal(first.individual_id, 'own-0001-b');
  const second = addIndividualFor(ROWS[0]);
  assert.equal(second.ok, false, '再点第二次必须被拒（同种最多一对）');
  assert.match(second.reason, /两只|一对/, `理由要说清：${second.reason}`);
  // 删掉之后可以再加（否则"拒了"就变成死路）
  assert.equal(removeIndividual('own-0001-b').ok, true, '本机那只应当能删掉');
  assert.equal(addIndividualFor(ROWS[0]).ok, true, '删掉之后应当又能加一只');
  // 新个体：次数是全新的 3+3；性格/天分**按新编号掷出来**（不再是空壳）
  const fresh = localIndividualById('own-0001-b');
  assert.deepEqual(fresh.refreshes, {nature: 3, talent: 3});
  assert.ok(typeof fresh.nature === 'string' && fresh.nature.length >= 2, `新个体要有性格：${fresh.nature}`);
  assert.match(String(fresh.nature_source), /rolled/, '来源要标成掷点');
  assert.ok(Object.values(fresh.talent).some((value) => value > 0), '新个体要有天分');
  assert.deepEqual(fresh.talent_boosts, []);
  assert.equal(localIndividualById('own-0001').refreshes.talent, 3, '原来那只不受影响');
  // 名单里的那只**删不掉**（它不在本机记录里，说"删掉了"就是骗人）
  assert.equal(removeIndividual('own-0001').ok, false, '名单里的个体不许被"删掉"');
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

/**
 * ⑲ 旧记录里天分为空 ⇒ **读的时候按编号补回来**。
 *
 * 人类 2026-09-28 指着截图：「天分为啥还是什么认不出？不是里面都能正常显示什么天分吗？
 * 就说 一般般的天分 不就好了？」
 *
 * 根因（查过，不是算不出来）：拿同一份数据从种子化掷点算，四档都出得来；
 * 是**浏览器里那些老记录**的天分是 `{value:null}` 那个年代的产物（`normalizeStored` 把它拆成 null），
 * 六项全 null ⇒ `talentTierOf` 只能判「缺项 ⇒ 认不出」。
 */
test('⑲ 旧记录里天分为空 ⇒ 读时按编号补回，并且写回磁盘（已有天分的绝不动）', () => {
  const storage = withStorage();
  // ① 全 null 的老记录
  storage.corrupt(JSON.stringify({'own-0001': {individual_id: 'own-0001', species_id: 'pet_000012',
    level: 100, nature: null, talent: {hp: null, atk: null, def: null, spa: null, spd: null, spe: null}}}));
  const rows = individualsForRows([{select: 'own-0001', group: 'pet_000012', name: '铠甲虫', level: 60}]);
  const one = rows['own-0001'];
  const activated = Object.values(one.talent).filter((v) => Number(v) > 0).length;
  assert.ok(activated >= 1 && activated <= 3,
    `补回来的天分要激活 1–3 条（四档口径就是这么定的）：${JSON.stringify(one.talent)}`);
  assert.equal(one.level, 60, '等级那条归一照旧生效（Lv.100 的老记录）');
  assert.ok(Object.values(storage.raw()['own-0001'].talent).some((v) => Number(v) > 0),
    '要**写回** localStorage（只修内存里那一份的话，下次读还是 null）');

  // ② 反证：**已经有天分的记录一个字都不许动**（不许把玩家的数据掷掉）
  const storage2 = withStorage();
  const mine = {hp: 3, atk: 0, def: 0, spa: 0, spd: 0, spe: 9};
  storage2.corrupt(JSON.stringify({'own-0002': {individual_id: 'own-0002', species_id: 'pet_000062',
    level: 60, nature: '稳重', talent: mine}}));
  const rows2 = individualsForRows([{select: 'own-0002', group: 'pet_000062', name: '音速犬', level: 60}]);
  assert.deepEqual(rows2['own-0002'].talent, mine, '已有天分必须原样保留（只有空的那种才补）');
});

/**
 * ⑳ **A7「刷新天分没效果」**：这一条量的是**培养快照 `cultivationOf` 里那几个数**。
 *
 * 人类 2026-09-29 逐字：「刷新天分没效果，刷新性格没试过但也要检查下」。
 * 上一轮为什么没抓到：验收 28 号量的是 `localStorage` 的计数与那行小字（见
 * `docs/roco/review-2026-09-28/README.md` §B4 表格第三行）—— **屏幕上的数字根本没进判据**。
 * 这一条把它反过来：判"玩家在那一栏里会读到的那串数字"（`formatTraitValue` 与二级页用的是
 * 同一个函数）随刷新而变、随回滚逐值还原。
 *
 * ⚠ 屏幕那一半（真机、真鼠标、真截图）在
 * `reports/roco/build-snapshot/browser-a7-refresh-proof.mjs`；
 * 这里钉的是**数据链路**，两边合起来才是一条完整的判据（纯函数绿 ≠ 屏幕上真的变了）。
 */
test('⑳ A7：培养快照随刷新当场变、随回滚逐值还原（且服务端那一份不变 ⇒ 它不能当真值）', async () => {
  const {cultivationOf, panelOfIndividual, rollNatureAndTalent, individualFromInstance} =
    await import('../src/coach/individuals.js');
  const {formatTraitValue} = await import('../src/client/box-drawer.js');
  withStorage();
  const card = {select: 'own-0001', group: 'pet_000001', name: '喵喵', level: 60};
  const initial = individualsForRows([card])['own-0001'];

  // ① 真值理由②：**没刷过的时候，服务端那份与本机那份逐值相等**（都走 `rollNatureAndTalent(instance_id)`）。
  //    服务端那条路就是 `roco-service.js` 的 `withIndividualGrowth` → `individualFromInstance(instance)`。
  const serverSide = individualFromInstance({instance_id: 'own-0001', species_id: 'pet_000001',
    species_name: '喵喵', level: 60, nature: {value: null}, talent: {value: null}});
  assert.deepEqual(serverSide.talent, rollNatureAndTalent('own-0001').talent, '服务端那份 = 种子化掷点');
  assert.deepEqual(cultivationOf(initial).talent, serverSide.talent,
    '没刷过时两份必须逐值相等（否则"换真值"会改变玩家的初始显示）');
  assert.equal(cultivationOf(initial).nature, serverSide.nature, '性格同理');

  // ② 反证 A7 的根因：刷新本机记录之后，**服务端那一份一个字都不变** ——
  //    所以"屏幕读服务端回执"= 刷新按钮对屏幕永远是假的（这就是上一轮那个 bug）。
  const afterRefresh = refreshIndividual('talent', 'own-0001');
  assert.equal(afterRefresh.ok, true, `刷一次天分应当成功：${afterRefresh.reason ?? ''}`);
  assert.deepEqual(serverSide.talent, rollNatureAndTalent('own-0001').talent,
    '服务端那份是按编号现算的纯函数 —— 刷新之后照样不变（这就是它不能当真值的理由①）');

  // ③ 屏幕上那一栏（资质 = 玩家读到的六个数）必须变：恰好一项 +10，其余不动。
  const before = cultivationOf(initial);
  const after = cultivationOf(afterRefresh.individual);
  assert.notDeepEqual(after.talent, before.talent, '刷新之后六项资质必须至少有一项变了');
  const moved = Object.keys(before.talent ?? {}).filter((k) => after.talent[k] !== before.talent[k]);
  assert.equal(moved.length, 1, `一次刷新只该动一项，实际动了 ${moved.length} 项：${moved.join('、')}`);
  assert.equal(after.talent[moved[0]] - before.talent[moved[0]], 10, '天分每级 +10（人类口径）');
  assert.notEqual(formatTraitValue(after.talent), formatTraitValue(before.talent),
    '`formatTraitValue` 印出来的那串字（二级页用的就是它）必须变 —— 这才是玩家看得见的东西');
  assert.match(formatTraitValue(before.talent), /^生命 \d+ \/ 物攻 \d+ \/ 物防 \d+ \/ 魔攻 \d+ \/ 魔防 \d+ \/ 速度 \d+$/,
    `资质那一栏的印法（真机截图里逐字就是这个形状）：${formatTraitValue(before.talent)}`);

  // ④ 同屏那份 60 级面板与资质**同一批数** ⇒ 资质变了，面板也必须变（至少一项）。
  const race = {hp: 65, atk: 66, def: 49, spa: 66, spd: 91, spe: 33};
  const panelBefore = panelOfIndividual({talent: before.talent, nature: before.nature}, race).panel;
  const panelAfter = panelOfIndividual({talent: after.talent, nature: after.nature}, race).panel;
  assert.notDeepEqual(panelAfter, panelBefore,
    `资质变了面板却没变 ⇒ 同屏两套数（真机截图 a7-before-2-*.png 拍到过这一处）`);
  assert.ok(Number(panelAfter[moved[0]]) > Number(panelBefore[moved[0]]),
    `${moved[0]} 的天分涨了 10，面板那一项必须跟着涨：${panelBefore[moved[0]]} → ${panelAfter[moved[0]]}`);

  // ⑤ 档位口径：**加成不算进档位**（档位说的是"抓到时是什么天分"）。
  //    不这么算的话，`rollTalentStat` 每次都落在一个当前是 0 的项上 ⇒ 加满三级会把激活条数
  //    顶到 4 条以上 ⇒ `talentTierOf` 只能返回"认不出"，档位这一栏就死了。
  assert.deepEqual(after.talentBase, before.talentBase, '档位那一份（扣掉加成）刷新后应当不动');
  assert.equal(after.tier?.label, before.tier?.label, '刷天分不该改档名（档名说的是抓到时那一份）');
  assert.ok(after.tier?.label, `档位要认得出来：${JSON.stringify(after.tier)}`);

  // ⑥ 回滚：屏幕（资质/性格/档位）必须**逐值**回到刷新前。
  const undone = undoIndividual('own-0001');
  assert.equal(undone.ok, true, `回滚应当成功：${undone.reason ?? ''}`);
  const back = cultivationOf(undone.individual);
  assert.deepEqual(back.talent, before.talent, '回滚之后六项资质必须逐值回到刷新前');
  assert.equal(back.nature, before.nature, '回滚之后性格必须回得去');
  assert.equal(formatTraitValue(back.talent), formatTraitValue(before.talent), '屏幕那一串字也要逐字回去');
  assert.deepEqual(panelOfIndividual({talent: back.talent, nature: back.nature}, race).panel, panelBefore,
    '回滚之后 60 级面板必须逐值回到刷新前');

  // ⑦ ⭐ 跨模块那一条（2026-09-29 Codex 监工）：**内容指纹**与**只增不减的刷新计数**。
  //    消费方（小芽的 focus provider）原来只看 `snapshotId`，而同一只刷过之后它不变
  //    ⇒ 会继续读旧的那一份。所以这两个字段必须真的会动，而且语义要说清：
  //      · 指纹：刷新会变、回滚会**变回去**（= "屏幕上的数字回到了刷新前"的机器可读版本）；
  //      · 计数：只增不减，回滚不动它（净效果为零的操作也认得出）。
  assert.notEqual(after.fingerprint, before.fingerprint, '刷新之后内容指纹必须变（否则消费方读旧的）');
  assert.equal(back.fingerprint, before.fingerprint, '回滚之后指纹必须逐字回到刷新前那一份');
  assert.notEqual(after.revision, before.revision, '刷新之后刷新计数必须往前走');
  assert.equal(back.revision, after.revision, '刷新计数只增不减：回滚不许把它退回去');
  // 反证：**同一批数值、不同的键顺序**必须给出同一个指纹（"稳定序列化"这条不是空话）
  const shuffled = {individual_id: 'own-0001', nature: before.nature,
    talent: Object.fromEntries(Object.entries(before.talent).reverse())};
  assert.equal(cultivationOf(shuffled).fingerprint, before.fingerprint,
    '键顺序不同但数值相同 ⇒ 指纹必须一样（否则每次读都"变了"，消费方会永远重拉）');
  // 反证：数值真变了就一定要变（不然这条判据是空的）
  assert.notEqual(cultivationOf({...shuffled, talent: {...shuffled.talent, hp: 99}}).fingerprint,
    before.fingerprint, '一项数值变了指纹必须变');
});

/**
 * ㉑ 培养快照的**形状**：缺字段/坏记录不抛，且性格/档位跟着**现值**走（不是抓到时那一份）。
 *
 * 为什么要单钉：`cultivationOf` 是"一处真值"的唯一投影 —— 它一抛，二级页整屏白；
 * 它拿错性格，档位那一栏就会与屏幕上的性格对不上（同一屏两套数又回来了）。
 */
test('㉑ 培养快照：缺字段不抛；性格与档位跟着**现值**走（不是抓到时那一份）', async () => {
  const {cultivationOf} = await import('../src/coach/individuals.js');
  const {natureOf} = await import('../src/coach/talent.js');
  // ① 空壳/半截记录一律不抛（老库里有的是这种）
  for (const bad of [null, undefined, {}, {talent: null}, {talent: {}}, {talent: {hp: 3}}]) {
    const snap = cultivationOf(bad);
    assert.equal(typeof snap, 'object', `喂 ${JSON.stringify(bad)} 也要回一个对象，不许抛`);
    assert.ok(snap.talent === null || typeof snap.talent === 'object');
  }
  // ② 性格刷新之后：档位里的 `nature_up` 必须等于**当前**性格的长处项
  withStorage();
  const card = {select: 'own-0001', group: 'pet_000001', name: '喵喵', level: 60};
  individualsForRows([card]);
  refreshIndividual('nature', 'own-0001');
  const one = localIndividualById('own-0001');
  const snap = cultivationOf(one);
  assert.equal(snap.nature, one.nature, '快照里的性格就是记录里那一个（现值）');
  assert.equal(natureOf(snap.nature)?.name, snap.nature, `掷出来的性格必须是 30 条里的一条：${snap.nature}`);
  if (snap.tier?.nature_up) {
    assert.equal(snap.tier.nature_up, natureOf(snap.nature).up,
      '档位里的性格长处要跟着**现值**走（否则同屏两套数）');
  }
  // ③ 剩余次数与账一起带出来（页面按钮上那个「还剩 N 次」读的就是它）
  assert.equal(snap.remaining.nature, 2, `刷过一次性格之后剩 2 次，实际 ${JSON.stringify(snap.remaining)}`);
});

