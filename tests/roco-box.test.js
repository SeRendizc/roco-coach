// RC-205 精灵盒子（我的 / 全图鉴）的路由与玩家层守卫。
//
// 这一份钉四件事，每条都有**必红方向**（构造一个违规样本，看同一条判据会不会翻红）：
//
//   ① **路由契约与参数白名单**：`GET /api/roco/box` 的四种模式（catalog / mine / detail /
//      compare）与错误码；白名单外的键、格式不对的数字一律 `ok:false` + 400，
//      **不静默取整、不静默忽略**。
//   ② **全量是 622，不是 48**：`kind=catalog` 的 total 必须等于 pack 里的 pet 实体数；
//      48 只能是「迁移层配过招的条数」，它单独成一个覆盖数字，不许冒充全量。
//   ③ **我的盒子是 80**：`kind=mine` 的 total 必须等于 owned-pets.json 的实例数，
//      分页加起来也是 80，收藏 / 锁定 / 物种筛选的数字与数据文件一致。
//   ④ **玩家层与工程层的分界**：路由的 `player` 段里不许出现工程键；
//      页面源码里的工程词只许出现在渲染开发者抽屉的那一个函数里。
//
// 判据**只有一份**：`scripts/roco/browser-box-acceptance.mjs` 导出四个判据函数，
// 浏览器验收与这份单测跑的是同一份代码。两份各写一遍就一定会各自漂移。
//
// 用法：`node --test tests/roco-box.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer, publicAssets, browserModules} from '../src/server/index.js';
import {compareOwnedPets} from '../scripts/roco/owned-pets-lib.mjs';
import {
  playerLayerProblems,
  catalogTotalProblems,
  compareMismatchProblems,
  limitProblems,
  FORBIDDEN_PLAYER,
} from '../scripts/roco/browser-box-acceptance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const log = (...args) => console.log('  ·', ...args);
/** 报告里要贴**实际输出原文**，所以断言失败时把服务端原话带上。 */
const show = (value, limit = 220) => JSON.stringify(value).slice(0, limit);

// ── 真服务：不 mock（路由行为、状态码与白名单都是被验的对象）────────────────
const server = createCoachServer({semantic: false, roco: undefined,
  fetchImpl: async () => { throw Error('测试环境不允许联网'); }});
await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const BASE = `http://127.0.0.1:${server.address().port}/`;
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** 打一次盒子路由，回 {status, json, raw}；`raw` 是响应原文（报告里要贴）。 */
async function box(query) {
  const response = await fetch(`${BASE}api/roco/box?${query}`);
  const raw = await response.text();
  return {status: response.status, raw, json: JSON.parse(raw)};
}

// 把 data/roco/owned/owned-pets.json 读成判据的期望值：**不硬编码 24/8**，
// 数字变了要么数据变、要么路由错，两种都该红。
const OWNED = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
const PACK = JSON.parse(readFileSync(join(ROOT, 'data/roco/game-data-pack/v2/pack.json'), 'utf8'));
const PACK_PETS = PACK.sections.distributable.entities.filter((e) => e.group === 'pet');

// ─────────────────────────────────────────────────────────────────────────
// 0. 接线：页面与静态资源真的被服务端给出（结构契约那一半的运行时对照）
// ─────────────────────────────────────────────────────────────────────────

