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
  assert.equal(json.dev.coverage.with_moveset_layer, 48,
    '48 只能是「迁移层配过招的条数」，它不该等于全量');
  assert.equal(json.dev.coverage.pet_record + json.dev.coverage.pet_form, 622,
    '精灵 460 + 形态 162 应当正好是 622');
  // 卡片首层只有玩家该看到的那几样（`mechanism` 是 2026-09-22 人类 P0 之后加的**加性**键：
  // 卡片首层的「机制」必须是可核对原文，不是前端模板句；它只带 line/status/name/tags，
  // 出处原文与 unverified[] 留在详情层）。
  const card = json.player.cards[0];
  assert.deepEqual(Object.keys(card).sort(),
    ['alias', 'form_label', 'has_metrics', 'has_moveset', 'mechanism', 'name', 'role_label', 'select', 'support_label', 'types'].sort(),
    `卡片首层的键变了：${show(Object.keys(card))}`);
  assert.deepEqual(Object.keys(card.mechanism).sort(), ['line', 'name', 'status', 'tags'].sort(),
    `机制字段只允许这四个玩家键：${show(Object.keys(card.mechanism))}`);
  assert.equal(card.mechanism.status, 'FROZEN_DESC', '全图鉴 622 只都该解析到冻结 desc');
  assert.ok(card.mechanism.line.length <= 60 && card.mechanism.line.includes('「'),
    `机制行该是「特性「X」：…」的样子，实际 ${show(card.mechanism.line)}`);
});

test('路由契约：kind=mine 是 80 个个体，分页加起来还是 80', async () => {
  const {status, json} = await box('kind=mine&limit=24&offset=0');
  assert.equal(status, 200);
  assert.equal(json.mode, 'mine');
  assert.equal(json.player.total, OWNED.instances.length, 'mine 总数必须等于 owned-pets.json 的实例数');
  assert.equal(json.player.total, 80, `我的盒子必须是 80 个个体，实际 ${json.player.total}`);
  // 逐页取回来，条数之和必须等于总数（分页不是装饰）
  let seen = 0;
  for (let offset = 0; offset < 200; offset += 24) {
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

  // 不在 48 只迁移层里的：必须说「本仓库没有这一项」，而且没有任何数字
  const plain = await box('detail=pet_000001');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.player.metrics, null, '没有迁移层登记时不许给数值');
  assert.equal(plain.json.player.moveset, null, '没有配招时不许编一个');
  assert.ok(plain.json.player.metrics_missing_reason.includes('本仓库没有这一项'),
    `必须如实说没有：${show(plain.json.player.metrics_missing_reason)}`);
  log('[实际] pet_000001 =', plain.json.player.name, '；', plain.json.player.metrics_missing_reason);

  // 个体详情：等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能
  const instance = await box('detail=own-0001');
  assert.equal(instance.status, 200);
  assert.equal(instance.json.player.entity, 'instance');
  assert.equal(instance.json.player.traits.length, 4, '四项个体属性一栏都不能少');
  assert.deepEqual(instance.json.player.traits.map((t) => t.label), ['性格', '资质', '特长', '血脉']);
  assert.equal(instance.json.player.skills.length, 4, '四个技能是有序的四个');
  assert.deepEqual(instance.json.player.skills.map((s) => s.order), [1, 2, 3, 4], '技能顺序必须写出来');
  assert.equal(instance.json.player.panel.available, false, '面板数值在本仓库不可得');
  assert.ok(instance.json.player.panel.reason.includes('本仓库没有这一项'), show(instance.json.player.panel.reason));
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

test('路由契约：compare 只接受同种的两个个体，逐字段给相同/不同/未知', async () => {
  const groups = new Map();
  for (const instance of OWNED.instances) {
    groups.set(instance.species_id, [...(groups.get(instance.species_id) ?? []), instance.instance_id]);
  }
  const [speciesId, pair] = [...groups.entries()].find(([, list]) => list.length === 2);
  const {status, json} = await box(`compare=${pair[0]},${pair[1]}`);
  assert.equal(status, 200, `同种比较应当 200，实际 ${status}：${show(json)}`);
  assert.equal(json.mode, 'compare');
  assert.equal(json.player.fields.length, 8, '八个字段逐条比：等级/性格/资质/特长/血脉/技能/收藏/锁定');
  assert.deepEqual(json.player.fields.map((f) => f.label),
    ['等级', '性格', '资质', '特长', '血脉', '四个技能（按顺序）', '收藏', '锁定']);
  for (const field of json.player.fields) {
    assert.ok(['same', 'different', 'unknown'].includes(field.status), `状态只能是三种之一：${show(field)}`);
    assert.ok(['相同', '不同', '未知'].includes(field.status_label), show(field.status_label));
    if (field.status === 'unknown') {
      assert.ok(typeof field.reason === 'string' && field.reason.length > 8,
        `未知必须说清为什么：${show(field)}`);
    }
    if (field.status === 'different' && field.field === 'level') {
      assert.notEqual(field.a, field.b, '等级不同时两侧的值必须不一样');
    }
  }
  assert.equal(json.player.counts.same + json.player.counts.different + json.player.counts.unknown, 8);
  // 与 RC-203 的纯函数对齐：路由不许自己另判一套
  const a = OWNED.instances.find((i) => i.instance_id === pair[0]);
  const b = OWNED.instances.find((i) => i.instance_id === pair[1]);
  const direct = compareOwnedPets(a, b);
  assert.deepEqual(json.player.fields.map((f) => [f.field, f.status]),
    Object.entries(direct.fields).map(([field, row]) => [field, row.status]),
    '路由的逐字段状态必须与 compareOwnedPets 完全一致');
  log('[实际] compare', pair.join(' / '), '（', speciesId, '）=',
    json.player.fields.map((f) => `${f.label}:${f.status_label}`).join(' | '),
    '；', json.player.summary);
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
  if (devStart < 0 || devEnd < 0) problems.push('box.html 里找不到开发者抽屉，玩家层判据没有排除对象');
  else {
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
    await box('compare=own-0001,own-0002'),
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

  const problems = pageCopyProblems(
    readFileSync(join(ROOT, 'src/client/box.js'), 'utf8'),
    readFileSync(join(ROOT, 'src/client/box.html'), 'utf8'));
  log('[实际] 页面源码判据 =', problems.length ? problems.join(' | ') : '（干净）');
  assert.deepEqual(problems, [], `页面源码的玩家区出现工程话：${problems.join(' | ')}`);
});

test('玩家层：玩家可见文案里不出现工程话与伪精确数值（对实际回执的断言）', async () => {
  const rich = await box('detail=pet_000062');
  const plain = await box('detail=pet_000001');
  const compare = await box('compare=own-0001,own-0002');
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
  const noPower = rich.json.player.moveset.filter((m) => m.power_label === '本仓库没有这一项');
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