test('接线：/box.html 与它的三个文件都在白名单里，而且真的取得到', async () => {
  for (const rel of ['src/client/box.html', 'src/client/box.js', 'src/client/box.css']) {
    assert.ok(publicAssets.has(rel), `${rel} 不在 publicAssets 白名单里`);
  }
  // 模块图只跟 JS 与 HTML 的 `<script type="module">` 走：CSS 是被 `<link>` 引的，
  // 它由上面那条白名单判据守（写进图里反而是把「图」的定义搞乱）。
  for (const rel of ['src/client/box.html', 'src/client/box.js']) {
    assert.ok(browserModules().has(rel), `${rel} 不在浏览器模块图里（页面会白屏）`);
  }
  for (const [url, expect] of [['box.html', 'text/html'], ['src/client/box.js', 'javascript'],
    ['src/client/box.css', 'text/css']]) {
    const response = await fetch(BASE + url);
    const text = await response.text();
    log('[实际]', url, '→ HTTP', response.status, response.headers.get('content-type'));
    assert.equal(response.status, 200, `/${url} 应当 200，实际 ${response.status}`);
    assert.ok(response.headers.get('content-type').includes(expect), `/${url} 的 Content-Type 不对`);
    assert.ok(text.length > 100, `/${url} 内容太短，可能不是真文件`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 路由契约：四种模式
// ─────────────────────────────────────────────────────────────────────────

test('路由契约：kind=catalog 是**全量 622**，不是 48 只迁移层', async () => {
  const {status, json} = await box('kind=catalog&limit=24&offset=0');
  log('[实际] catalog total =', json.player.total, '；这一页 =', json.player.count,
    '；覆盖 =', show(json.dev.coverage));
  assert.equal(status, 200, `catalog 应当 200，实际 ${status}`);
  assert.equal(json.ok, true);
  assert.equal(json.mode, 'catalog');
  assert.equal(json.player.kind, 'catalog');
  assert.equal(json.player.total, PACK_PETS.length, `catalog 总数必须是 pack 的 pet 实体数（${PACK_PETS.length}）`);
  assert.equal(json.player.total, 622, `全图鉴必须是 622 条，实际 ${json.player.total}`);
  assert.equal(json.player.count, 24, '默认每页 24 条');
  assert.equal(json.player.cards.length, 24);
  // ⚠ 2026-09-28 改钉（人类 2026-09-28 逐字：「所有精灵实装，这样就不需要我的精灵了，直接全筛选」）：
  // 旧断言是 `assert.equal(json.dev.coverage.with_moveset_layer, 48, '48 只能是「迁移层配过招的条数」，它不该等于全量')`。
  // 可玩层现在是 **542 只**（基线 12 + 抓包层 530），而这一栏原来**只从 `roster-48.json` 建**
  // ⇒ 盒子里只有 48 只能读出「定位」，另外 494 只一律显示「定位未登记」，而层里那 530 条的
  // `role` **全都有值**（实测 530/530）。换源之后这一栏就是 542。
  // 判据的**意图一个字没变**：这一栏是「配过招的条数」，**不许冒充全量**。
  assert.equal(json.dev.coverage.with_moveset_layer, 542,
    `配过招的条数 = 可玩层 542（实际 ${json.dev.coverage.with_moveset_layer}）`);
  assert.notEqual(json.dev.coverage.with_moveset_layer, json.player.total,
    '配过招的条数不许冒充全量（旧口径钉的是"不该等于全量"，这一句把意图直接写出来）');
  assert.equal(json.dev.coverage.pet_record + json.dev.coverage.pet_form, 622,
    '精灵 460 + 形态 162 应当正好是 622');
  // 卡片首层只有玩家该看到的那几样（`mechanism` 是 2026-09-22 人类 P0 之后加的**加性**键：
  // 卡片首层的「机制」必须是可核对原文，不是前端模板句；它只带 line/status/name/tags，
  // 出处原文与 unverified[] 留在详情层）。
  const card = json.player.cards[0];
  // ⚠ 2026-09-28 改钉（人类逐字：「突然想到，我抓包出来的地方是不是有精灵立绘？你把迪莫的实装一下我看看」）：
  // 卡片首层新增一个 **`art`**（这只精灵有没有**抓包来的官方立绘**；页面据此决定画 `<img>` 还是画系别 emoji）。
  // 判据的意图一字未变：**卡片首层只放玩家该看到的那几样**，多一个键就要在这里显式登记。
  // 旧键表留档：['alias','form_label','has_metrics','has_moveset','mechanism','name','role_label','select','support_label','types']
  // ⚠ 2026-09-29 再改钉（人类报的 A3：「pvp选精灵看不到等级？」；改的是 `src/server/roco-service.js`
  // 的 `boxCatalogCard`）：**「全图鉴」那一档的候选行也要有等级** —— 目录卡原来**根本没有 `level`**，
  // 于是全图鉴里每一行都是 `Lv—`（连玩家**已经拥有**的那些也是），而 `kind=mine` 的卡一直有
  // `level`（60）⇒ 同一只精灵在两个页签里等级一有一无。现在：这一物种在盒子里有实例时带那只的等级，
  // 没有就 `null`（页面照实说，不编）。键表加一个 `level`，**意图不变**（多一个键照样要显式登记）。
  assert.deepEqual(Object.keys(card).sort(),
    ['alias', 'art', 'form_label', 'has_metrics', 'has_moveset', 'level', 'mechanism', 'name',
      'role_label', 'select', 'support_label', 'types'].sort(),
    `卡片首层的键变了：${show(Object.keys(card))}`);
  // ⚠ 2026-09-29 新增（与上面那条同源）：`level` 只许是**真数字或 null**，
  // 不许用字符串/`'Lv—'`/0 顶替（那正是 A3 里"带了一个等级读数"却是假象的老毛病）。
  assert.ok(card.level === null || typeof card.level === 'number',
    `卡上的 level 只能是数字或 null（没有就说没有），实际 ${show(card.level)}`);
  assert.equal(typeof card.art, 'boolean', '`art` 必须是布尔（页面只认 true 才画图，不许给字符串当判据）');
  assert.deepEqual(Object.keys(card.mechanism).sort(), ['line', 'name', 'status', 'tags'].sort(),
    `机制字段只允许这四个玩家键：${show(Object.keys(card.mechanism))}`);
  assert.equal(card.mechanism.status, 'FROZEN_DESC', '全图鉴 622 只都该解析到冻结 desc');
  assert.ok(card.mechanism.line.length <= 60 && card.mechanism.line.includes('「'),
    `机制行该是「特性「X」：…」的样子，实际 ${show(card.mechanism.line)}`);
});

test('路由契约：kind=mine 的条数 = owned-pets.json 的实例数（一人一只 = 48），分页加起来也一致', async () => {
  const {status, json} = await box('kind=mine&limit=24&offset=0');
  assert.equal(status, 200);
  assert.equal(json.mode, 'mine');
  assert.equal(json.player.total, OWNED.instances.length, 'mine 总数必须等于 owned-pets.json 的实例数');
  // 2026-09-24（人类纠正）：「重复的删掉」⇒ 不许再出现 80 那批灌水个体。
  // ⚠ 2026-09-28 改钉：人类批准**一对**同种个体（`own-0049`，见 `data/roco/human-decisions.json`）
  // ⇒ 实例数 = 物种数 + **至多 1**，而且多出来的那只**必须**标着 `synthetic_demo: true`。
  const instanceSpecies = new Set(OWNED.instances.map((i) => i.species_id));
  const demos = OWNED.instances.filter((i) => i.synthetic_demo === true);
  assert.equal(OWNED.instances.length, instanceSpecies.size + demos.length,
    `实例数 ${OWNED.instances.length} 应当等于物种数 ${instanceSpecies.size} + 显式标注的演示个体 ${demos.length}`);
  assert.ok(demos.length <= 1, `演示个体至多 1 只（实际 ${demos.length}）—— 人类只批了一对`);
  assert.equal(json.player.total, OWNED.instances.length,
    `我的盒子应当是 ${OWNED.instances.length} 个个体，实际 ${json.player.total}`);
  // 逐页取回来，条数之和必须等于总数（分页不是装饰）
  // 2026-09-28 改钉（**旧值不删**：循环上界原来是写死的 `offset < 200`，当时实例只有 48 只）。
  // 甲案（盒子 = 可玩层镜像）⇒ 542 个实例，写死 200 只能取到前 216 个 ⇒ 判据假红。
  // 现在按**数据文件自己的条数**走完：判据没放宽（分页之和必须等于实例数，一页都不许漏）。
  let seen = 0;
  for (let offset = 0; offset < OWNED.instances.length; offset += 24) {
    const page = await box(`kind=mine&limit=24&offset=${offset}`);
    seen += page.json.player.count;
  }
  log('[实际] 我的盒子分页合计 =', seen, '；数据文件 =', OWNED.instances.length);
  assert.equal(seen, OWNED.instances.length, `分页合计应当是 ${OWNED.instances.length}，实际 ${seen}`);
  // 过滤数字与数据文件对齐
  const fav = await box('kind=mine&favourite=true');
  const locked = await box('kind=mine&locked=true');
  const species = await box('kind=mine&species_id=pet_000012');
  const expectFav = OWNED.instances.filter((i) => i.favourite === true).length;
  const expectLocked = OWNED.instances.filter((i) => i.locked === true).length;
  const expectSpecies = OWNED.instances.filter((i) => i.species_id === 'pet_000012').length;
  log('[实际] 收藏 =', fav.json.player.total, '（数据文件', expectFav, '）；锁定 =', locked.json.player.total,
    '（', expectLocked, '）；pet_000012 =', species.json.player.total, '（', expectSpecies, '）');
  assert.equal(fav.json.player.total, expectFav);
  assert.equal(locked.json.player.total, expectLocked);
  assert.equal(species.json.player.total, expectSpecies);
  assert.ok(fav.json.player.cards.every((c) => c.favourite === true), '收藏筛选必须每张卡都标着收藏');
});

test('路由契约：detail 有面板/配招就给，没有就如实说没有（不许编）', async () => {
  // 迁移层 48 只之一：音速犬，四个技能与种族值都该在
  const rich = await box('detail=pet_000062');
  assert.equal(rich.status, 200, `detail 应当 200，实际 ${rich.status}：${show(rich.json)}`);
  assert.equal(rich.json.player.metrics.length, 6, '六维应当齐');
  assert.equal(rich.json.player.moveset.length, 4, '配招应当是四个技能');
  assert.equal(new Set(rich.json.player.moveset.map((m) => m.name)).size, 4, '四个技能应当是四个不同的技能');
  assert.ok(rich.json.player.metrics_missing_reason === null, '有数值时不该同时说「没有这一项」');
  log('[实际] pet_000062 =', rich.json.player.name, rich.json.player.metrics_label,
    '；四招 =', rich.json.player.moveset.map((m) => `${m.slot_label}:${m.name}(威力${m.power_label})`).join(' '));

  // ⚠ 2026-09-28 改钉：样例原来用 `pet_000001`（喵喵）当「不在迁移层里」的那一只 ——
  // 它现在**在可玩层里**（层从 48 扩到 542），所以它有六维也有配招，这条判据就不再成立。
  // 换成 `pet_000139`（古啦多）：它在 622 图鉴里、但**不在可玩层 542 只里**
  // （按需推算档 80 只之一），所以它才是真正「没有登记」的那一档。
  // 判据的意图一个字没变：**没有登记时就如实说没有，不许编、不许补 0**。
  // 旧写法留档：const plain = await box('detail=pet_000001');
  const plain = await box('detail=pet_000139');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.player.metrics, null, '没有迁移层登记时不许给数值');
  assert.equal(plain.json.player.moveset, null, '没有配招时不许编一个');
  // 改钉（2026-09-26）：这句由「本仓库没有这一项」改成「游戏数据里没有这一项」——
  // 人类点名"面板不是人话"，凡是**玩家可见**的文案都不许对着仓库说话。意图没变：如实说没有，不补 0。
  // 这句现在是「这只精灵不在有配招与数值的那批数据里，所以这一项没有（…）」——
  // 人话化之后不再有统一的「…没有这一项」前缀，所以判据改成**语义**：必须说清"没有"这件事。
  assert.match(plain.json.player.metrics_missing_reason, /没有/,
    `必须如实说没有：${show(plain.json.player.metrics_missing_reason)}`);
  assert.doesNotMatch(plain.json.player.metrics_missing_reason, /本仓库/,
    '玩家可见文案里不许对着仓库说话');
  log('[实际] pet_000001 =', plain.json.player.name, '；', plain.json.player.metrics_missing_reason);

  // 个体详情：等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能
  const instance = await box('detail=own-0001');
  assert.equal(instance.status, 200);
  assert.equal(instance.json.player.entity, 'instance');
  assert.equal(instance.json.player.traits.length, 5, '四项个体属性 + 天分档位（人类 2026-09-28 ⑤）一栏都不能少');
  assert.deepEqual(instance.json.player.traits.map((t) => t.label), ['性格', '资质', '特长', '血脉', '天分档位']);
  // ⚠ 2026-09-28（人类 ⑤）：档位名必须是**他那四个名字之一**，而且是**当场算的**（不是写死的）。
  // 读不出来时这一栏如实 unknown + 原因 —— 不许硬套一个档名。
  const tierTrait = instance.json.player.traits.find((t) => t.label === '天分档位');
  assert.ok(['一般般的天分', '还不错的天分', '相当好的天分', '了不起的天分'].includes(tierTrait.value),
    `天分档位只能是他那四个名字：${show(tierTrait)}`);
  assert.equal(tierTrait.status, 'known');
  // 反证：资质那一栏是**六维对象**（页面靠它印数值）—— 不是 null、也不是一句话
  const talentTrait = instance.json.player.traits.find((t) => t.label === '资质');
  assert.equal(typeof talentTrait.value, 'object', `资质要给六维表：${show(talentTrait)}`);
  assert.ok(Object.values(talentTrait.value).some((v) => Number(v) > 0), '资质至少有一条被激活');
  assert.equal(instance.json.player.skills.length, 4, '四个技能是有序的四个');
  assert.deepEqual(instance.json.player.skills.map((s) => s.order), [1, 2, 3, 4], '技能顺序必须写出来');
  assert.equal(instance.json.player.panel.available, false, '面板数值在本仓库不可得');
  // 改钉（2026-09-26）：这句由「本仓库没有这一项」改成「这个数值游戏数据里没有——换算公式还没校准…」。
  // 意图没变：面板数值不可得时必须**说清为什么**，不许补一个伪精确的数。
  assert.match(instance.json.player.panel.reason, /游戏数据里没有|没有/, show(instance.json.player.panel.reason));
  assert.doesNotMatch(instance.json.player.panel.reason, /本仓库/, '玩家可见文案里不许对着仓库说话');
  const unknown = instance.json.player.traits.filter((t) => t.status === 'unknown');
  assert.ok(unknown.every((t) => t.effect_label.includes('效果未校准')),
    '没取值的栏目必须带上「效果未校准」的说明，而不是留白');
  log('[实际] own-0001 =', instance.json.player.name, 'Lv' + instance.json.player.level,
    '；个体属性 =', instance.json.player.traits.map((t) => `${t.label}:${t.value ?? '（没有这一项）'}`).join(' '),
    '；四个技能 =', instance.json.player.skills.map((s) => s.name).join('→'));

  // id 形状与「找不到」两件事分开：形状不对 400，形状对但没有 404
  const bad = await box('detail=不是id');
  assert.equal(bad.status, 400, `形状不对的 detail 应当 400，实际 ${bad.status}`);
  const missing = await box('detail=pet_999999');
  assert.equal(missing.status, 404, `找不到的 id 应当 404，实际 ${missing.status}：${show(missing.json)}`);
  const missingInstance = await box('detail=own-9999');
  assert.equal(missingInstance.status, 404);
});

test('路由契约：产物里没有同种两只 → compare 一律拒绝（同种比较的成功路径由纯函数夹具覆盖）', async () => {
  const groups = new Map();
  for (const instance of OWNED.instances) {
    groups.set(instance.species_id, [...(groups.get(instance.species_id) ?? []), instance.instance_id]);
  }
  const pairs = [...groups.entries()].filter(([, list]) => list.length >= 2);
  // ⚠ 2026-09-28 改钉：人类批准的那一对在里面（`synthetic_demo`）——所以"一对都不许有"改成
  // 「**至多一组**，且那一组的第二只必须是显式标注的演示个体」（灌水个体仍然不许）。
  assert.ok(pairs.length <= 1, `同种成对的组至多 1 组（实际 ${pairs.length}）`);
  for (const [, ids] of pairs) {
    const extras = ids.filter((id) => OWNED.instances.find((i) => i.instance_id === id)?.synthetic_demo === true);
    assert.equal(extras.length, 1, `那一对里必须恰好一只是标注过的演示个体（实际 ${extras.length}）`);
  }
  // 跨物种的两个个体必须被拒 —— ⚠ 前两只现在是**同种**（那一对），所以这里显式挑不同物种的两只
  const first = OWNED.instances[0];
  const second = OWNED.instances.find((i) => i.species_id !== first.species_id);
  const {status, json} = await box(`compare=${first.instance_id},${second.instance_id}`);
  assert.equal(status, 400, '不同物种不许比较，实际给了 ' + status);
  assert.ok(String(json.error ?? '').length > 0, '拒绝要写清原因');
  log('[实际] 产物内同种组 =', pairs.length, '| 跨物种 compare →', status, json.error);
});

test('路由契约：不同种比较必须 400 + 原因（判据与浏览器验收同一份）', async () => {
  const groups = new Map();
  for (const instance of OWNED.instances) {
    groups.set(instance.species_id, [...(groups.get(instance.species_id) ?? []), instance.instance_id]);
  }
  const species = [...groups.entries()].filter(([, list]) => list.length >= 1);
  const a = species[0][1][0];
  const b = species[1][1][0];
  const {status, json, raw} = await box(`compare=${a},${b}`);
  const problems = compareMismatchProblems(json, status);
  log('[实际]', `compare=${a},${b}`, '→ HTTP', status, raw.slice(0, 200));
  assert.deepEqual(problems, [], `不同种比较的判据没通过：${problems.join(' | ')}`);
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.ok(json.error.includes('同一种'), `原因要点明「不是同一种」：${show(json.error)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 参数白名单：非法参数一律 fail closed
// ─────────────────────────────────────────────────────────────────────────

test('参数白名单：非法参数 ok:false + 400，不静默取整、不静默忽略', async () => {
  const cases = [
    ['limit=1e3', 'limit'],
    ['limit=1.5', 'limit'],
    ['limit=-1', 'limit'],
    ['limit=abc', 'limit'],
    ['limit=0', 'limit'],
    ['limit=61', 'limit'],
    ['offset=-1', 'offset'],
    ['offset=1e3', 'offset'],
    ['kind=catalog&favourite=yes', 'favourite'],
    ['kind=catalog&type=不存在系', 'type'],
    ['kind=catalog&role=boss', 'role'],
    ['kind=catalog&support=NOT_A_LEVEL', 'support'],
    ['kind=catalog&record_kind=pet', 'record_kind'],
    ['kind=catalog&zzz=1', 'zzz'],
    ['kind=catalog&species_id=abc', 'species_id'],
    ['q=' + 'x'.repeat(41), 'q'],
    ['', 'kind'],
    ['kind=catalog&detail=pet_000001', 'kind'],
    ['compare=own-0001', 'compare'],
    ['compare=own-0001,own-0002,own-0003', 'compare'],
  ];
  const rows = [];
  for (const [query, needle] of cases) {
    const {status, json, raw} = await box(query);
    rows.push(`${query || '(空)'} → ${status} ${raw.slice(0, 90)}`);
    assert.equal(status, 400, `「${query}」应当 400，实际 ${status}：${show(json)}`);
    assert.equal(json.ok, false, `「${query}」应当 ok:false，实际 ${show(json)}`);
    assert.equal(typeof json.error, 'string', `「${query}」必须给出 error 原因`);
    assert.ok(json.error.includes(needle), `「${query}」的错误必须点名 ${needle}：${show(json.error)}`);
  }
  log('[实际] ' + rows.length + ' 个非法参数全部 fail closed：');
  for (const row of rows) log('   ', row);
  // 反证方向：把「静默取整」的样本过同一条判据，必须报错
  const rounded = limitProblems('1e3', {ok: true, player: {limit: 1}}, 200);
  assert.notEqual(rounded.length, 0, '静默取整的样本必须被抓住');
  log('[反证实际输出]', JSON.stringify(rounded));
});

test('参数白名单：合法参数的边界值必须真的被接受（否则「拒绝」可能只是坏掉了）', async () => {
  const cases = [
    ['kind=catalog&limit=1', 200],
    ['kind=catalog&limit=60', 200],
    ['kind=catalog&offset=618', 200],
    ['kind=mine&favourite=false&locked=false', 200],
    ['kind=mine&q=' + encodeURIComponent('铠甲虫'), 200],
    ['kind=catalog&record_kind=pet_form', 200],
    ['kind=catalog&type=' + encodeURIComponent('草系'), 200],
    ['kind=catalog&role=attacker', 200],
    ['kind=catalog&support=KNOWLEDGE_ONLY', 200],
  ];
  for (const [query, expect] of cases) {
    const {status, json} = await box(query);
    assert.equal(status, expect, `「${query}」应当 ${expect}，实际 ${status}：${show(json)}`);
    assert.equal(json.ok, true, `「${query}」应当 ok:true：${show(json)}`);
  }
  // 边界之外的那一侧必须是错的（`limit=61` 与 `limit=60` 只差一格，却必须两种结果）
  assert.equal((await box('kind=catalog&limit=60')).status, 200);
  assert.equal((await box('kind=catalog&limit=61')).status, 400);
  const forms = await box('kind=catalog&record_kind=pet_form&limit=1');
  log('[实际] pet_form 总数 =', forms.json.player.total, '；示例 =', forms.json.player.cards[0].name);
  assert.equal(forms.json.player.total, PACK_PETS.filter((e) => e.record_kind === 'pet_form').length,
    'record_kind 筛选必须与 pack 的形态条数一致');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 玩家层：工程字段只许进 dev
// ─────────────────────────────────────────────────────────────────────────

/**
 * 源码层面的禁词表：只认**键名/枚举名**，不认 `[{}]` 与 `"x":` 那两条
 * ——那两条是给「玩家读到的文本」用的，源码里到处是花括号，照搬会满屏误报。
 */
const FORBIDDEN_CODE = /pet_id|species_id|instance_id|state_version|coverage|provenance|source_scope|unknown_fields|licence|pack_id|ruleset_id|digest|build_hash|dataset_hash/;

/**
 * 去掉注释，只留代码。
 *
 * 为什么必须去：工程词在**注释里**说明「这些只放抽屉」是好事，不是泄漏
 * （仓库里同形状的教训写在 structure-contract.test.js 的 `stripCommentsAndStrings` 上）。
 * 反过来，**字符串**一个都不剥：玩家看到的字就在字符串里，剥了这条判据就空了。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1');
}

/** 页面源码里的工程词只许出现在渲染开发者抽屉的那个函数里。 */
function pageCopyProblems(source, html) {
  const problems = [];
  // ① box.js：把 `renderDev()` 这一段切掉，剩下的**代码**（注释不算）里不许有工程词
  const code = stripComments(source);
  const start = code.indexOf('function renderDev(');
  const next = start < 0 ? -1 : code.indexOf('\nfunction ', start + 10);
  const end = next < 0 ? code.length : next;
  if (start < 0) problems.push('box.js 里找不到 renderDev，判据会失效');
  else {
    const outside = code.slice(0, start) + code.slice(end);
    const hit = outside.match(FORBIDDEN_CODE);
    if (hit) problems.push(`box.js 的玩家区代码里出现工程词「${hit[0]}」`);
    const inside = code.slice(start, end).match(FORBIDDEN_CODE);
    if (!inside) problems.push('开发者抽屉的渲染函数里反而没有工程词——那它就不是工程抽屉了');
  }
  // ② box.html：把默认收起的 `<details class="dev" …>` 整块切掉，剩下的玩家标记里不许有工程词
  const devStart = html.indexOf('<details class="dev"');
  const devEnd = html.indexOf('</details>', devStart);
  // ⚠ 2026-09-29 **改钉**（第三轮纠偏第 5 条：用户要求删掉页头那个「关于这一页（来源与快照）」抽屉）。
  //   抽屉不在了 ⇒ **判据不许放宽**：整份 box.html（去掉注释）都必须是干净的玩家标记。
  //   旧分支留档（改钉不删）：找不到抽屉就报 `box.html 里找不到开发者抽屉，玩家层判据没有排除对象`。
  if (devStart < 0 || devEnd < 0) {
    const hitAll = stripComments(html).match(FORBIDDEN_CODE);
    if (hitAll) problems.push(`box.html 的玩家标记里出现工程词「${hitAll[0]}」`);
  } else {
    const playerHtml = stripComments(html.slice(0, devStart) + html.slice(devEnd + '</details>'.length));
    const hit = playerHtml.match(FORBIDDEN_CODE);
    if (hit) problems.push(`box.html 的玩家标记里出现工程词「${hit[0]}」`);
  }
  return problems;
}

test('玩家层：路由的 player 段没有工程键，页面源码的工程词只在开发者抽屉里', async () => {
  const responses = [
    await box('kind=catalog&limit=24'),
    await box('kind=mine&limit=24'),
    await box('detail=pet_000062'),
    await box('detail=own-0001'),
    // 2026-09-24：产物改成「一人一只」（人类要求删掉重复个体）→ 产物里不再有同种两只，
    // 所以这一轮**不再拿它当成功样本**（跨物种比较应当是 400，见下面那条专门的判据）。
  ];
  for (const {json} of responses) {
    const problems = playerLayerProblems(json.player);
    assert.deepEqual(problems, [], `player 段漏了工程字段（${json.mode}）：${problems.join(' | ')}`);
    assert.ok(json.dev && json.dev.state_version, '工程层必须有 dev 段与 state_version');
    assert.ok(json.dev.coverage, '工程层必须有 coverage');
  }
  const devText = JSON.stringify(responses.map((r) => r.json.dev));
  for (const word of ['state_version', 'coverage', 'provenance', 'unknown_fields', 'source_scope', 'licence']) {
    assert.ok(devText.includes(word), `dev 段里应当能看到 ${word}（工程信息只在这里出现）`);
  }
  log('[实际] dev 段含 state_version/coverage/provenance/unknown_fields/source_scope/licence；'
    + `player 段扫过 ${JSON.stringify(responses.map((r) => r.json.player)).length} 字节无命中`);

  // ⚠ 2026-09-29（第三轮纠偏第 5 条改钉之后**补的反证**）：抽屉从页面上删掉了，
  //   `pageCopyProblems` 里那条分支改成"整份 box.html（去注释）都不许有工程词"。
  //   反证必须走**同一只探测器**（`pageCopyProblems`），不能另写一份正则：
  //   ① 喂一份**带工程词的假 html**（没抽屉）⇒ 必须报红；
  //   ② 喂一份**只有注释里带工程词**的假 html ⇒ 不许误报。
  const badHtml = pageCopyProblems('function renderDev(){ coverage }',
    '<!doctype html><html><body><div id="box-grid">pet_id</div></body></html>');
  assert.ok(badHtml.some((one) => one.includes('pet_id')),
    `反证：没有抽屉时，html 里的工程词必须被同一条判据抓住（实际：${JSON.stringify(badHtml)}）`);
  // 正例：**JS 注释**里的工程词不算泄漏（`stripComments` 会剥掉；仓库既有口径）。
  // ⚠ 注意 HTML 注释**不**算"注释"（它会随页面下发，判据当它是玩家可见文本）——
  //   所以这里不拿 `<!-- pet_id -->` 当正例，那是**故意**被抓的。
  const commentOnly = pageCopyProblems('// coverage 只写在注释里\nfunction renderDev(){ coverage }',
    '<!doctype html><html><body><div id="box-grid">喵喵</div></body></html>');
  assert.deepEqual(commentOnly, [], `正例：JS 注释里的工程词不算泄漏（实际：${JSON.stringify(commentOnly)}）`);
  const badSource = pageCopyProblems(
    'function toggleDrawer(){}\nconst playerLine = "coverage:" + 1;\nfunction renderDev(){ coverage }',
    '<!doctype html><html><body><div id="box-grid">喵喵</div></body></html>');
  assert.ok(badSource.some((one) => one.includes('玩家区代码')),
    `反证：box.js 玩家区代码里出现工程词必须被抓（实际：${JSON.stringify(badSource)}）`);

  const problems = pageCopyProblems(
    readFileSync(join(ROOT, 'src/client/box.js'), 'utf8'),
    readFileSync(join(ROOT, 'src/client/box.html'), 'utf8'));
  log('[实际] 页面源码判据 =', problems.length ? problems.join(' | ') : '（干净）');
  assert.deepEqual(problems, [], `页面源码的玩家区出现工程话：${problems.join(' | ')}`);
});

test('玩家层：玩家可见文案里不出现工程话与伪精确数值（对实际回执的断言）', async () => {
  const rich = await box('detail=pet_000062');
  const plain = await box('detail=pet_000001');
  // 同种比较的成功路径：用**显式夹具**（产物里已经没有同种两只了，见文件末尾那条判据）
  const compare = {json: {player: compareFixturePlayer()}};
  const texts = [
    rich.json.player.moveset_note,
    rich.json.player.panel.reason,
    rich.json.player.effect_note,
    plain.json.player.metrics_missing_reason,
    plain.json.player.moveset_note,
    compare.json.player.summary,
    ...compare.json.player.fields.map((f) => f.reason).filter(Boolean),
  ];
  for (const text of texts) {
    const hit = String(text).match(FORBIDDEN_PLAYER);
    assert.equal(hit, null, `玩家可见文案里出现工程话「${hit?.[0]}」：${show(text)}`);
  }
  // 未知的三条原因必须说清「哪一侧没有登记」与「养成效果未校准」
  const unknownReasons = compare.json.player.fields.filter((f) => f.status === 'unknown').map((f) => f.reason);
  assert.ok(unknownReasons.length >= 3, '这两个个体的比较里应当至少有 3 栏未知');
  for (const reason of unknownReasons) {
    assert.ok(reason.includes('没有登记'), `未知原因要说清没有登记：${show(reason)}`);
    assert.ok(reason.includes('效果未校准'), `未知原因要带上「效果未校准」：${show(reason)}`);
  }
  // 没给威力的技能必须写「本仓库没有这一项」，不许补 0
  const noPower = rich.json.player.moveset.filter((m) => m.power_label === '游戏数据里没有这一项');
  assert.ok(noPower.length >= 1, '迁移层里确实有没给威力的技能，它们不许被补成 0');
  log('[实际] 玩家文案判据：', texts.length, '段文案无命中；未知原因样例「', unknownReasons[0], '」');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 必红反证：每条判据都要能抓住违规样本（六条，报告里贴实际输出原文）
// ─────────────────────────────────────────────────────────────────────────

test('反证：六条判据都抓得住违规样本（实际输出原文见日志）', () => {
  const proofs = [];
  const record = (name, problems, sample) => {
    proofs.push({name, problems, sample});
    log(`[反证实际输出] ${name} →`, JSON.stringify(problems));
    assert.ok(problems.length > 0, `${name}：判据没有抓住违规样本（判据是空的）`);
  };

  // ① 把 pet_id 放进玩家可见 payload
  record('pet_id 混进玩家层卡片', playerLayerProblems({
    cards: [{select: 'own-0001', group: 'pet_000012', name: '铠甲虫', pet_id: 'pet_000012'}],
  }), '{cards:[{name,pet_id}]}');

  // ② unknown_fields 混进玩家字段
  record('unknown_fields 混进玩家层', playerLayerProblems({
    cards: [{select: 'own-0001', name: '铠甲虫', unknown_fields: ['panel_stats']}],
  }), '{cards:[{unknown_fields:["panel_stats"]}]}');

  // ③ compare 接受不同种
  record('compare 接受不同种', compareMismatchProblems({ok: true, player: {fields: []}}, 200),
    '{ok:true,player:{fields:[]}} / HTTP 200');

  // ④ 非法 limit 被静默取整
  record('非法 limit 静默取整', limitProblems('1e3', {ok: true, player: {limit: 1}}, 200),
    '{ok:true,player:{limit:1}} / HTTP 200');

  // ⑤ 把 48 只当成 catalog 全量
  record('catalog 总数写成 48', catalogTotalProblems({ok: true, player: {total: 48}}),
    '{ok:true,player:{total:48}}');

  // ⑥ 页面源码的工程话跑到玩家区（判据 4 的反证）
  record('工程话跑出开发者抽屉', pageCopyProblems(
    '// provenance / coverage 都只放抽屉\n'
    + 'function renderCards(){return "provenance=" + JSON.stringify(state.lastDev);}\n'
    + 'function renderDev(){return "state_version=rc205.1 / coverage / unknown_fields";}\n'
    + 'function boot(){void 0;}\n',
    '<main><details class="dev"><summary>关于</summary><div id="dev-body"></div></details>'
    + '<p>provenance</p></main>'), '假 box.js：把 provenance 写在卡片渲染里');

  assert.equal(proofs.length, 6);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 2026-09-24：产物改成「一人一只」之后，同种比较怎么继续被测
// ─────────────────────────────────────────────────────────────────────────

/** 用**显式夹具**造一份「同种两只」的比较回执（人类要求删掉产物里的重复个体，
 *  但「同种比较」这个能力还在：`compareOwnedPets()` 是纯函数，能力由它保证）。
 *
 *  形状对齐**路由**那一侧：`fields` 是数组（每条带 field/status/status_label/reason），
 *  因为这里替的是 `/api/roco/box?compare=` 的 player 段。 */
function compareFixturePlayer() {
  const LABEL = {level: '等级', nature: '性格', talent: '资质', specialty: '特长', bloodline: '血脉',
    skills: '四个技能（按顺序）', favourite: '收藏', locked: '锁定'};
  const LABEL_CN = {same: '相同', different: '不同', unknown: '未知'};
  const base = OWNED.instances.find((i) => i.species_id === 'pet_000012') ?? OWNED.instances[0];
  const a = {...base, instance_id: 'own-fixture-a', level: 70};
  const b = {...base, instance_id: 'own-fixture-b', level: 60};
  const direct = compareOwnedPets(a, b);
  const fields = Object.entries(direct.fields).map(([field, row]) => ({
    field, label: LABEL[field] ?? field, status: row.status,
    status_label: LABEL_CN[row.status] ?? row.status,
    a: row.a, b: row.b,
    reason: row.status === 'unknown'
      ? '这一项在冻结目录里没有登记；养成效果未校准（见 10 号文档 §13）' : null,
  }));
  return {
    summary: `${base.species_name}：逐字段比较（同一物种的两个个体）`,
    fields,
    counts: {
      same: fields.filter((f) => f.status === 'same').length,
      different: fields.filter((f) => f.status === 'different').length,
      unknown: fields.filter((f) => f.status === 'unknown').length,
    },
  };
}

test('同种比较（夹具）：纯函数按字段给出差异，未知项说清「没有登记 / 效果未校准」', () => {
  const player = compareFixturePlayer();
  assert.ok(player.fields.length >= 5, '比较至少要给出 5 栏字段');
  const unknown = player.fields.filter((f) => f.status === 'unknown');
  assert.ok(unknown.length >= 3, '这四个养成属性都未核验 → 至少 3 栏 unknown');
  for (const row of unknown) {
    assert.match(String(row.reason ?? ''), /没有登记|效果未校准/, `未知原因要可核对：${row.reason}`);
  }
  log('[实际] 夹具比较：字段', player.fields.length, '| unknown', unknown.length);
});

test('跨物种比较必须被拒（产物里已经没有同种两只，跨物种更要 fail closed）', async () => {
  const mismatched = await box('compare=own-0001,own-0002');
  assert.equal(mismatched.status, 400, '两个不同物种的个体不许比较，必须是 400');
  assert.ok(String(mismatched.json.error).length > 0, '拒绝要写清原因');
  log('[实际] 跨物种比较 →', mismatched.status, mismatched.json.error);
});

/**
 * 同名形态必须**看得出区别**（人类 2026-09-25 逐字：「这个什么陛下有啥区别？我根本看不出来啊」）。
 *
 * 2026-09-28 查到真因（不是判据写得不对，是产品真缺一块）：全量图鉴里「同名 + 同编号 +
 * 只有形态名不同」的登记有 **55 组 / 154 条**（例：`pet_000271` = 「千棘盔」、
 * `pet_000378` = 「千棘盔（磨损的样子）」，同名同属性同编号 078）。
 * 目录页那张卡一直是形态名优先（`name: e.title ?? e.name`），
 * 只有**「我的盒子」**那张卡漏了（原来写 `name: i.species_name ?? e?.name`，只取物种名）
 * ⇒ 盒子里两行**逐字相同**，玩家分不出是哪一只。
 *
 * 判据：mine 卡的名字要取形态名；形态名与物种本名不同时，`alias` 里要留着本名。
 * 反证：拿同一张卡把 `title` 抹掉 ⇒ 两行名字必然相同（说明判据量的正是这个字段）。
 */
test('同名形态分得出来：mine 卡要用形态名（缺了就会两行逐字相同）', async () => {
  const mine = await box('kind=mine&q=' + encodeURIComponent('千棘盔') + '&limit=10&offset=0');
  assert.equal(mine.status, 200, '这个查询要能通');
  const cards = mine.json.player.cards;
  assert.ok(cards.length >= 2, `「千棘盔」在图鉴里至少两条登记（实际 ${cards.length}）`);
  const names = cards.map((c) => String(c.name));
  assert.equal(new Set(names).size, names.length, `同名的两条必须看得出区别，实际都是：${JSON.stringify(names)}`);
  const withForm = cards.find((c) => String(c.name).includes('形态') || String(c.name).includes('（'));
  assert.ok(withForm, `至少要有一条带形态名：${JSON.stringify(names)}`);
  assert.equal(withForm.alias, '千棘盔', `形态名之外要把物种本名留在 alias 里（实际 ${JSON.stringify(withForm.alias)}）`);
  // 反证：把形态名抹掉 ⇒ 两条名字必然相同（这条判据真的在量这个字段）
  const stripped = cards.map((c) => String(c.alias ?? c.name));
  assert.ok(new Set(stripped).size < stripped.length,
    `反证要真的成立：抹掉形态名之后两条应当撞名，实际 ${JSON.stringify(stripped)}`);
  log('[实际] 同名形态：', JSON.stringify(names), '| alias', JSON.stringify(cards.map((c) => c.alias)));
});
